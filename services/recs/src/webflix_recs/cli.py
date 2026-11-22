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

    erase: list[str] = []
    if args.erase:
        erase = [line.strip() for line in Path(args.erase).read_text().splitlines() if line.strip()]
    started = time.perf_counter()
    result = compact(
        args.store,
        now_ms=_instant(args.now, int(time.time() * 1000)),
        grace_ms=args.grace_minutes * 60_000,
        delete_sources=args.delete_sources,
        erase_accounts=erase,
        workers=_workers(args.workers),
    )
    return {
        "command": "compact",
        **result.to_dict(),
        "seconds": round(time.perf_counter() - started, 2),
    }


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
    from webflix_recs.storage import open_storage  # noqa: PLC0415

    storage = open_storage(args.store)
    try:
        pointer = publish(storage, args.run, keep=args.keep, log=_log)
    except PublishRefused as refusal:
        _log(f"publish refused: {refusal}")
        raise SystemExit(3) from refusal
    return {"command": "publish", "pointer": "recs/current.json", **pointer}


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
        raise SystemExit(4)
    return {"command": "validate", "run": run, "valid": True}


def cmd_analyse_experiments(args: argparse.Namespace) -> dict[str, Any]:
    from webflix_recs.experiments.analysis import run_analysis  # noqa: PLC0415

    if args.definitions:
        definitions = orjson.loads(Path(args.definitions).read_bytes())
    else:
        from webflix_recs.simulate.run import DEFINITIONS_KEY  # noqa: PLC0415
        from webflix_recs.storage import get_json, open_storage  # noqa: PLC0415

        definitions = get_json(open_storage(args.store), DEFINITIONS_KEY)
        if definitions is None:
            raise SystemExit(f"no --definitions given and no {DEFINITIONS_KEY} in the store")
    report = run_analysis(
        args.store,
        definitions,
        as_of_ms=_instant(args.as_of) if args.as_of else None,
        workers=_workers(args.workers),
        log=_log,
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(orjson.dumps(report, option=orjson.OPT_INDENT_2))
    return {
        "command": "analyse-experiments",
        "report": str(out.resolve()),
        "experiments": [e.get("key") for e in report.get("experiments", [])],
    }


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
        "--erase", help="file of pseudonymous account keys whose events compaction drops"
    )
    p.set_defaults(handler=cmd_compact)

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
    p.set_defaults(handler=cmd_evaluate)

    p = sub.add_parser("score", help="write a complete artefact version for a run (manifest last)")
    p.add_argument("--run", required=True)
    p.add_argument("--dataset", help="default: the run's dataset")
    p.set_defaults(handler=cmd_score)

    p = sub.add_parser(
        "publish", help="validate a scored version, check the gate, flip recs/current.json"
    )
    p.add_argument("--run", required=True)
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
        help="pre-registered experiment definitions JSON (default: the store's "
        "experiments/definitions.json, exported from the experiments table)",
    )
    p.add_argument("--as-of", help="analysis instant (default: now)")
    p.add_argument("--out", required=True, help="report JSON path")
    p.set_defaults(handler=cmd_analyse_experiments)
    return root


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    from webflix_recs.parallel import limit_threads  # noqa: PLC0415

    limit_threads()
    started = time.perf_counter()
    summary = args.handler(args)
    summary["wallSeconds"] = round(time.perf_counter() - started, 2)
    summary["maxRssMb"] = _peak_rss_mb()
    _emit(summary)


if __name__ == "__main__":
    main()
