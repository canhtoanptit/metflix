"""`retain`: activity older than the events period and totals older than the aggregates period
leave the store (the product's two settings), the plan is written first, reruns are safe."""

from __future__ import annotations

import gzip
import io
from pathlib import Path
from typing import Any

import orjson
import polars as pl
import pytest

from helpers import ANCHOR_MS, make_event, write_lake, write_version
from webflix_recs import cli, lease
from webflix_recs.ids import DAY_MS, HOUR_MS, iso_ms, partition_prefix
from webflix_recs.lake import compact, read_events
from webflix_recs.retention import RECORD_KEY, Periods, RetentionConfigError, retain
from webflix_recs.storage import LocalStorage, get_json, put_json

OLD = ANCHOR_MS - 3 * DAY_MS  # an hour that will be past the events period
NOW = OLD + 400 * DAY_MS  # 396 days is the events period
RECENT = NOW - 2 * DAY_MS
PERIODS = Periods(396, 1126)


def _store(root: Path) -> LocalStorage:
    storage = LocalStorage(root)
    write_lake(storage, [make_event("title.open", OLD + i * 60_000) for i in range(5)], "old")
    compact(str(root), now_ms=OLD + 2 * HOUR_MS)  # compacted, sources kept: both copies
    storage.put(
        f"events-quarantine/{partition_prefix(OLD).removeprefix('events/')}q.ndjson.gz",
        gzip.compress(b"not json\n"),
    )
    write_lake(storage, [make_event("title.open", RECENT + i) for i in range(3)], "recent")
    # A dataset holding rows on both sides of the events cutoff.
    prefix = "recs-work/datasets/d1/"
    tables = {
        "playback": pl.DataFrame({"profile": ["p", "q"], "received_at": [OLD, RECENT]}),
        "profiles": pl.DataFrame({"profile": ["p", "q"], "last_seen": [OLD, RECENT]}),
        "accounts": pl.DataFrame({"account": ["a", "b"], "state_at": [OLD, RECENT]}),
    }
    for name, frame in tables.items():
        buffer = io.BytesIO()
        frame.write_parquet(buffer)
        storage.put(f"{prefix}{name}.parquet", buffer.getvalue())
    put_json(storage, prefix + "manifest.json", {"rows": dict.fromkeys(tables, 2)})
    # Totals on both sides of the aggregates cutoff (1126 days).
    ancient, fresh = iso_ms(NOW - 1200 * DAY_MS), iso_ms(NOW - 10 * DAY_MS)
    for run, created in (
        ("20230101-000000-aaaaaaaa", ancient),
        ("20261101-000000-bbbbbbbb", fresh),
    ):
        put_json(storage, f"recs-work/runs/{run}/manifest.json", {"createdAt": created})
        storage.put(f"recs-work/runs/{run}/models.npz", b"x")
        put_json(storage, f"recs-work/evaluations/r/{run}.json", {"cutoff": created})
        put_json(
            storage, f"recs/history/{created.replace(':', '')}-{run}.json", {"publishedAt": created}
        )
    put_json(storage, "experiments/results/r=20230101-000000-000/k.json", {})
    put_json(storage, "experiments/results/r=20261101-000000-000/k.json", {})
    # Artefact versions: an old unpublished one goes; the published one stays even if old.
    write_version(storage, "20250101-000000-cccccccc", {"p" * 22: ["t-1"]}, publish=False)
    write_version(storage, "20250102-000000-dddddddd", {"q" * 22: ["t-1"]}, publish=True)
    for run in ("20250101-000000-cccccccc", "20250102-000000-dddddddd"):
        manifest: dict[str, Any] = get_json(storage, f"recs/v={run}/manifest.json") or {}
        put_json(storage, f"recs/v={run}/manifest.json", {**manifest, "asOf": iso_ms(OLD)})
    return storage


def _keys(storage: LocalStorage) -> set[str]:
    return {info.key for info in storage.list()}


