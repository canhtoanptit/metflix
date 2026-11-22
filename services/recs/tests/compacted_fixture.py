"""Builds tests/fixtures/compacted: compacted lake hours, produced by this pipeline's compactor,
for the product's data export to test its reader against (services/recs/README.md, "Compacted
hours: the contract for readers").

    services/recs/.venv/bin/python services/recs/tests/compacted_fixture.py   # rewrite them

The events are real: the objects of tests/fixtures/ingested, written by the product's lake
writer through the dev API. Layout of the fixture (`store/` mirrors blob keys as paths):

* `store/events/dt=2026-11-22/hh=07/`: the 13 writer objects, compacted (sources kept, as the
  default `compact` leaves them: the reader must not read them again), with row groups of 16
  rows so that row-group skipping is visible on a small hour; plus one straggler written after
  compaction (a retried client batch repeating an event the Parquet file already holds, and a
  playback event that arrived late through the outbox), which the reader must read and
  deduplicate.
* `store/events/dt=2026-11-22/hh=08/`: an hour not compacted yet (raw objects only).
* `expected.json`: per account, the event ids an export must return; per hour, which objects
  to read, which to skip, and which row groups a reader of each account cannot skip.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import shutil
import sys
from pathlib import Path
from typing import Any

import orjson
import polars as pl

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

from webflix_recs import lake  # noqa: E402
from webflix_recs.ids import parse_iso_ms  # noqa: E402
from webflix_recs.storage import LocalStorage  # noqa: E402

INGESTED = HERE / "fixtures" / "ingested"
TARGET = HERE / "fixtures" / "compacted"
HOUR = "events/dt=2026-11-22/hh=07/"
NEXT_HOUR = "events/dt=2026-11-22/hh=08/"
ROW_GROUP_ROWS = 16
COMPACTED_AT_MS = parse_iso_ms("2026-11-22T08:20:00.000Z")


def _derived_id(event_id: str, salt: str) -> str:
    """Another UUIDv7 with the same timestamp, random bits from a hash (deterministic)."""
    digest = hashlib.sha256(f"{event_id}:{salt}".encode()).hexdigest()
    return f"{event_id[:8]}-{event_id[9:13]}-7{digest[:3]}-8{digest[3:6]}-{digest[6:18]}"


def _line(event: dict[str, Any]) -> bytes:
    # JSON.stringify's output: compact, keys in insertion order (orjson does the same).
    return orjson.dumps(event)


def _put_raw(storage: LocalStorage, key: str, events: list[dict[str, Any]]) -> None:
    storage.put(key, gzip.compress(b"\n".join(_line(e) for e in events) + b"\n", mtime=0))


def build(target: Path = TARGET) -> dict[str, Any]:
    if target.exists():
        shutil.rmtree(target)
    work = target.parent / f".{target.name}-work"
    if work.exists():
        shutil.rmtree(work)
    storage = LocalStorage(work)
    manifest = json.loads((INGESTED / "manifest.json").read_text())
    events: list[dict[str, Any]] = []
    for entry in manifest["objects"]:
        body = (INGESTED / entry["file"]).read_bytes()
        storage.put(entry["key"], body)
        events.extend(orjson.loads(line) for line in gzip.decompress(body).splitlines() if line)
    original = lake.ROW_GROUP_ROWS
    lake.ROW_GROUP_ROWS = ROW_GROUP_ROWS
    try:
        lake.compact(
            str(work),
            now_ms=COMPACTED_AT_MS,
            clock_ms=COMPACTED_AT_MS,
            take_lease=False,
        )
    finally:
        lake.ROW_GROUP_ROWS = original
    covered = sorted(entry["key"] for entry in manifest["objects"])
    # The straggler: a client batch retried (same event, a later receipt) and a playback event
    # drained late from the outbox (a new event of another account).
    demo = next(e for e in events if e["type"] == "impression" and e["subject"]["account"])
    retried = {**demo, "receivedAt": "2026-11-22T07:40:00.000Z"}
    other = next(e for e in events if e["type"] == "playback.progress")
    late = {
        **other,
        "eventId": _derived_id(other["eventId"], "late"),
        "receivedAt": "2026-11-22T07:59:30.000Z",
    }
    straggler = f"{HOUR}01a2023f-0000-7000-8000-00000000a001.ndjson.gz"
    _put_raw(storage, straggler, [retried, late])
    # The next hour, not compacted: two events of the demo account.
    later = []
    for index, source in enumerate(
        [e for e in events if e["subject"]["account"] == demo["subject"]["account"]][:2]
    ):
        stamp = f"2026-11-22T08:0{index}:00.000Z"
        later.append(
            {
                **source,
                "eventId": _derived_id(source["eventId"], "next-hour"),
                "occurredAt": stamp,
                "receivedAt": stamp,
            }
        )
    next_key = f"{NEXT_HOUR}01a20250-0000-7000-8000-000000000001.ndjson.gz"
    _put_raw(storage, next_key, later)
    # Mirror the store as plain paths.
    store = target / "store"
    for info in storage.list():
        path = store / info.key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(storage.get(info.key) or b"")
    shutil.rmtree(work)
    expected = expectations(store, covered, straggler, next_key)
    (target / "expected.json").write_text(json.dumps(expected, indent=2) + "\n")
    return expected


def expectations(store: Path, covered: list[str], straggler: str, next_key: str) -> dict[str, Any]:
    compaction = json.loads((store / HOUR / lake.COMPACTION_MANIFEST).read_text())
    parquet = pl.read_parquet(io.BytesIO((store / compaction["parquet"]).read_bytes()))
    groups: list[dict[str, Any]] = []
    size = compaction["rowGroupRows"]
    for start in range(0, parquet.height, size):
        accounts = parquet["account"][start : start + size]
        present = sorted(str(value) for value in accounts.drop_nulls().to_list())
        groups.append(
            {
                "rows": accounts.len(),
                "min": present[0] if present else None,
                "max": present[-1] if present else None,
                "nulls": accounts.null_count(),
            }
        )
    by_account: dict[str, set[str]] = {}

    def add(raw: str) -> None:
        event = json.loads(raw)
        account = event["subject"]["account"]
        if account is not None:
            by_account.setdefault(account, set()).add(event["eventId"])

    for raw in parquet["raw"]:
        add(raw)
    for key in (straggler, next_key):
        for line in gzip.decompress((store / key).read_bytes()).splitlines():
            add(line.decode())
    readable = {
        account: [
            index
            for index, group in enumerate(groups)
            if group["min"] is not None and str(group["min"]) <= account <= str(group["max"])
        ]
        for account in by_account
    }
    return {
        "description": "What an export of each account must return from fixtures/compacted/store "
        "(services/recs/README.md, 'Compacted hours: the contract for readers').",
        "accounts": {
            account: {"eventIds": sorted(ids), "count": len(ids)}
            for account, ids in sorted(by_account.items())
        },
        "hours": {
            HOUR: {
                "compacted": True,
                "parquet": compaction["parquet"],
                "rowGroups": groups,
                "readRawObjects": [straggler],
                "skipRawObjects": covered,
                "rowGroupsAReaderOfThisAccountReads": readable,
                "duplicates": "the straggler repeats one event already in the Parquet file "
                "(same eventId, a later receipt): return it once",
            },
            NEXT_HOUR: {"compacted": False, "readRawObjects": [next_key], "skipRawObjects": []},
        },
    }


def format_json(target: Path = TARGET) -> None:
    """Lay the JSON files out as the repository's formatter (Biome) does, so `pnpm lint` stays
    clean; readers parse JSON, so only the layout changes."""
    import subprocess

    biome = HERE.parents[2] / "node_modules" / ".bin" / "biome"
    files = [str(path) for path in target.rglob("*.json")]
    if biome.exists() and files:
        subprocess.run([str(biome), "format", "--write", *files], check=True, capture_output=True)


if __name__ == "__main__":
    result = build()
    format_json()
    print(json.dumps({a: v["count"] for a, v in result["accounts"].items()}, indent=2))
