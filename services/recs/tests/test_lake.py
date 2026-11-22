"""The lake: NDJSON and compacted Parquet read alike; compaction idempotent; erasure."""

from __future__ import annotations

import gzip
from pathlib import Path

import orjson

from helpers import ANCHOR_MS, make_event, write_lake
from webflix_recs.ids import HOUR_MS
from webflix_recs.lake import compact, list_hours, read_events
from webflix_recs.storage import LocalStorage

T0 = ANCHOR_MS - 3 * 24 * HOUR_MS


def _events() -> list[dict[str, object]]:
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
    # NDJSON objects it covers are not read again.
    assert sorted(set(before)) == after
    second = compact(str(tmp_path), now_ms=ANCHOR_MS)
    assert second.hours_compacted == 0
    assert second.hours_unchanged == first.hours_compacted
    assert _ids(str(tmp_path)) == after


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
    hour = next(h for h in list_hours(storage) if h.hour_ms == T0 - T0 % HOUR_MS)
    assert len(hour.parquet) == 1  # the old file was replaced, not kept alongside
    assert late["eventId"] in _ids(str(tmp_path))


def test_invalid_lines_are_quarantined_and_erasure_drops_a_subject(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    events = _events()
    write_lake(storage, events, "a")
    prefix = "events/dt=" + "/".join(
        next(iter(list_hours(storage))).prefix.split("/")[1:3]
    ).removeprefix("dt=")
    storage.put(f"{prefix}/bad.ndjson.gz", gzip.compress(b'{"eventId": "nope"}\nnot json\n'))
    result = compact(
        str(tmp_path), now_ms=ANCHOR_MS, delete_sources=True, erase_accounts=["B" * 22]
    )
    assert result.invalid_quarantined == 2
    assert result.erased == 5
    assert not [i for i in storage.list("events/") if i.key.endswith(".ndjson.gz")]
    quarantined = [i.key for i in storage.list("events-quarantine/")]
    assert len(quarantined) == 1
    remaining = _ids(str(tmp_path))
    assert len(remaining) == 30
    body = gzip.decompress(storage.get(quarantined[0]) or b"")
    assert b"not json" in body
    assert all(orjson.loads(line) for line in body.splitlines()[:1])
