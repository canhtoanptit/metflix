"""The behaviour simulator: valid, deterministic, restricted profiles flagged, truth kept apart."""

from __future__ import annotations

import collections
import hashlib
from dataclasses import replace
from pathlib import Path

from helpers import ANCHOR_MS, put_catalog, synthetic_catalog, synthetic_catalog_document
from webflix_recs import schemas
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.simulate.config import ExperimentSpec, preset
from webflix_recs.simulate.run import run_simulation, simulate_in_memory
from webflix_recs.storage import LocalStorage

CONFIG = replace(
    preset("smoke"), accounts=60, days=10, shard_size=30, start=iso_ms(ANCHOR_MS - 10 * DAY_MS)
)


def test_every_event_is_valid_and_kids_emit_only_server_playback() -> None:
    catalog = synthetic_catalog()
    events, truth = simulate_in_memory(CONFIG, catalog)
    assert len(events) > 1000
    for event in events:
        schemas.validate_event(event)
    kinds = {row["profile_key"]: row for row in truth}
    by_profile: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for event in events:
        profile = event["subject"]["profile"]
        if profile:
            by_profile[profile][event["type"]] += 1
            assert event["subject"]["restricted"] == kinds[profile]["restricted"]
    kids = [key for key, row in kinds.items() if row["kids"] and by_profile.get(key)]
    teens = [key for key, row in kinds.items() if row["kind"] == "teen" and by_profile.get(key)]
    assert kids and teens
    for key in kids:
        assert set(by_profile[key]) <= schemas.PLAYBACK_TYPES
    assert any(set(by_profile[key]) - schemas.PLAYBACK_TYPES for key in teens)
    restricted = {key for key, row in kinds.items() if row["restricted"]}
    for event in events:
        if event["type"] == schemas.EXPOSURE:
            assert event["subject"]["profile"] not in restricted


def test_same_seed_same_lake_whatever_the_number_of_workers(tmp_path: Path) -> None:
    catalog = synthetic_catalog()
    digests = []
    for workers in (1, 2):
        store = tmp_path / f"store-{workers}"
        storage = LocalStorage(store)
        put_catalog(storage, synthetic_catalog_document())
        run_simulation(
            CONFIG,
            catalog,
            str(store),
            tmp_path / f"truth-{workers}",
            workers=workers,
            log=lambda *_: None,
        )
        digests.append(
            sorted(
                (info.key, hashlib.sha256(storage.get(info.key) or b"").hexdigest())
                for info in storage.list("events/")
            )
        )
    assert digests[0] == digests[1]
    assert len(digests[0]) > 50


def test_truth_never_lands_in_the_store(tmp_path: Path) -> None:
    catalog = synthetic_catalog()
    storage = LocalStorage(tmp_path / "store")
    put_catalog(storage, synthetic_catalog_document())
    run_simulation(
        CONFIG, catalog, str(tmp_path / "store"), tmp_path / "truth", workers=1, log=lambda *_: None
    )
    prefixes = {info.key.split("/", 1)[0] for info in storage.list()}
    assert prefixes == {"events", "catalog"}
    assert (tmp_path / "truth" / "manifest.json").exists()


def test_experiment_assignment_follows_the_design_weights() -> None:
    spec = ExperimentSpec.parse("recs-aa:variants=control=70,treatment=30")
    assignments = collections.Counter(spec.assign(f"unit-{i}") for i in range(20_000))
    assert abs(assignments["control"] / 20_000 - 0.7) < 0.015
    assert spec.assign("unit-1") == spec.assign("unit-1")
