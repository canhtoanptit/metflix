"""The daily model job (`train-and-score`) and the rules every scheduled job shares.

The job turns the lake into a scored artefact version, never a published one: publishing is
its own job (`publish`), which refuses unless the gate decision that belongs to the scored run
passed (gate.py). Steps, at a knowledge cutoff T (default: the end of the last closed hour):

1. `build-dataset` as of T, dataset id `asof-YYYYMMDD-HHMM` (rebuilt on a rerun), leaving out
   every subject pending erasure when the job starts (an erased account, a newly restricted
   profile: `--erasures`, and the erasure plan's keys);
2. train a backtest run at each gate cutoff T - 7 d, T - 14 d, ... (`gate_cutoffs` of them), each
   on a dataset built as of its own cutoff (then deleted), and evaluate each on the week after
   its cutoff with the dataset as of T (learned vs the real milestone 1 engine, whose
   rankings come from `scripts/rule-engine-rankings.ts`); every evaluation is stored;
3. train the production run as of T, decide the gate for it from those evaluations, and score it
   into `recs/v={run}/` (manifest last, carrying the decision), leaving out the subjects pending
   erasure when scoring starts (fetched again: a request made during the job counts);
4. record the scored run in `recs-work/scored/latest.json`, which `publish` reads by default;
   when there is nothing to train yet (a lake younger than the most recent backtest needs, or
   without consented plays), record that instead and end cleanly: `publish` then has nothing to
   publish. An older cutoff without enough data fails that cutoff (and so the gate), it does not
   stop the job;
5. keep the newest `keep_datasets` job datasets (datasets hold behaviour; erasure rewrites the
   ones that remain).

The rule engine needs Node and the repository's TypeScript packages, which the job image does
not have. `phase="all"` runs it in-process when Node is on PATH (dev, or an image with both);
otherwise the job is split around a Node step that shares a work directory:

    webflix-recs train-and-score --phase prepare --work /work   # 1, 2a: the engine input
    node services/recs/scripts/rule-engine-rankings.ts --input /work/engine-input.ndjson
        --out-dir /work                                         # the rule engine's rankings
    webflix-recs train-and-score --phase finish --work /work    # 2b to 5

The engine input holds one section per backtest; the Node step writes each section's rankings to
`/work/{backtest run}/`.

Idempotent: ids derive from T and the recipe (code digest + parameters), so a rerun at the same
T rebuilds the same dataset and runs; a version that is already complete is never rescored
(that would change the files under a pointer that names them), the job reports it instead.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import orjson

from webflix_recs.ids import HOUR_MS, iso_ms, parse_iso_ms
from webflix_recs.storage import Storage, get_json, open_storage, put_json

SCORED_MARKER = "recs-work/scored/latest.json"
JOB_DATASET_PREFIX = "asof-"
DEFAULT_GRACE_MS = 15 * 60_000


def closed_as_of(now_ms: int, grace_ms: int = DEFAULT_GRACE_MS) -> int:
    """The knowledge cutoff a scheduled job uses: the end of the last hour that compaction
    treats as closed. Every event received before it is in the lake by then (the playback
    outbox writes within minutes of receipt, well inside the 15-minute grace), so a dataset or
    an analysis at this cutoff does not change when the job runs again later."""
    return (now_ms - grace_ms) // HOUR_MS * HOUR_MS


def dataset_id_for(as_of_ms: int) -> str:
    stamp = iso_ms(as_of_ms)
    return f"{JOB_DATASET_PREFIX}{stamp[0:4]}{stamp[5:7]}{stamp[8:10]}-{stamp[11:13]}{stamp[14:16]}"


def backtest_dataset_id(cutoff_ms: int) -> str:
    """The dataset a backtest at `cutoff_ms` learns from (deleted once it is trained)."""
    return "backtest-" + dataset_id_for(cutoff_ms).removeprefix(JOB_DATASET_PREFIX)


class AlreadyScored(RuntimeError):
    """The cutoff's version is already complete: nothing to do (exit 0). `summary` says so; in
    `--phase prepare` the work directory still gets an engine input without profiles and a state
    saying `already-scored`, so the Node step and `--phase finish` after it end cleanly too and
    the publish and import that follow run again (a retry after a failed import)."""

    def __init__(self, message: str, summary: dict[str, Any]) -> None:
        super().__init__(message)
        self.summary = summary


def _state_path(work: Path) -> Path:
    return work / "train-and-score.json"


def train_and_score(
    location: str,
    *,
    as_of_ms: int,
    phase: str = "all",
    work: Path,
    truth_dir: Path | None = None,
    params_path: str | None = None,
    keep_datasets: int = 3,
    bootstrap: int = 1000,
    workers: int = 1,
    gate_cutoffs: int | None = None,
    pending: Callable[[], Iterable[str]] = lambda: (),
    log: Any = print,
) -> dict[str, Any]:
    from webflix_recs import gate  # noqa: PLC0415
    from webflix_recs.artefacts import score, store_evaluation  # noqa: PLC0415
    from webflix_recs.catalog import load_catalog  # noqa: PLC0415
    from webflix_recs.dataset import EmptyLake, build_dataset, load_dataset  # noqa: PLC0415
    from webflix_recs.erasure import subjects_to_exclude  # noqa: PLC0415
    from webflix_recs.evaluation.harness import (  # noqa: PLC0415
        EvaluationInputs,
        evaluate,
        write_rule_engine_input,
    )
    from webflix_recs.evaluation.rule_engine import engine_outputs  # noqa: PLC0415
    from webflix_recs.provenance import recipe_hash  # noqa: PLC0415
    from webflix_recs.train import (  # noqa: PLC0415
        NotEnoughData,
        TrainParams,
        load_run,
        run_id_for,
        save_run,
        train,
    )

    if phase not in {"all", "prepare", "finish"}:
        raise ValueError(f"unknown phase {phase!r}")
    storage = open_storage(location)
    params = TrainParams()
    if params_path:
        params = TrainParams.from_dict(
            {**params.to_dict(), **orjson.loads(Path(params_path).read_bytes())}
        )
    state: dict[str, Any] = {}
    if phase == "finish":
        state = orjson.loads(_state_path(work).read_bytes())
        as_of_ms = int(state["asOfMs"])
    count = int(state.get("gateCutoffs") or gate.gate_cutoffs_setting(gate_cutoffs))
    recipe = recipe_hash(params.to_dict())
    production_run = run_id_for(as_of_ms, recipe)
    cutoffs = gate.cutoffs_for(as_of_ms, count)
    dataset_id = dataset_id_for(as_of_ms)
    summary: dict[str, Any] = {
        "asOf": iso_ms(as_of_ms),
        "dataset": dataset_id,
        "backtestRuns": [run_id_for(cutoff, recipe) for cutoff in cutoffs],
        "run": production_run,
        "recipeHash": recipe,
        "phase": phase,
        "gateCutoffs": count,
    }
    catalog = load_catalog(storage)
    if phase == "finish" and state.get("status") == "already-scored":
        # The prepare phase found the version complete: follow it.
        raise AlreadyScored(
            f"recs/v={production_run}/ was already complete when prepared: nothing to do",
            {**summary, "status": "already-scored"},
        )
    if get_json(storage, f"recs/v={production_run}/manifest.json") is not None:
        done = {**summary, "status": "already-scored"}
        if phase == "prepare":
            from webflix_recs.evaluation.harness import empty_engine_input  # noqa: PLC0415

            work.mkdir(parents=True, exist_ok=True)
            path = work / "engine-input.ndjson"
            empty_engine_input(catalog, as_of_ms, path)
            _state_path(work).write_bytes(
                orjson.dumps({"asOfMs": as_of_ms, "status": "already-scored"})
            )
            done["engineInput"] = str(path)
        raise AlreadyScored(
            f"recs/v={production_run}/ is already complete (same cutoff and recipe): nothing to do",
            done,
        )
    if phase == "finish" and state.get("status") == "nothing-to-train":
        # The prepare phase found nothing to train and said so in the marker: follow it.
        return {**summary, "status": "nothing-to-train", "reason": state.get("reason")}
    notes: dict[int, str] = {int(k): v for k, v in (state.get("notes") or {}).items()}
    trained = [int(c) for c in state.get("trained") or []]
    if phase in {"all", "prepare"}:
        excluded = subjects_to_exclude(storage, pending())
        summary["excludedAtStart"] = len(excluded)
        try:
            dataset = build_dataset(
                location, storage, dataset_id=dataset_id, as_of_ms=as_of_ms, workers=workers,
                log=log, excluded=excluded,
            ).manifest  # fmt: skip
        except EmptyLake as nothing:
            return _nothing_to_train(storage, catalog, summary, str(nothing), as_of_ms, phase, work)
        summary["datasetRows"] = dataset["rows"]
        for cutoff in cutoffs:
            # Each backtest learns from a dataset built as of its own cutoff: what a production
            # run then would have known. The dataset as of T would decide eligibility and device
            # clocks with later events and label impressions with plays received after the
            # cutoff (worth a third of the gated difference, measured: RECOMMENDATIONS-ML §6).
            try:
                at_cutoff = build_dataset(
                    location, storage, dataset_id=backtest_dataset_id(cutoff), as_of_ms=cutoff,
                    workers=workers, log=log, excluded=excluded,
                )  # fmt: skip
                models, report = train(catalog, at_cutoff, as_of_ms=cutoff, params=params, log=log)
            except (EmptyLake, NotEnoughData) as nothing:
                if cutoff == cutoffs[0]:
                    _remove_datasets(storage, [backtest_dataset_id(cutoff)])
                    return _nothing_to_train(
                        storage, catalog, summary, str(nothing), as_of_ms, phase, work
                    )
                notes[cutoff] = f"nothing to train at this cutoff: {nothing}"
                continue
            save_run(
                storage, models, report, dataset=at_cutoff, catalog=catalog, as_of_ms=cutoff,
                run_id=run_id_for(cutoff, recipe),
            )  # fmt: skip
            trained.append(cutoff)
            del at_cutoff
        _remove_datasets(storage, [backtest_dataset_id(cutoff) for cutoff in cutoffs])
        data = load_dataset(storage, dataset_id)
        if phase == "prepare":
            path = work / "engine-input.ndjson"
            for position, cutoff in enumerate(trained):
                backtest = run_id_for(cutoff, recipe)
                backtest_models, backtest_manifest = load_run(storage, backtest)
                inputs = EvaluationInputs(catalog, data, backtest_models, backtest_manifest)
                path = write_rule_engine_input(
                    inputs, work, log, section=backtest, append=position > 0
                )
            _state_path(work).write_bytes(
                orjson.dumps(
                    {
                        "asOfMs": as_of_ms,
                        "dataset": dataset_id,
                        "gateCutoffs": count,
                        "trained": trained,
                        "notes": {str(k): v for k, v in notes.items()},
                        "status": "prepared",
                    }
                )
            )
            return {**summary, "status": "prepared", "engineInput": str(path)}
    data = load_dataset(storage, dataset_id)
    evaluations = []
    for cutoff in trained:
        backtest = run_id_for(cutoff, recipe)
        backtest_models, backtest_manifest = load_run(storage, backtest)
        externals = engine_outputs(work / backtest) if phase == "finish" else None
        evaluation = evaluate(
            EvaluationInputs(
                catalog,
                data,
                backtest_models,
                backtest_manifest,
                truth_dir=truth_dir,
                externals=externals,
                bootstrap=bootstrap,
            ),
            work_dir=work / "evaluate" / backtest,
            log=log,
        )
        evaluations.append(store_evaluation(storage, evaluation))
    summary["evaluations"] = evaluations
    backtests = [run_id_for(cutoff, recipe) for cutoff in trained]
    try:
        models, report = train(catalog, data, as_of_ms=as_of_ms, params=params, log=log)
    except NotEnoughData as nothing:
        _remove_exchange_files(work, backtests)
        return _nothing_to_train(storage, catalog, summary, str(nothing), as_of_ms, phase, work)
    manifest = save_run(
        storage, models, report, dataset=data, catalog=catalog, as_of_ms=as_of_ms,
        run_id=production_run,
    )  # fmt: skip
    decision = gate.decide(
        storage, run=production_run, recipe=recipe, as_of_ms=as_of_ms, count=count, notes=notes
    )
    summary["gate"] = gate.manifest_evaluation(decision)
    excluded_now = subjects_to_exclude(storage, pending())
    summary["excludedAtScoring"] = len(excluded_now)
    scored = score(
        storage,
        catalog,
        data,
        models,
        manifest,
        evaluation=summary["gate"],
        log=log,
        excluded=excluded_now,
    )
    summary["counts"] = scored.manifest["counts"]
    put_json(
        storage,
        SCORED_MARKER,
        {
            "format": "webflix.recs-scored",
            "formatVersion": 1,
            "status": "scored",
            "run": production_run,
            "recipeHash": recipe,
            "asOf": iso_ms(as_of_ms),
            "scoredAt": iso_ms(int(time.time() * 1000)),
            "gatePassed": bool(decision["passed"]),
            "decision": summary["gate"]["decision"],
            "evaluations": evaluations,
        },
    )
    summary["datasetsPruned"] = prune_job_datasets(
        storage, keep=keep_datasets, protect={dataset_id}
    )
    # Only now: a finish phase that failed before this point can run again on the same files.
    _remove_exchange_files(work, backtests)
    return {**summary, "status": "scored"}


def _remove_datasets(storage: Storage, names: list[str]) -> None:
    """The backtests' own datasets: needed only to train them."""
    for name in names:
        storage.delete([info.key for info in storage.list(f"recs-work/datasets/{name}/")])


