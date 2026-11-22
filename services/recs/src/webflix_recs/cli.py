"""`webflix-recs`: the offline recommendation pipeline's command line (README.md, Commands).

Every command reads and writes through one store (`--store`: a directory in the filesystem
BlobStore layout, or `s3://bucket/prefix` with `WEBFLIX_S3_*` configuration), logs progress on
stderr and prints a JSON summary of what it did on stdout.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

import orjson

from webflix_recs.ids import iso_ms, parse_iso_ms

#: Exit codes (README.md, "Jobs"). 1 is an unexpected failure, 2 a usage error (argparse).
EXIT_PUBLISH_REFUSED = 3
EXIT_INVALID_VERSION = 4
EXIT_ERASURE_INCOMPLETE = 5
EXIT_STAFF_API = 6
EXIT_RULE_ENGINE_UNAVAILABLE = 7
EXIT_EXPORT_FAILED = 8
EXIT_LAKE_BUSY = 75

DEFAULT_STORE = os.environ.get("WEBFLIX_RECS_STORE", ".cache/recs/store")


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _emit(summary: dict[str, Any]) -> None:
    sys.stdout.write(orjson.dumps(summary, option=orjson.OPT_INDENT_2).decode() + "\n")


def _peak_rss_mb() -> float:
    """Peak resident memory of this process and of its finished worker processes, in MB."""
    import resource  # noqa: PLC0415

    scale = 1 if sys.platform == "darwin" else 1024  # bytes on macOS, KiB on Linux
    own = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale
    children = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * scale
    return round(max(own, children) / 2**20, 1)


def _workers(value: int | None) -> int:
    return value if value else max(1, min(12, (os.cpu_count() or 2) - 2))


def _instant(text: str | None, default: int | None = None) -> int:
    if text is None:
        if default is None:
            raise SystemExit("an instant is required")
        return default
    return parse_iso_ms(text)


# --- commands -----------------------------------------------------------------------------------


def cmd_simulate(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.catalog import load_catalog  # noqa: PLC0415
    from webflix_recs.simulate.config import ExperimentSpec, preset  # noqa: PLC0415
    from webflix_recs.simulate.run import run_simulation  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415

    config = preset(
        args.preset,
        seed=args.seed,
        accounts=args.accounts,
        days=args.days,
        start=iso_ms(parse_iso_ms(args.start)) if args.start else None,
        impression_sample_rate=args.impression_sample_rate,
        object_layout=args.object_layout,
        experiments=tuple(ExperimentSpec.parse(text) for text in args.experiment)
        if args.experiment
        else None,
    )
    storage = open_storage(args.store)
    catalog = load_catalog(storage)
    _log(
        f"simulating {config.accounts} accounts over {config.days} days from {config.start} "
        f"into {storage.describe()} (seed {config.seed})"
    )
    manifest = run_simulation(
        config, catalog, args.store, args.truth, workers=_workers(args.workers), log=_log
    )
    totals = manifest["totals"]
    return {
        "command": "simulate",
        "store": storage.describe(),
        "truth": str(Path(args.truth).resolve()),
        "accounts": config.accounts,
        "profiles": totals.get("profiles"),
        "sessions": totals.get("sessions"),
        "plays": totals.get("plays"),
        "eventLines": totals.get("lines"),
        "lakeObjects": totals.get("objects"),
        "lakeBytes": totals.get("bytes"),
        "window": [manifest["start"], manifest["end"]],
        "seconds": manifest["seconds"],
        "workers": manifest["workers"],
        "maxWorkerRssMb": max((s["max_rss_mb"] for s in manifest["shardStats"]), default=None),
    }


def cmd_compact(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.lake import compact  # noqa: PLC0415
    from webflix_recs.lease import lake_lease  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415

    started = time.perf_counter()
    with lake_lease(open_storage(args.store), "compact"):
        result = compact(
            args.store,
            now_ms=_instant(args.now, int(time.time() * 1000)),
            grace_ms=args.grace_minutes * 60_000,
            delete_sources=args.delete_sources,
            workers=_workers(args.workers),
            take_lease=False,
        )
        summary: dict[str, Any] = {"command": "compact", **result.to_dict()}
        if args.erase:
            # Kept for the operator routes' wording (`compact --erase FILE`): the same operation
            # as `erase --keys FILE --confirm-out -`, under the same lease.
            summary["erase"] = _run_erase(args, keys_source=args.erase, confirm="-", lease=False)
    summary["seconds"] = round(time.perf_counter() - started, 2)
    return summary


def _run_erase(
    args: argparse.Namespace, *, keys_source: str, confirm: str, lease: bool
) -> dict[str, Any]:
    from webflix_recs.admin_api import AdminApi  # noqa: PLC0415
    from webflix_recs.erasure import erase, mark_confirmed, parse_keys  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415

    now = _instant(getattr(args, "now", None), int(time.time() * 1000))
    api = AdminApi.from_environment() if "api" in {keys_source, confirm} else None
    more_pending = False
    if keys_source == "api":
        assert api is not None
        keys = api.pending_erasures()
        more_pending = len(keys) >= 500
    else:
        keys = parse_keys(Path(keys_source).read_text() if keys_source != "-" else sys.stdin.read())
    outcome = erase(
        args.store,
        keys,
        now_ms=now,
        watch_days=getattr(args, "watch_days", 30),
        workers=_workers(args.workers),
        take_lease=lease,
        log=_log,
    )
    summary: dict[str, Any] = {**outcome.to_dict(), "morePending": more_pending}
    to_confirm = outcome.to_confirm
    if not to_confirm:
        return summary
    reason = getattr(args, "reason", None) or (
        f"webflix-recs erase {iso_ms(now)}: removed from the lake, compacted hours, datasets "
        "and artefacts, and verified"
    )
    bodies = [
        {"subjectKeys": to_confirm[start : start + 200], "reason": reason}
        for start in range(0, len(to_confirm), 200)
    ]
    if confirm == "api":
        assert api is not None
        api.confirm_erasures(to_confirm, reason)
        mark_confirmed(open_storage(args.store), to_confirm, now)
        summary["confirmed"] = len(to_confirm)
    elif confirm == "none":
        summary["confirmBodies"] = bodies
    else:
        # The request bodies for POST /api/admin/v1/system/privacy/erasures/confirm, for an
        # operator to send; the keys count as confirmed in the plan once they are written.
        text = orjson.dumps(bodies if len(bodies) > 1 else bodies[0], option=orjson.OPT_INDENT_2)
        if confirm == "-":
            summary["confirmBodies"] = bodies
        else:
            Path(confirm).parent.mkdir(parents=True, exist_ok=True)
            Path(confirm).write_bytes(text + b"\n")
            summary["confirmFile"] = str(Path(confirm).resolve())
        mark_confirmed(open_storage(args.store), to_confirm, now)
    return summary


def cmd_erase(args: argparse.Namespace) -> dict[str, Any]:
    keys_source = args.keys or ("api" if os.environ.get("WEBFLIX_ADMIN_API_URL") else None)
    if keys_source is None:
        raise SystemExit("erase: give --keys FILE|api (or set WEBFLIX_ADMIN_API_URL)")
    confirm = args.confirm or ("api" if keys_source == "api" else "-")
    started = time.perf_counter()
    summary = _run_erase(args, keys_source=keys_source, confirm=confirm, lease=True)
    return {"command": "erase", **summary, "seconds": round(time.perf_counter() - started, 2)}


def cmd_export_events(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.erasure import parse_keys  # noqa: PLC0415
    from webflix_recs.exports import export_events, parse_requests  # noqa: PLC0415

    text = sys.stdin.read() if args.requests == "-" else Path(args.requests).read_text()
    requests = parse_requests(orjson.loads(text))
    erased: list[str] = []
    if args.erasures == "api":
        from webflix_recs.admin_api import AdminApi  # noqa: PLC0415

        erased = AdminApi.from_environment().pending_erasures()
    elif args.erasures:
        erased = parse_keys(Path(args.erasures).read_text())
    now = _instant(args.now, int(time.time() * 1000))
    outcome = export_events(
        args.store,
        requests,
        erased=erased,
        now_ms=now,
        grace_ms=args.grace_minutes * 60_000,
        keep_days=args.keep_days,
        force=args.force,
        workers=_workers(args.workers),
        log=_log,
    )
    document = outcome.document(now)
    if args.results and args.results != "-":
        Path(args.results).parent.mkdir(parents=True, exist_ok=True)
        Path(args.results).write_bytes(orjson.dumps(document, option=orjson.OPT_INDENT_2) + b"\n")
    statuses: dict[str, int] = {}
    for result in outcome.results:
        statuses[result["status"]] = statuses.get(result["status"], 0) + 1
    summary: dict[str, Any] = {
        "command": "export-events",
        "requests": len(requests),
        "statuses": statuses,
        "hoursRead": outcome.hours,
        "objectsRead": outcome.objects_read,
        "outputsPruned": outcome.pruned,
    }
    if args.results == "-" or not args.results:
        summary["results"] = document
    else:
        summary["resultsFile"] = str(Path(args.results).resolve())
    if outcome.failed:
        _emit(summary)
        raise SystemExit(EXIT_EXPORT_FAILED)
    return summary


def cmd_build_dataset(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.dataset import build_dataset  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415

    storage = open_storage(args.store)
    as_of = _instant(args.as_of, int(time.time() * 1000))
    result = build_dataset(
        args.store,
        storage,
        dataset_id=args.dataset,
        as_of_ms=as_of,
        workers=_workers(args.workers),
        log=_log,
    )
    manifest = result.manifest
    return {
        "command": "build-dataset",
        "dataset": args.dataset,
        "asOf": manifest["asOf"],
        "rows": manifest["rows"],
        "counts": manifest["counts"],
        "seconds": manifest["seconds"],
    }


def _params(path: str | None) -> Any:
    from webflix_recs.train import TrainParams  # noqa: PLC0415

    if not path:
        return TrainParams()
    return TrainParams.from_dict(
        {**TrainParams().to_dict(), **orjson.loads(Path(path).read_bytes())}
    )


def cmd_train(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.catalog import load_catalog  # noqa: PLC0415
    from webflix_recs.dataset import load_dataset  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415
    from webflix_recs.train import save_run, train  # noqa: PLC0415

    storage = open_storage(args.store)
    catalog = load_catalog(storage)
    dataset = load_dataset(storage, args.dataset)
    as_of = _instant(args.as_of, int(dataset.manifest["asOfMs"]))
    models, report = train(catalog, dataset, as_of_ms=as_of, params=_params(args.params), log=_log)
    manifest = save_run(
        storage, models, report, dataset=dataset, catalog=catalog, as_of_ms=as_of, run_id=args.run
    )
    return {
        "command": "train",
        "run": manifest["run"],
        "recipeHash": manifest["recipeHash"],
        "asOf": manifest["data"]["asOf"],
        "dataset": args.dataset,
        "rankerExamples": report["rankerExamples"],
        "propensity": report["propensity"],
        "seconds": report["seconds"],
    }


def cmd_evaluate(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.artefacts import store_evaluation  # noqa: PLC0415
    from webflix_recs.catalog import load_catalog  # noqa: PLC0415
    from webflix_recs.dataset import load_dataset  # noqa: PLC0415
    from webflix_recs.evaluation.harness import EvaluationInputs, evaluate  # noqa: PLC0415
    from webflix_recs.evaluation.report import markdown_table  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415
    from webflix_recs.train import load_run  # noqa: PLC0415

    storage = open_storage(args.store)
    catalog = load_catalog(storage)
    dataset = load_dataset(storage, args.dataset)
    models, manifest = load_run(storage, args.run)
    externals = {}
    for item in args.external or []:
        name, _, path = item.partition("=")
        externals[name] = Path(path)
    work = Path(args.work or Path(".cache/recs/work") / f"evaluate-{args.run}")
    if args.engine_input_only:
        from webflix_recs.evaluation.harness import write_rule_engine_input  # noqa: PLC0415

        path = write_rule_engine_input(
            EvaluationInputs(
                catalog,
                dataset,
                models,
                manifest,
                horizon_days=args.horizon_days,
                max_profiles=args.max_profiles,
                seed=args.seed,
                cutoff_ms=_instant(args.cutoff) if args.cutoff else None,
            ),
            Path(args.engine_input_only),
            log=_log,
        )
        return {"command": "evaluate", "run": args.run, "engineInput": str(path.resolve())}
    report = evaluate(
        EvaluationInputs(
            catalog,
            dataset,
            models,
            manifest,
            horizon_days=args.horizon_days,
            truth_dir=Path(args.truth) if args.truth else None,
            externals=externals or None,
            bootstrap=args.bootstrap,
            seed=args.seed,
            max_profiles=args.max_profiles,
            gate_metric=args.gate_metric,
            cutoff_ms=_instant(args.cutoff) if args.cutoff else None,
        ),
        work_dir=work,
        log=_log,
    )
    key = store_evaluation(storage, report)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_bytes(orjson.dumps(report, option=orjson.OPT_INDENT_2))
    _log(markdown_table(report))
    return {
        "command": "evaluate",
        "run": args.run,
        "report": key,
        "profiles": report["profiles"],
        "gate": report["gate"],
        "seconds": report["seconds"],
    }


def cmd_score(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.artefacts import gate_summary as summary  # noqa: PLC0415
    from webflix_recs.artefacts import passing_evaluation, score  # noqa: PLC0415
    from webflix_recs.catalog import load_catalog  # noqa: PLC0415
    from webflix_recs.dataset import load_dataset  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415
    from webflix_recs.train import load_run  # noqa: PLC0415

    storage = open_storage(args.store)
    catalog = load_catalog(storage)
    models, manifest = load_run(storage, args.run)
    dataset = load_dataset(storage, args.dataset or manifest["data"]["datasetId"])
    evaluation = passing_evaluation(storage, manifest["recipeHash"])
    result = score(
        storage,
        catalog,
        dataset,
        models,
        manifest,
        evaluation=summary(evaluation) if evaluation else None,
        log=_log,
    )
    return {
        "command": "score",
        "run": result.run,
        "version": f"recs/v={result.run}/",
        "counts": result.manifest["counts"],
        "files": len(result.manifest["files"]),
    }


def cmd_publish(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.artefacts import PublishRefused, publish  # noqa: PLC0415
    from webflix_recs.jobs import latest_scored_run  # noqa: PLC0415
    from webflix_recs.storage import get_json, open_storage  # noqa: PLC0415

    storage = open_storage(args.store)
    run = args.run or latest_scored_run(storage)
    if run is None:
        raise SystemExit(
            "publish: no --run given and nothing scored (recs-work/scored/latest.json)"
        )
    current = get_json(storage, "recs/current.json")
    if isinstance(current, dict) and current.get("run") == run:
        return {"command": "publish", "status": "unchanged", "run": run}
    try:
        pointer = publish(storage, run, keep=args.keep, log=_log)
    except PublishRefused as refusal:
        _log(f"publish refused: {refusal}")
        raise SystemExit(EXIT_PUBLISH_REFUSED) from refusal
    return {"command": "publish", "status": "published", "pointer": "recs/current.json", **pointer}


def cmd_validate(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.artefacts import read_current, validate_version  # noqa: PLC0415
    from webflix_recs.storage import open_storage  # noqa: PLC0415

    storage = open_storage(args.store)
    run = args.run
    if run is None:
        current = read_current(storage)
        if current is None:
            raise SystemExit("nothing published yet (recs/current.json missing)")
        run = current[0]["run"]
    problems = validate_version(storage, run)
    if problems:
        for problem in problems:
            _log(f"invalid: {problem}")
        raise SystemExit(EXIT_INVALID_VERSION)
    return {"command": "validate", "run": run, "valid": True}


def cmd_analyse_experiments(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.experiments.analysis import run_analysis  # noqa: PLC0415
    from webflix_recs.experiments.results import write_results  # noqa: PLC0415
    from webflix_recs.jobs import closed_as_of  # noqa: PLC0415
    from webflix_recs.storage import get_json, open_storage  # noqa: PLC0415

    storage = open_storage(args.store)
    source = args.definitions
    definitions: Any
    if source == "api":
        from webflix_recs.admin_api import AdminApi  # noqa: PLC0415

        definitions = {"items": AdminApi.from_environment().list_experiments()}
    elif source:
        definitions = orjson.loads(Path(source).read_bytes())
    else:
        from webflix_recs.simulate.run import DEFINITIONS_KEY  # noqa: PLC0415

        definitions = get_json(storage, DEFINITIONS_KEY)
        if definitions is None:
            raise SystemExit(
                f"no --definitions given and no {DEFINITIONS_KEY} in the store "
                "(use --definitions api to read them from the staff API)"
            )
    as_of = _instant(args.as_of) if args.as_of else closed_as_of(int(time.time() * 1000))
    report = run_analysis(
        args.store, definitions, as_of_ms=as_of, workers=_workers(args.workers), log=_log
    )
    summary: dict[str, Any] = {
        "command": "analyse-experiments",
        "asOf": report["asOf"],
        "experiments": [e.get("key") for e in report.get("experiments", [])],
        "skipped": report.get("definitionsSkipped", []),
    }
    if not args.no_store:
        pointer = write_results(storage, report)
        summary["results"] = "experiments/results/current.json"
        summary["run"] = pointer["run"]
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(orjson.dumps(report, option=orjson.OPT_INDENT_2))
        summary["report"] = str(out.resolve())
    return summary


def cmd_train_and_score(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.jobs import AlreadyScored, closed_as_of, train_and_score  # noqa: PLC0415

    as_of = (
        _instant(args.as_of)
        if args.as_of
        else closed_as_of(int(time.time() * 1000), args.grace_minutes * 60_000)
    )
    try:
        summary = train_and_score(
            args.store,
            as_of_ms=as_of,
            phase=args.phase,
            work=Path(args.work),
            truth_dir=Path(args.truth) if args.truth else None,
            params_path=args.params,
            keep_datasets=args.keep_datasets,
            bootstrap=args.bootstrap,
            workers=_workers(args.workers),
            log=_log,
        )
    except AlreadyScored as done:
        _log(str(done))
        return {"command": "train-and-score", "status": "already-scored", "asOf": iso_ms(as_of)}
    return {"command": "train-and-score", "status": "done", **summary}


# --- parser -------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="webflix-recs",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    root.add_argument(
        "--store",
        default=DEFAULT_STORE,
        help="blob store: a directory (filesystem BlobStore layout) or s3://bucket/prefix "
        "(default: %(default)s)",
    )
    root.add_argument(
        "--workers", type=int, default=None, help="worker processes (default: CPUs - 2, at most 12)"
    )
    sub = root.add_subparsers(dest="command", required=True)

    p = sub.add_parser(
        "simulate", help="generate member behaviour into the event lake, ground truth apart"
    )
    p.add_argument(
        "--truth",
        required=True,
        help="directory for the simulator's ground truth (never read by training)",
    )
    p.add_argument("--preset", default="smoke", choices=["smoke", "medium", "full"])
    p.add_argument("--seed", type=int)
    p.add_argument("--accounts", type=int)
    p.add_argument("--days", type=int)
    p.add_argument(
        "--start", help="first simulated instant (UTC midnight), e.g. 2026-09-01T00:00:00Z"
    )
    p.add_argument("--impression-sample-rate", type=float)
    p.add_argument(
        "--object-layout",
        choices=["hourly", "writer"],
        help="hourly (default: one object per hour and shard) or writer (shaped like the "
        "product's lake writer; many small objects)",
    )
    p.add_argument(
        "--experiment",
        action="append",
        help="key[:effect=0.1][:variants=control=50,treatment=50] (repeatable)",
    )
    p.set_defaults(handler=cmd_simulate)

    p = sub.add_parser(
        "compact", help="compact every closed lake hour into one Parquet file (idempotent)"
    )
    p.add_argument("--now", help="instant that decides which hours are closed (default: now)")
    p.add_argument("--grace-minutes", type=int, default=15)
    p.add_argument(
        "--delete-sources", action="store_true", help="delete the NDJSON objects once compacted"
    )
    p.add_argument(
        "--erase",
        help="then erase these keys (a file: the staff API's answer or one key per line), as "
        "`erase --keys FILE --confirm-out -` does, under the same lease",
    )
    p.set_defaults(handler=cmd_compact)

    p = sub.add_parser(
        "erase",
        help="remove erased members' subjects from the lake, compacted hours, datasets and "
        "artefacts; verify; confirm",
    )
    p.add_argument(
        "--keys",
        help="`api` (GET /api/admin/v1/system/privacy/erasures; the default when "
        "WEBFLIX_ADMIN_API_URL is set), a file (that answer, a JSON list, or one key per line), "
        "or - for stdin",
    )
    p.add_argument(
        "--confirm",
        help="`api` (POST …/erasures/confirm; the default with --keys api), a file to write the "
        "confirm request bodies to, - (in the summary; the default with a key file), or none",
    )
    p.add_argument("--reason", help="audit reason sent with the confirmation")
    p.add_argument(
        "--watch-days", type=int, default=30, help="keep erasing late arrivals this long"
    )
    p.add_argument("--now", help="the job's instant (default: now)")
    p.set_defaults(handler=cmd_erase)

    p = sub.add_parser(
        "export-events",
        help="the events part of members' data exports: each request's events, as stored, "
        "under privacy/export-events/{requestId}/",
    )
    p.add_argument(
        "--requests",
        required=True,
        help='a JSON file (or - for stdin): {"requests": [{"requestId", "accountKey", "from", '
        '"to"}]}',
    )
    p.add_argument("--results", help="write the per-request results here (default: in the summary)")
    p.add_argument(
        "--erasures",
        help="keys whose erasure is pending: `api` (GET /api/admin/v1/system/privacy/erasures) "
        "or a file; the erasure plan's keys are always honoured",
    )
    p.add_argument("--grace-minutes", type=int, default=15)
    p.add_argument("--keep-days", type=int, default=7, help="prune outputs older than this")
    p.add_argument("--force", action="store_true", help="extract again even if complete")
    p.add_argument("--now", help="the job's instant (default: now)")
    p.set_defaults(handler=cmd_export_events)

    p = sub.add_parser("build-dataset", help="lake -> interaction tables (Parquet)")
    p.add_argument("--dataset", required=True, help="dataset id")
    p.add_argument(
        "--as-of", help="knowledge cutoff: only events received before it (default: now)"
    )
    p.set_defaults(handler=cmd_build_dataset)

    p = sub.add_parser(
        "train", help="fit co-watch, ALS, content and the ranker at a cutoff; record the run"
    )
    p.add_argument("--dataset", required=True)
    p.add_argument("--as-of", help="knowledge cutoff (default: the dataset's)")
    p.add_argument("--params", help="JSON file of parameter overrides")
    p.add_argument("--run", help="run id (default: cutoff and recipe hash)")
    p.set_defaults(handler=cmd_train)

    p = sub.add_parser(
        "evaluate", help="temporal backtest of a run against baselines, with intervals and the gate"
    )
    p.add_argument("--run", required=True)
    p.add_argument("--dataset", required=True, help="a dataset whose cutoff covers the test window")
    p.add_argument("--horizon-days", type=int, default=7)
    p.add_argument(
        "--cutoff",
        help="evaluation cutoff (default: the run's knowledge cutoff; "
        "an earlier one is refused as a leak)",
    )
    p.add_argument(
        "--truth", help="simulator ground truth directory (oracle, regret, profile kinds)"
    )
    p.add_argument(
        "--external", action="append", help="NAME=PATH of an external rankings file (repeatable)"
    )
    p.add_argument("--bootstrap", type=int, default=1000)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--max-profiles", type=int)
    p.add_argument(
        "--gate-metric",
        help="override the gate metric (default utility@10 with truth, else search:ndcg@10)",
    )
    p.add_argument("--work", help="scratch directory for the rule-engine exchange files")
    p.add_argument("--out", help="also write the report to this file")
    p.add_argument(
        "--engine-input-only",
        metavar="DIR",
        help="only write the rule engine's input (DIR/engine-input.ndjson) for a separate Node "
        "step, then stop; evaluate afterwards with --external rule-engine=DIR/rule-engine.ndjson "
        "--external rule-engine-home=DIR/rule-engine-home.ndjson",
    )
    p.set_defaults(handler=cmd_evaluate)

    p = sub.add_parser("score", help="write a complete artefact version for a run (manifest last)")
    p.add_argument("--run", required=True)
    p.add_argument("--dataset", help="default: the run's dataset")
    p.set_defaults(handler=cmd_score)

    p = sub.add_parser(
        "publish", help="validate a scored version, check the gate, flip recs/current.json"
    )
    p.add_argument(
        "--run", help="default: the run train-and-score scored last (recs-work/scored/latest.json)"
    )
    p.add_argument(
        "--keep",
        type=int,
        default=3,
        help="complete versions to keep (current and previous always kept)",
    )
    p.set_defaults(handler=cmd_publish)

    p = sub.add_parser("validate", help="validate an artefact version (default: the current one)")
    p.add_argument("--run")
    p.set_defaults(handler=cmd_validate)

    p = sub.add_parser(
        "analyse-experiments",
        help="experiment analysis: SRM, per-variant metrics, always-valid inference",
    )
    p.add_argument(
        "--definitions",
        help="`api` (GET /api/admin/v1/experiments), a JSON file (that answer, or the "
        "pipeline's definitions document), or by default the store's experiments/definitions.json",
    )
    p.add_argument("--as-of", help="knowledge cutoff (default: the end of the last closed hour)")
    p.add_argument("--out", help="also write the whole report to this file")
    p.add_argument(
        "--no-store",
        action="store_true",
        help="do not write experiments/results/ (the importer's input) to the store",
    )
    p.set_defaults(handler=cmd_analyse_experiments)

    p = sub.add_parser(
        "train-and-score",
        help="the daily model job: dataset, backtest and gate evaluation, production run, "
        "scored version (never publishes)",
    )
    p.add_argument("--as-of", help="knowledge cutoff (default: the end of the last closed hour)")
    p.add_argument("--grace-minutes", type=int, default=15)
    p.add_argument(
        "--phase",
        default="all",
        choices=["all", "prepare", "finish"],
        help="all (Node on PATH runs the rule engine), or prepare / finish around a Node step",
    )
    p.add_argument("--work", default=".cache/recs/work/train-and-score", help="work directory")
    p.add_argument("--truth", help="simulator ground truth (simulated lakes only)")
    p.add_argument("--params", help="JSON file of parameter overrides")
    p.add_argument("--keep-datasets", type=int, default=3)
    p.add_argument("--bootstrap", type=int, default=1000)
    p.set_defaults(handler=cmd_train_and_score)
    return root


def _exit_code(error: Exception) -> int | None:
    from webflix_recs.admin_api import AdminApiError  # noqa: PLC0415
    from webflix_recs.erasure import ErasureIncomplete  # noqa: PLC0415
    from webflix_recs.evaluation.rule_engine import RuleEngineUnavailable  # noqa: PLC0415
    from webflix_recs.lease import LakeBusy  # noqa: PLC0415

    if isinstance(error, LakeBusy):
        return EXIT_LAKE_BUSY
    if isinstance(error, ErasureIncomplete):
        return EXIT_ERASURE_INCOMPLETE
    if isinstance(error, AdminApiError):
        return EXIT_STAFF_API
    if isinstance(error, RuleEngineUnavailable):
        return EXIT_RULE_ENGINE_UNAVAILABLE
    return None


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    from webflix_recs.parallel import limit_threads  # noqa: PLC0415

    limit_threads()
    started = time.perf_counter()
    try:
        summary = args.handler(args)
    except Exception as error:  # the documented failures map to exit codes; the rest is 1
        code = _exit_code(error)
        if code is None:
            raise
        _log(f"{args.command}: {error}")
        raise SystemExit(code) from error
    summary["wallSeconds"] = round(time.perf_counter() - started, 2)
    summary["maxRssMb"] = _peak_rss_mb()
    _emit(summary)


if __name__ == "__main__":
    main()
