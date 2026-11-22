"""The lake: raw objects and compacted hours read alike; compaction format 2, idempotent, safe
under stragglers, concurrent rewrites and older (version 1) compacted hours."""

from __future__ import annotations

import gzip
import io
from pathlib import Path
from typing import Any

import orjson
import polars as pl
import pytest

from helpers import ANCHOR_MS, make_event, write_lake
from webflix_recs import lake, schemas
from webflix_recs.ids import HOUR_MS, iso_ms, partition_prefix
from webflix_recs.lake import (
    COMPACTION_MANIFEST,
    LakeReadError,
    compact,
    list_hours,
    read_events,
    read_hour_lines,
)
from webflix_recs.storage import LocalStorage, ObjectInfo, get_json, put_json

T0 = ANCHOR_MS - 3 * 24 * HOUR_MS
HOUR = T0 - T0 % HOUR_MS


def _events() -> list[dict[str, Any]]:
    events = [make_event("impression", T0 + i * 60_000, title=f"t-{i % 5}") for i in range(30)]
    events += [
        make_event(
            "playback.start", T0 + i * 600_000, title=f"t-{i}", account="B" * 22, profile="Q" * 22
        )
        for i in range(5)
    ]
    return events


def _ids(location: str) -> list[str]:
    frames, _, _ = read_events(location)
    return sorted(id_ for frame in frames for id_ in frame["event_id"].to_list())


def _manifest(storage: LocalStorage, hour_ms: int = HOUR) -> dict[str, Any]:
    document = get_json(storage, partition_prefix(hour_ms) + COMPACTION_MANIFEST)
    assert isinstance(document, dict)
    return document