def _remove_exchange_files(work: Path, backtests: list[str]) -> None:
    """The rule engine's input and rankings hold profile keys with their libraries; once the
    evaluations are stored they are not needed, and erasure only knows the store."""
    import shutil  # noqa: PLC0415

    (work / "engine-input.ndjson").unlink(missing_ok=True)
    for name in (*backtests, "evaluate"):
        shutil.rmtree(work / name, ignore_errors=True)


def _nothing_to_train(
    storage: Storage,
    catalog: Any,
    summary: dict[str, Any],
    reason: str,
    as_of_ms: int,
    phase: str,
    work: Path,
) -> dict[str, Any]:
    """Nothing to train at this cutoff (a young lake): an ordinary outcome, not a failure. The
    marker says so (publish then has nothing to publish), and the prepare phase still leaves an
    engine input without profiles and its state, so the Node step and the finish phase after it
    succeed too."""
    from webflix_recs.evaluation.harness import empty_engine_input  # noqa: PLC0415

    put_json(
        storage,
        SCORED_MARKER,
        {
            "format": "webflix.recs-scored",
            "formatVersion": 1,
            "status": "nothing-to-train",
            "run": None,
            "reason": reason,
            "asOf": iso_ms(as_of_ms),
            "scoredAt": iso_ms(int(time.time() * 1000)),
        },
    )
    result = {**summary, "status": "nothing-to-train", "reason": reason}
    if phase == "prepare":
        work.mkdir(parents=True, exist_ok=True)
        path = work / "engine-input.ndjson"
        empty_engine_input(catalog, as_of_ms, path)
        _state_path(work).write_bytes(
            orjson.dumps({"asOfMs": as_of_ms, "status": "nothing-to-train", "reason": reason})
        )
        result["engineInput"] = str(path)
    return result


