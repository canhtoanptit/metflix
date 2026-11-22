"""The behaviour simulator: valid, deterministic, collected like the product, truth kept apart."""

from __future__ import annotations

import collections
import gzip
import hashlib
from dataclasses import replace
from pathlib import Path

import orjson

from helpers import ANCHOR_MS, put_catalog, synthetic_catalog, synthetic_catalog_document
from webflix_recs import schemas
from webflix_recs.ids import DAY_MS, iso_ms, parse_iso_ms
from webflix_recs.simulate.config import ExperimentSpec, preset
from webflix_recs.simulate.run import run_simulation, simulate_in_memory
from webflix_recs.storage import LocalStorage

CONFIG = replace(
    preset("smoke"), accounts=60, days=10, shard_size=30, start=iso_ms(ANCHOR_MS - 10 * DAY_MS)
)


def test_every_event_is_valid_and_the_lake_holds_only_what_the_product_stores() -> None:
    catalog = synthetic_catalog()
    events, truth = simulate_in_memory(CONFIG, catalog)
    assert len(events) > 1000
    for event in events:
        schemas.validate_event(event)
    rows = {row["profile_key"]: row for row in truth}
    accounts = {row["account_key"]: row for row in truth}
    restricted = {key for key, row in rows.items() if row["restricted"]}
    assert any(rows[key]["kids"] for key in restricted)
    assert any(rows[key]["kind"] == "teen" for key in restricted)
    for event in events:
        subject = event["subject"]
        # A restricted profile produces nothing at all, client or server (collector.ts).
        assert not subject["restricted"]
        assert subject["profile"] not in restricted
        # Without any consented purpose, only the consent change itself is stored.
        if not subject["consent"]["analytics"] and not subject["consent"]["personalisation"]:
            assert event["type"] == schemas.CONSENT_CHANGE
        # Server events carry no country (the product only knows a request's).
        if event["source"] == "server":
            assert subject["country"] is None
        if event["type"].startswith("playback."):
            assert event["context"]["experiments"] == {}
            assert event["context"]["surface"] == "player"
    reasons = {e["payload"]["reason"] for e in events if e["type"] == schemas.PLAYBACK_ABANDON}
    assert {"closed", "expired"} <= reasons
    for event in events:
        if event["type"] == schemas.PLAYBACK_ABANDON and event["payload"]["reason"] == "expired":
            # Ended by the expiry sweep minutes after the last report.
            lag = parse_iso_ms(event["receivedAt"]) - parse_iso_ms(event["occurredAt"])
            assert 140_000 <= lag < 200_500
    assert accounts  # the truth still describes every simulated profile


def test_collection_rules_remove_events_and_perturb_nothing_else() -> None:
    catalog = synthetic_catalog()
    config = replace(CONFIG, experiments=(ExperimentSpec.parse("recs-aa"),))
    stored, truth = simulate_in_memory(config, catalog)
    everything, _ = simulate_in_memory(replace(config, collect_like_the_product=False), catalog)
    restricted = {row["profile_key"] for row in truth if row["restricted"]}

    def key(event: dict[str, object]) -> bytes:
        return orjson.dumps(event)

    kept = collections.Counter(key(e) for e in stored)
    all_ = collections.Counter(key(e) for e in everything)
    # Every stored event is byte-identical to the one generated without the rules...
    assert not kept - all_
    removed = list((all_ - kept).elements())
    assert removed
    # ...and everything removed is something the product's collector would not store.
    seen_exposures: set[tuple[str, str]] = set()
    for line in removed:
        event = orjson.loads(line)
        subject = event["subject"]
        consent = subject["consent"]
        if subject["restricted"] or subject["profile"] in restricted:
            continue
        if not consent["analytics"] and not consent["personalisation"]:
            assert event["type"] != schemas.CONSENT_CHANGE
            continue
        assert event["type"] == schemas.EXPOSURE, event["type"]
        seen_exposures.add((subject["profile"], event["payload"]["variant"]))
    # Exposures: once per profile and variant within 30 days (the window here is 10 days).
    exposures = collections.Counter(
        (e["subject"]["profile"], e["payload"]["experimentKey"], e["payload"]["variant"])
        for e in stored
        if e["type"] == schemas.EXPOSURE
    )
    duplicates = sum(1 for e in stored if e["type"] == schemas.EXPOSURE) - len(exposures)
    assert duplicates == sum(  # only delivery duplicates (same eventId) remain
        n - 1
        for n in collections.Counter(
            e["eventId"] for e in stored if e["type"] == schemas.EXPOSURE
        ).values()
    )
    assert seen_exposures


def test_writer_layout_groups_like_the_lake_writer_and_changes_no_event(tmp_path: Path) -> None:
    catalog = synthetic_catalog()
    lakes = {}
    for layout in ("hourly", "writer"):
        store = tmp_path / layout
        storage = LocalStorage(store)
        put_catalog(storage, synthetic_catalog_document())
        run_simulation(
            replace(CONFIG, accounts=20, days=4, shard_size=20, object_layout=layout),
            catalog,
            str(store),
            tmp_path / f"truth-{layout}",
            workers=1,
            log=lambda *_: None,
        )
        objects = [
            gzip.decompress(storage.get(info.key) or b"").splitlines()
            for info in storage.list("events/")
        ]
        lakes[layout] = objects
    assert len(lakes["writer"]) > 2 * len(lakes["hourly"])
    hourly = collections.Counter(line for obj in lakes["hourly"] for line in obj)
    writer = collections.Counter(line for obj in lakes["writer"] for line in obj)
    assert hourly == writer
    for obj in lakes["writer"]:
        events = [orjson.loads(line) for line in obj]
        sources = {e["source"] for e in events}
        assert len(sources) == 1
        if sources == {"client"}:
            assert len(events) <= 50 and len({e["deviceId"] for e in events}) == 1
            assert sum(len(line) + 1 for line in obj) <= 64 * 1024
        elif events[0]["type"].startswith("playback."):
            assert len(events) <= 100
        else:
            assert len(events) == 1


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