def test_retention_removes_what_the_periods_no_longer_cover(tmp_path: Path) -> None:
    storage = _store(tmp_path)
    outcome = retain(str(tmp_path), periods=PERIODS, now_ms=NOW, log=lambda _: None)
    removed = outcome.removed
    assert removed["hours"] == 1 and removed["rawObjects"] == 1 and removed["parquetFiles"] == 1
    assert removed["quarantineObjects"] == 1
    assert removed["datasetRows"] == 3 and removed["artefactVersions"] == 1
    assert removed["trainingRuns"] == 1 and removed["evaluations"] == 1
    assert removed["experimentResultRuns"] == 1 and removed["publishedPointerHistory"] == 1
    keys = _keys(storage)
    old_hour = partition_prefix(OLD)
    assert not any(key.startswith(old_hour) for key in keys)  # raw, Parquet and manifest
    assert not any(key.startswith("events-quarantine/") for key in keys)
    frames, _, _ = read_events(str(tmp_path))
    assert sum(f.height for f in frames) == 3  # only the recent hour's events
    for name, column in (
        ("playback", "received_at"),
        ("profiles", "last_seen"),
        ("accounts", "state_at"),
    ):
        frame = pl.read_parquet(
            io.BytesIO(storage.get(f"recs-work/datasets/d1/{name}.parquet") or b"")
        )
        assert frame[column].to_list() == [RECENT]
    assert not any(key.startswith("recs-work/runs/20230101") for key in keys)
    assert any(key.startswith("recs-work/runs/20261101") for key in keys)
    assert "experiments/results/r=20230101-000000-000/k.json" not in keys
    assert not any(key.startswith("recs/v=20250101") for key in keys)
    assert any(key.startswith("recs/v=20250102") for key in keys)  # published: kept
    record = get_json(storage, RECORD_KEY) or {}
    assert record["done"] and record["eventsCutoff"] == iso_ms(NOW - 396 * DAY_MS)
    # A rerun finds nothing more.
    again = retain(str(tmp_path), periods=PERIODS, now_ms=NOW, log=lambda _: None)
    assert sum(again.removed.values()) == 0


def test_a_dry_run_deletes_nothing(tmp_path: Path) -> None:
    storage = _store(tmp_path)
    before = _keys(storage)
    outcome = retain(str(tmp_path), periods=PERIODS, now_ms=NOW, dry_run=True, log=lambda _: None)
    assert outcome.removed["hours"] == 1 and outcome.dry_run
    assert _keys(storage) == before


def test_a_run_stopped_half_way_is_finished_by_the_next(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _store(tmp_path)
    real = LocalStorage.delete
    calls = {"n": 0}

    def failing(self: LocalStorage, keys: Any) -> None:
        calls["n"] += 1
        if calls["n"] == 2:  # after the manifest, before the Parquet file
            raise OSError("store unavailable")
        real(self, keys)

    monkeypatch.setattr(LocalStorage, "delete", failing)
    with pytest.raises(OSError, match="store unavailable"):
        retain(str(tmp_path), periods=PERIODS, now_ms=NOW, log=lambda _: None)
    monkeypatch.setattr(LocalStorage, "delete", real)
    assert (get_json(storage, RECORD_KEY) or {})["done"] is False  # the plan was written first
    retain(str(tmp_path), periods=PERIODS, now_ms=NOW, log=lambda _: None)
    assert not any(key.startswith(partition_prefix(OLD)) for key in _keys(storage))


def test_the_periods_come_from_the_products_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    assert Periods.from_environment({}) == Periods(396, 1126)
    assert Periods.from_environment({"WEBFLIX_EVENTS_RETENTION_DAYS": "30"}).events_days == 30
    with pytest.raises(RetentionConfigError, match="positive integer"):
        Periods.from_environment({"WEBFLIX_AGGREGATES_RETENTION_DAYS": "0"})
    _store(tmp_path)
    monkeypatch.setenv("WEBFLIX_EVENTS_RETENTION_DAYS", "abc")
    with pytest.raises(SystemExit) as stop:
        cli.main(["--store", str(tmp_path), "retain", "--now", iso_ms(NOW)])
    assert stop.value.code == 2
    monkeypatch.setenv("WEBFLIX_EVENTS_RETENTION_DAYS", "396")
    cli.main(["--store", str(tmp_path), "retain", "--now", iso_ms(NOW)])
    summary = orjson.loads(capsys.readouterr().out)
    assert summary["removed"]["hours"] == 1 and summary["lakeLease"] == "held"
    lease.acquire(LocalStorage(tmp_path), "compact")
    with pytest.raises(SystemExit) as stop:
        cli.main(["--store", str(tmp_path), "retain", "--now", iso_ms(NOW)])
    assert stop.value.code == cli.EXIT_LAKE_BUSY