def prune_job_datasets(storage: Storage, *, keep: int, protect: set[str]) -> list[str]:
    """Delete this job's datasets (`asof-…`) beyond the newest `keep`."""
    prefix = "recs-work/datasets/"
    datasets: dict[str, list[str]] = {}
    for info in storage.list(prefix + JOB_DATASET_PREFIX):
        name = info.key[len(prefix) :].split("/", 1)[0]
        datasets.setdefault(name, []).append(info.key)
    removed = []
    for name in sorted(datasets, reverse=True)[max(keep, 1) :]:
        if name not in protect:
            storage.delete(datasets[name])
            removed.append(name)
    return removed


def latest_scored_run(storage: Storage) -> str | None:
    """The run the last train-and-score scored, or None (nothing scored yet, or the last job had
    nothing to train)."""
    marker = get_json(storage, SCORED_MARKER)
    return str(marker["run"]) if isinstance(marker, dict) and marker.get("run") else None


def scored_marker(storage: Storage) -> dict[str, Any] | None:
    marker = get_json(storage, SCORED_MARKER)
    return marker if isinstance(marker, dict) else None


__all__ = [
    "SCORED_MARKER",
    "AlreadyScored",
    "closed_as_of",
    "dataset_id_for",
    "latest_scored_run",
    "parse_iso_ms",
    "train_and_score",
]