def test_compaction_is_lossless_and_idempotent(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    events = _events()
    write_lake(storage, events, "a")
    write_lake(storage, events[:5], "b")  # redelivered duplicates in their own objects
    before = _ids(str(tmp_path))
    assert len(before) == len(events) + 5
    first = compact(str(tmp_path), now_ms=ANCHOR_MS)
    assert first.hours_compacted >= 1
    assert first.duplicates_dropped == 5
    after = _ids(str(tmp_path))
    # Reading after compaction yields each event once (the Parquet file, deduplicated), and the
    # raw objects it covers are not read again.
    assert sorted(set(before)) == after
    second = compact(str(tmp_path), now_ms=ANCHOR_MS)
    assert second.hours_compacted == 0
    assert second.hours_unchanged == first.hours_compacted
    assert _ids(str(tmp_path)) == after


def test_the_compacted_hour_follows_format_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(lake, "ROW_GROUP_ROWS", 4)
    storage = LocalStorage(tmp_path)
    accounts = [chr(ord("a") + i) * 22 for i in range(6)]
    events = [
        make_event("title.open", T0 + i * 30_000, account=accounts[i % 6], title=f"t-{i}")
        for i in range(24)
    ]
    events.append(make_event("title.open", T0 + 5, account="b" * 22, profile=None))
    # Signed out: no account (and the line keeps its exact bytes, spacing included).
    anonymous = make_event("title.open", T0 + 7, profile=None)
    anonymous["subject"]["account"] = None
    schemas.validate_event(anonymous)
    write_lake(storage, events, "a")
    prefix = partition_prefix(HOUR)
    odd_line = orjson.dumps(anonymous, option=orjson.OPT_INDENT_2).replace(b"\n", b"")
    storage.put(f"{prefix}0190-odd.ndjson.gz", gzip.compress(odd_line + b"\n"))
    compact(str(tmp_path), now_ms=ANCHOR_MS)
    manifest = _manifest(storage)
    schemas.validate("events-compaction", manifest)
    assert manifest["formatVersion"] == 2
    assert manifest["rows"] == len(events) + 1
    assert "erase" not in manifest
    assert {source["key"] for source in manifest["sources"]} == {
        f"{prefix}a.ndjson.gz",
        f"{prefix}0190-odd.ndjson.gz",
    }
    body = storage.get(manifest["parquet"]) or b""
    assert manifest["parquetBytes"] == len(body)
    frame = pl.read_parquet(io.BytesIO(body))
    assert frame.columns == [name for name, _ in lake.COMPACTED_COLUMNS]
    # Sorted by account (signed-out rows last), then receipt, then event id.
    keys = [(a is None, a or "", r, e) for a, r, e in frame.select(
        "account", "received_at", "event_id").iter_rows()]  # fmt: skip
    assert keys == sorted(keys)
    assert frame["account"][-1] is None
    # `raw` is the line exactly as stored (not a re-serialisation).
    row = frame.filter(pl.col("event_id") == anonymous["eventId"])
    assert row["raw"][0] == odd_line.decode()
    assert manifest["rowGroups"] == (manifest["rows"] + 3) // 4
    assert manifest["compression"] == "SNAPPY"
    # Row-group statistics and skipping are checked with the product's own reader (hyparquet)
    # on the committed fixtures: tests/test_compacted_fixture.py.


def test_stragglers_after_compaction_are_read_and_folded_in(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    events = _events()
    write_lake(storage, events, "a")
    compact(str(tmp_path), now_ms=ANCHOR_MS)
    late = make_event("title.open", T0 + 5_000)
    write_lake(storage, [late], "straggler")
    assert late["eventId"] in _ids(str(tmp_path))
    result = compact(str(tmp_path), now_ms=ANCHOR_MS)
    assert result.hours_compacted == 1
    hour = next(h for h in list_hours(storage) if h.hour_ms == HOUR)
    assert len(hour.parquet) == 1  # the old file was replaced, not kept alongside
    assert late["eventId"] in _ids(str(tmp_path))


def test_late_playback_from_the_outbox_lands_in_a_compacted_hour(tmp_path: Path) -> None:
    """Playback events reach the lake through an outbox, up to minutes after their receipt: an
    outbox drain (up to 100 events of many members, one object) can land in an hour that was
    already compacted, and the same drain can be written twice."""
    storage = LocalStorage(tmp_path)
    base = _events()
    write_lake(storage, base, "a")
    compact(str(tmp_path), now_ms=HOUR + HOUR_MS + 15 * 60_000)
    drain = [
        make_event(
            kind,
            HOUR + HOUR_MS - 60_000 + i,
            account=chr(ord("c") + i % 3) * 22,
            profile=chr(ord("k") + i % 3) * 22,
            title=f"t-{i % 4}",
        )
        for i, kind in enumerate(["playback.progress", "playback.complete", "playback.abandon"] * 4)
    ]
    write_lake(storage, drain, "outbox-1")
    write_lake(storage, drain, "outbox-1-again")  # drained twice: at least once
    ids = _ids(str(tmp_path))
    # Read before the next compaction: the compacted rows plus both copies of the drain (readers
    # deduplicate by eventId); nothing hidden.
    assert set(ids) == {e["eventId"] for e in base + drain}
    assert len(ids) == len(base) + 2 * len(drain)
    result = compact(str(tmp_path), now_ms=HOUR + 2 * HOUR_MS)
    assert result.duplicates_dropped == len(drain)
    assert _ids(str(tmp_path)) == sorted(set(ids))
    assert _manifest(storage)["rows"] == len(set(ids))


def test_compaction_waits_for_the_grace_period(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    write_lake(storage, [make_event("title.open", HOUR + 1_000)])
    early = compact(str(tmp_path), now_ms=HOUR + HOUR_MS + 10 * 60_000)
    assert early.hours_open == 1 and early.hours_compacted == 0
    late = compact(str(tmp_path), now_ms=HOUR + HOUR_MS + 15 * 60_000)
    assert late.hours_compacted == 1


def test_delete_sources_only_after_the_manifest_covers_them(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    write_lake(storage, _events(), "a")
    compact(str(tmp_path), now_ms=ANCHOR_MS)  # without deleting
    write_lake(storage, [make_event("title.open", T0 + 9)], "late")
    result = compact(str(tmp_path), now_ms=ANCHOR_MS, delete_sources=True)
    assert result.sources_deleted == 2
    assert not [i for i in storage.list("events/") if i.key.endswith(".ndjson.gz")]
    assert len(_ids(str(tmp_path))) == len(_events()) + 1


def test_a_version_1_hour_is_read_and_rewritten_as_version_2(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    events = _events()
    write_lake(storage, events, "a")
    prefix = partition_prefix(HOUR)
    # What the previous compactor left: zstd, receipt order, re-serialised `raw`, an erase list.
    old = pl.DataFrame(
        {
            "event_id": [e["eventId"] for e in events],
            "account": [e["subject"]["account"] for e in events],
            "profile": [e["subject"]["profile"] for e in events],
            "restricted": [False for _ in events],
            "raw": [orjson.dumps(e).decode() for e in events],
        }
    )
    buffer = io.BytesIO()
    old.write_parquet(buffer, compression="zstd")
    storage.put(f"{prefix}part-0123456789abcdef.parquet", buffer.getvalue())
    put_json(
        storage,
        prefix + COMPACTION_MANIFEST,
        {
            "format": "webflix.events-compaction",
            "formatVersion": 1,
            "hour": iso_ms(HOUR),
            "parquet": f"{prefix}part-0123456789abcdef.parquet",
            "erase": ["Z" * 22],
            "sources": [{"key": f"{prefix}a.ndjson.gz", "size": 1, "etag": "x"}],
        },
    )
    storage.delete([f"{prefix}a.ndjson.gz"])  # it had deleted its sources
    assert len(_ids(str(tmp_path))) == len(events)
    result = compact(str(tmp_path), now_ms=ANCHOR_MS)
    assert result.hours_upgraded == 1
    manifest = _manifest(storage)
    assert manifest["formatVersion"] == 2 and "erase" not in manifest
    assert len(_ids(str(tmp_path))) == len(events)
    assert len(next(h for h in list_hours(storage) if h.hour_ms == HOUR).parquet) == 1


def test_an_unknown_manifest_version_is_an_error_not_a_silent_gap(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    write_lake(storage, _events(), "a")
    put_json(
        storage,
        partition_prefix(HOUR) + COMPACTION_MANIFEST,
        {"format": "webflix.events-compaction", "formatVersion": 3, "parquet": "x"},
    )
    with pytest.raises(LakeReadError, match="format version 3"):
        _ids(str(tmp_path))


class RewritingStorage(LocalStorage):
    """Recompacts the hour (with deletion of sources) right after a reader first fetched the
    manifest: the race between a reader and a concurrent compaction."""

    def __init__(self, root: Path) -> None:
        super().__init__(root)
        self.armed = False

    def get(self, key: str) -> bytes | None:
        body = super().get(key)
        if self.armed and key.endswith(COMPACTION_MANIFEST):
            self.armed = False
            compact(str(self.root), now_ms=ANCHOR_MS, delete_sources=True, take_lease=False)
        return body


def test_a_reader_racing_a_rewrite_starts_the_hour_again(tmp_path: Path) -> None:
    storage = RewritingStorage(tmp_path)
    events = _events()
    write_lake(storage, events, "a")
    compact(str(tmp_path), now_ms=ANCHOR_MS)
    late = [make_event("title.open", T0 + 11 + i) for i in range(3)]
    write_lake(storage, late, "late")
    hour = next(h for h in list_hours(storage) if h.hour_ms == HOUR)
    storage.armed = True
    lines, stats = read_hour_lines(storage, hour)
    # The first attempt found the old Parquet file or the straggler gone; the second read the
    # new state. Nothing missing, nothing twice.
    ids = sorted(orjson.loads(line)["eventId"] for line in lines)
    assert ids == sorted(e["eventId"] for e in events + late)
    assert stats.valid == len(ids)


def test_invalid_lines_are_quarantined_once(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    write_lake(storage, _events(), "a")
    prefix = partition_prefix(HOUR)
    storage.put(f"{prefix}bad.ndjson.gz", gzip.compress(b'{"eventId": "nope"}\nnot json\n'))
    result = compact(str(tmp_path), now_ms=ANCHOR_MS, delete_sources=True)
    assert result.invalid_quarantined == 2
    assert not [i for i in storage.list("events/") if i.key.endswith(".ndjson.gz")]
    quarantined = [i.key for i in storage.list("events-quarantine/")]
    assert len(quarantined) == 1
    assert len(_ids(str(tmp_path))) == len(_events())
    body = gzip.decompress(storage.get(quarantined[0]) or b"")
    assert b"not json" in body
    again = compact(str(tmp_path), now_ms=ANCHOR_MS)
    assert again.invalid_quarantined == 0
    assert len(list(storage.list("events-quarantine/"))) == 1


def test_the_hour_listing_ignores_deeper_keys(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    write_lake(storage, _events(), "a")
    storage.put(partition_prefix(HOUR) + "nested/x.ndjson.gz", gzip.compress(b"{}\n"))
    (hour,) = list_hours(storage)
    assert [info.key.rsplit("/", 1)[-1] for info in hour.ndjson] == ["a.ndjson.gz"]
    assert isinstance(hour.ndjson[0], ObjectInfo)
