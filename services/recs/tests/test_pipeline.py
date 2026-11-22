"""End to end on the real catalogue: leakage, restricted subjects from lake to artefacts, the
real rule engine, the publish gate and atomic publishing."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import orjson
import polars as pl
import pytest

from conftest import EndToEnd
from webflix_recs import artefacts
from webflix_recs.evaluation.harness import EvaluationInputs, evaluate
from webflix_recs.history import LeakError, targets
from webflix_recs.ids import iso_ms
from webflix_recs.storage import get_json, put_json

pytestmark = [pytest.mark.slow, pytest.mark.node]


@pytest.fixture(scope="module")
def evaluation(e2e: EndToEnd, trained: dict[str, Any]) -> dict[str, Any]:
    models, manifest = trained["backtest"]
    report = evaluate(
        EvaluationInputs(
            e2e.catalog, e2e.dataset, models, manifest, truth_dir=e2e.truth, bootstrap=200
        ),
        work_dir=e2e.work / "evaluate",
        log=lambda *_: None,
    )
    artefacts.store_evaluation(e2e.storage, report)
    return report


def test_the_real_rule_engine_ranks_every_evaluated_profile(evaluation: dict[str, Any]) -> None:
    assert evaluation["externalCoverage"] == {"rule-engine": 1.0, "rule-engine-home": 1.0}
    results = evaluation["results"]
    assert results["rule-engine"]["all"]["ndcg@10"][0] > results["random"]["all"]["ndcg@10"][0]
    assert evaluation["leakCheck"] == "passed"
    assert evaluation["gate"]["metric"] == "utility@10"


def test_a_planted_leak_is_refused_and_would_have_inflated_the_metrics(
    e2e: EndToEnd, trained: dict[str, Any], evaluation: dict[str, Any]
) -> None:
    leaky_models, leaky_manifest = trained["production"]  # trained through the test window
    honest = evaluation
    inputs = EvaluationInputs(
        e2e.catalog,
        e2e.dataset,
        leaky_models,
        leaky_manifest,
        cutoff_ms=e2e.cutoff_ms,
        bootstrap=100,
    )
    with pytest.raises(LeakError, match="after the evaluation cutoff"):
        evaluate(inputs, work_dir=e2e.work / "leak", log=lambda *_: None)

    # A rankings file that peeked at the test window: refused on its provenance...
    peek = e2e.work / "peek.ndjson"
    profiles = e2e.dataset.tables["profiles"]["profile"].to_list()
    future = targets(e2e.dataset, e2e.catalog, e2e.cutoff_ms, e2e.end_ms, profiles)
    ids = e2e.catalog.ids
    lines = [
        orjson.dumps(
            {
                "format": "webflix.rankings",
                "formatVersion": 1,
                "system": "peek",
                "asOf": iso_ms(e2e.end_ms),
            }
        )
    ]
    lines += [
        orjson.dumps(
            {"profileKey": p, "titleIds": [ids[t] for t in sorted(f, key=lambda t: -f[t])]}
        )
        for p, f in future.items()
    ]
    peek.write_bytes(b"\n".join(lines) + b"\n")
    honest_models, honest_manifest = trained["backtest"]
    externals = {
        "rule-engine": e2e.work / "evaluate" / "rule-engine" / "rule-engine.ndjson",
        "peek": peek,
    }
    with pytest.raises(LeakError, match="after the cutoff"):
        evaluate(
            EvaluationInputs(
                e2e.catalog,
                e2e.dataset,
                honest_models,
                honest_manifest,
                externals=externals,
                bootstrap=50,
            ),
            work_dir=e2e.work / "leak",
            log=lambda *_: None,
        )

    # ...and, with the guard bypassed, both leaks show up as a jump in the metrics.
    bypassed = evaluate(
        EvaluationInputs(
            e2e.catalog,
            e2e.dataset,
            leaky_models,
            leaky_manifest,
            cutoff_ms=e2e.cutoff_ms,
            externals=externals,
            bootstrap=50,
            allow_leak=True,
        ),
        work_dir=e2e.work / "leak",
        log=lambda *_: None,
    )
    assert bypassed["leakCheck"].startswith("bypassed")
    assert bypassed["results"]["peek"]["all"]["recall@20"][0] > 0.99
    assert (
        bypassed["results"]["peek"]["all"]["recall@20"][0]
        > honest["results"]["learned"]["all"]["recall@20"][0] + 0.05
    )
    assert (
        bypassed["results"]["learned"]["all"]["ndcg@10"][0]
        > honest["results"]["learned"]["all"]["ndcg@10"][0]
    )


def _restricted_and_unconsented(e2e: EndToEnd) -> set[str]:
    truth = pl.read_parquet(e2e.truth / "profiles" / "*.parquet")
    excluded = truth.filter(pl.col("restricted") | ~pl.col("personalisation_final"))
    return set(excluded["profile_key"].to_list())


def test_restricted_profiles_never_reach_training_data_candidates_or_artefacts(
    e2e: EndToEnd, trained: dict[str, Any], evaluation: dict[str, Any]
) -> None:
    excluded = _restricted_and_unconsented(e2e)
    truth = pl.read_parquet(e2e.truth / "profiles" / "*.parquet")
    restricted = set(truth.filter(pl.col("restricted"))["profile_key"].to_list())
    # They are in the lake (flagged), so the exclusion is the pipeline's doing.
    lake_profiles: set[str] = set()
    for info in e2e.storage.list("events/"):
        if info.key.endswith(".parquet"):
            frame = pl.read_parquet(
                io.BytesIO(e2e.storage.get(info.key) or b""), columns=["profile", "restricted"]
            )
            lake_profiles |= set(
                frame.filter(pl.col("restricted"))["profile"].drop_nulls().to_list()
            )
    assert lake_profiles & restricted
    for name, table in e2e.dataset.tables.items():
        if "profile" in table.columns:
            assert not set(table["profile"].to_list()) & excluded, f"dataset table {name}"
    models, manifest = trained["production"]
    result = artefacts.score(
        e2e.storage, e2e.catalog, e2e.dataset, models, manifest, log=lambda *_: None
    )
    published: set[str] = set()
    for entry in result.manifest["files"]:
        if entry["table"] == "profiles":
            body = e2e.storage.get(f"recs/v={result.run}/{entry['path']}") or b""
            published |= set(pl.read_parquet(io.BytesIO(body))["profile_key"].to_list())
    assert published
    assert not published & excluded
    assert evaluation["profiles"] > 0


def test_publish_refuses_without_a_passing_evaluation(
    e2e: EndToEnd, trained: dict[str, Any]
) -> None:
    models, manifest = trained["production"]
    result = artefacts.score(
        e2e.storage, e2e.catalog, e2e.dataset, models, manifest, log=lambda *_: None
    )
    recipe = manifest["recipeHash"]
    stored = {
        i.key: e2e.storage.get(i.key)
        for i in e2e.storage.list(f"{artefacts.EVALUATIONS_PREFIX}{recipe}/")
    }
    e2e.storage.delete(list(stored))
    failing = {
        "recipeHash": recipe,
        "run": "x",
        "cutoff": iso_ms(e2e.cutoff_ms),
        "gate": {"passed": False},
    }
    put_json(e2e.storage, f"{artefacts.EVALUATIONS_PREFIX}{recipe}/x.json", failing)
    try:
        with pytest.raises(artefacts.PublishRefused, match="beats the rule engine"):
            artefacts.publish(e2e.storage, result.run, log=lambda *_: None)
        assert get_json(e2e.storage, artefacts.POINTER_KEY) is None
    finally:
        e2e.storage.delete([f"{artefacts.EVALUATIONS_PREFIX}{recipe}/x.json"])
        for key, body in stored.items():
            e2e.storage.put(key, body or b"")


def _passing_report(recipe: str, run: str, cutoff: str) -> dict[str, Any]:
    return {
        "recipeHash": recipe,
        "run": run,
        "cutoff": cutoff,
        "profiles": 1,
        "gate": {
            "metric": "utility@10",
            "candidate": "learned",
            "baseline": "rule-engine",
            "difference": [0.1, 0.05, 0.15],
            "passed": True,
        },
    }


def test_publishing_is_atomic_and_readers_only_ever_see_complete_versions(
    e2e: EndToEnd, trained: dict[str, Any], tmp_path: Path
) -> None:
    from webflix_recs.storage import LocalStorage

    # A fresh store holding only what publishing needs, so this test controls every version.
    storage = LocalStorage(tmp_path)
    for prefix in ("catalog/", "recs-work/runs/"):
        for info in e2e.storage.list(prefix):
            storage.put(info.key, e2e.storage.get(info.key) or b"")
    models, manifest = trained["production"]
    recipe = manifest["recipeHash"]
    # The gate itself is tested above; here a passing report is planted so publish can proceed.
    put_json(
        storage,
        f"{artefacts.EVALUATIONS_PREFIX}{recipe}/plant.json",
        _passing_report(recipe, "plant", iso_ms(e2e.cutoff_ms)),
    )

    first = artefacts.score(
        storage,
        e2e.catalog,
        e2e.dataset,
        models,
        manifest,
        profiles_per_shard=40,
        log=lambda *_: None,
    )
    assert len([f for f in first.manifest["files"] if f["table"] == "profiles"]) > 2
    assert artefacts.validate_version(storage, first.run) == []
    pointer = artefacts.publish(storage, first.run, log=lambda *_: None)
    assert pointer["previous"] is None

    # A second version under another run id; the scorer crashes after two shards.
    second_manifest = {**manifest, "run": f"{manifest['run']}-b"}
    with pytest.raises(RuntimeError, match="simulated failure"):
        artefacts.score(
            storage,
            e2e.catalog,
            e2e.dataset,
            models,
            second_manifest,
            profiles_per_shard=40,
            fail_after_shards=2,
            log=lambda *_: None,
        )
    # Readers still see the first version, complete and valid; the half-written one has no
    # manifest, is refused by publish and is invisible to readers.
    current = artefacts.read_current(storage)
    assert current is not None and current[0]["run"] == first.run
    assert artefacts.validate_version(storage, first.run) == []
    assert artefacts.validate_version(storage, second_manifest["run"])[0].endswith(
        "the version is incomplete"
    )
    with pytest.raises(artefacts.PublishRefused, match="no complete artefact version"):
        artefacts.publish(storage, second_manifest["run"], log=lambda *_: None)

    # A completed second version is published: the pointer flips last and records the previous.
    artefacts.score(
        storage,
        e2e.catalog,
        e2e.dataset,
        models,
        second_manifest,
        profiles_per_shard=40,
        log=lambda *_: None,
    )
    flipped = artefacts.publish(storage, second_manifest["run"], log=lambda *_: None)
    assert flipped["previous"] == first.run
    assert artefacts.read_current(storage) is not None
    history = [i.key for i in storage.list("recs/history/")]
    assert len(history) == 2

    # Corruption after the fact is caught by the validator and blocks a publish.
    latest = artefacts.read_current(storage)
    assert latest is not None
    shard = next(f for f in latest[1]["files"] if f["table"] == "profiles")
    key = f"recs/v={second_manifest['run']}/{shard['path']}"
    storage.put(key, (storage.get(key) or b"")[:-10])
    assert any(
        "SHA-256" in problem
        for problem in artefacts.validate_version(storage, second_manifest["run"])
    )
    with pytest.raises(artefacts.PublishRefused, match="invalid"):
        artefacts.publish(storage, second_manifest["run"], log=lambda *_: None)


def test_published_artefacts_follow_the_documented_schema(
    e2e: EndToEnd, trained: dict[str, Any]
) -> None:
    models, manifest = trained["production"]
    result = artefacts.score(
        e2e.storage, e2e.catalog, e2e.dataset, models, manifest, log=lambda *_: None
    )
    assert artefacts.validate_version(e2e.storage, result.run) == []
    neighbours = pl.read_parquet(
        io.BytesIO(e2e.storage.get(f"recs/v={result.run}/neighbours/part-00000.parquet") or b"")
    )
    assert neighbours.columns == ["title_id", "rank", "neighbour_id", "score", "support"]
    assert (
        int(neighbours.group_by("title_id").agg(pl.len())["len"].to_numpy().max())
        <= artefacts.NEIGHBOURS
    )
    shard = next(f for f in result.manifest["files"] if f["table"] == "profiles")
    profiles = pl.read_parquet(
        io.BytesIO(e2e.storage.get(f"recs/v={result.run}/{shard['path']}") or b"")
    )
    payload = orjson.loads(profiles["payload"][0])
    assert {row["type"] for row in payload["rows"]} >= {"personal", "top-picks", "billboard"}
    # The importer's budget: a neighbours row is 5 bound parameters, so 20 rows per statement.
    assert len(artefacts.TABLES["neighbours"]["columns"]) * 20 <= 100
