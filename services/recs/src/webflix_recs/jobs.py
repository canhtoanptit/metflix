"""The daily model job (`train-and-score`) and the rules every scheduled job shares.

The job turns the lake into a scored artefact version, never a published one: publishing is
its own job (`publish`), which refuses unless an evaluation of the same recipe passed the gate
(artefacts.publish). Steps, at a knowledge cutoff T (default: the end of the last closed hour):

1. `build-dataset` as of T, dataset id `asof-YYYYMMDD-HHMM` (rebuilt on a rerun);
2. train the backtest run as of T - 7 days and evaluate it (the gate: learned vs the real
   milestone 1 engine, whose rankings come from `scripts/rule-engine-rankings.ts`);
3. train the production run as of T and score it into `recs/v={run}/` (manifest last);
4. record the scored run in `recs-work/scored/latest.json`, which `publish` reads by default;
   when there is nothing to train yet (a lake younger than the backtest needs, or without
   consented plays), record that instead and end cleanly: `publish` then has nothing to publish;
5. keep the newest `keep_datasets` job datasets (datasets hold behaviour; erasure rewrites the
   ones that remain).

The rule engine needs Node and the repository's TypeScript packages, which the job image does
not have. `phase="all"` runs it in-process when Node is on PATH (dev, or an image with both);
otherwise the job is split around a Node step that shares a work directory:

    webflix-recs train-and-score --phase prepare --work /work   # 1, 2a: the engine input
    node services/recs/scripts/rule-engine-rankings.ts --input /work/engine-input.ndjson
        --out-dir /work                                         # the rule engine's rankings
    webflix-recs train-and-score --phase finish --work /work    # 2b to 5

Idempotent: ids derive from T and the recipe (code digest + parameters), so a rerun at the same
T rebuilds the same dataset and runs; a version that is already complete is never rescored
(that would change the files under a pointer that names them), the job reports it instead.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import orjson

from webflix_recs.ids import DAY_MS, HOUR_MS, iso_ms, parse_iso_ms
from webflix_recs.storage import Storage, get_json, open_storage, put_json

SCORED_MARKER = "recs-work/scored/latest.json"
JOB_DATASET_PREFIX = "asof-"
DEFAULT_GRACE_MS = 15 * 60_000
HORIZON_DAYS = 7


def closed_as_of(now_ms: int, grace_ms: int = DEFAULT_GRACE_MS) -> int:
    """The knowledge cutoff a scheduled job uses: the end of the last hour that compaction
    treats as closed. Every event received before it is in the lake by then (the playback
    outbox writes within minutes of receipt, well inside the 15-minute grace), so a dataset or
    an analysis at this cutoff does not change when the job runs again later."""
    return (now_ms - grace_ms) // HOUR_MS * HOUR_MS


def dataset_id_for(as_of_ms: int) -> str:
    stamp = iso_ms(as_of_ms)
    return f"{JOB_DATASET_PREFIX}{stamp[0:4]}{stamp[5:7]}{stamp[8:10]}-{stamp[11:13]}{stamp[14:16]}"


class AlreadyScored(RuntimeError):
    pass


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
    log: Any = print,
) -> dict[str, Any]:
    from webflix_recs.artefacts import (  # noqa: PLC0415
        gate_summary,
        passing_evaluation,
        score,
        store_evaluation,
    )
    from webflix_recs.catalog import load_catalog  # noqa: PLC0415
    from webflix_recs.dataset import EmptyLake, build_dataset, load_dataset  # noqa: PLC0415
    from webflix_recs.evaluation.harness import (  # noqa: PLC0415
        EvaluationInputs,
        evaluate,
        write_rule_engine_input,
    )
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
    recipe = recipe_hash(params.to_dict())
    production_run = run_id_for(as_of_ms, recipe)
    backtest_as_of = as_of_ms - HORIZON_DAYS * DAY_MS
    backtest_run = run_id_for(backtest_as_of, recipe)
    dataset_id = dataset_id_for(as_of_ms)
    summary: dict[str, Any] = {
        "asOf": iso_ms(as_of_ms),
        "dataset": dataset_id,
        "backtestRun": backtest_run,
        "run": production_run,
        "recipeHash": recipe,
        "phase": phase,
    }
    if get_json(storage, f"recs/v={production_run}/manifest.json") is not None:
        raise AlreadyScored(
            f"recs/v={production_run}/ is already complete (same cutoff and recipe): nothing to do"
        )
    catalog = load_catalog(storage)
    if phase == "finish" and state.get("status") == "nothing-to-train":
        # The prepare phase found nothing to train and said so in the marker: follow it.
        return {**summary, "status": "nothing-to-train", "reason": state.get("reason")}
    if phase in {"all", "prepare"}:
        try:
            dataset = build_dataset(
                location, storage, dataset_id=dataset_id, as_of_ms=as_of_ms, workers=workers,
                log=log,
            ).manifest  # fmt: skip
            summary["datasetRows"] = dataset["rows"]
            data = load_dataset(storage, dataset_id)
            models, report = train(catalog, data, as_of_ms=backtest_as_of, params=params, log=log)
        except (EmptyLake, NotEnoughData) as nothing:
            return _nothing_to_train(storage, catalog, summary, str(nothing), as_of_ms, phase, work)
        save_run(
            storage, models, report, dataset=data, catalog=catalog, as_of_ms=backtest_as_of,
            run_id=backtest_run,
        )  # fmt: skip
        if phase == "prepare":
            backtest_models, backtest_manifest = load_run(storage, backtest_run)
            inputs = EvaluationInputs(catalog, data, backtest_models, backtest_manifest)
            path = write_rule_engine_input(inputs, work, log)
            _state_path(work).write_bytes(
                orjson.dumps(
                    {
                        "asOfMs": as_of_ms,
                        "dataset": dataset_id,
                        "run": backtest_run,
                        "status": "prepared",
                    }
                )
            )
            return {**summary, "status": "prepared", "engineInput": str(path)}
    data = load_dataset(storage, dataset_id)
    backtest_models, backtest_manifest = load_run(storage, backtest_run)
    externals = None
    if phase == "finish":
        externals = {
            "rule-engine": work / "rule-engine.ndjson",
            "rule-engine-home": work / "rule-engine-home.ndjson",
        }
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
        work_dir=work / "evaluate",
        log=log,
    )
    summary["evaluation"] = store_evaluation(storage, evaluation)
    summary["gate"] = evaluation["gate"]
    try:
        models, report = train(catalog, data, as_of_ms=as_of_ms, params=params, log=log)
    except NotEnoughData as nothing:
        return _nothing_to_train(storage, catalog, summary, str(nothing), as_of_ms, phase, work)
    manifest = save_run(
        storage, models, report, dataset=data, catalog=catalog, as_of_ms=as_of_ms,
        run_id=production_run,
    )  # fmt: skip
    passing = passing_evaluation(storage, recipe)
    scored = score(
        storage,
        catalog,
        data,
        models,
        manifest,
        evaluation=gate_summary(passing) if passing else None,
        log=log,
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
            "gatePassed": bool(evaluation["gate"].get("passed")),
            "evaluation": summary["evaluation"],
        },
    )
    summary["datasetsPruned"] = prune_job_datasets(
        storage, keep=keep_datasets, protect={dataset_id}
    )
    return {**summary, "status": "scored"}


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
