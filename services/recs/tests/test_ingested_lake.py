"""The lake as the TypeScript ingestion writes it is what this pipeline reads.

`fixtures/ingested/` holds real objects written by `createBlobLakeEventSink` through the dev
API (client batches, playback, consent, sign-in and sign-up server events; see its
`manifest.json`). Owned by the events area: if the writer and this reader ever disagree, this
test fails on the pipeline's side of the boundary.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import orjson

from webflix_recs.ids import pseudonym
from webflix_recs.lake import compact, list_hours, read_events
from webflix_recs.storage import LocalStorage

FIXTURE = Path(__file__).parent / "fixtures" / "ingested"


def test_objects_written_by_the_ingestion_consumer_are_read_and_compacted(
    tmp_path: Path,
) -> None:
    manifest = json.loads((FIXTURE / "manifest.json").read_text())
    storage = LocalStorage(tmp_path)
    expected: dict[str, int] = {}
    for entry in manifest["objects"]:
        body = (FIXTURE / entry["file"]).read_bytes()
        # Exactly the writer's format: gzip, one JSON event per line, newline-terminated.
        text = gzip.decompress(body)
        assert text.endswith(b"\n") and not text.endswith(b"\n\n")
        storage.put(entry["key"], body)
        for kind, count in entry["types"].items():
            expected[kind] = expected.get(kind, 0) + count

    hours = list_hours(storage)
    assert [len(hour.ndjson) for hour in hours] == [len(manifest["objects"])]
    frames, stats, n_hours = read_events(str(tmp_path))
    assert n_hours == 1
    assert stats.invalid == 0 and stats.unparseable == 0
    assert stats.valid == stats.lines == sum(expected.values())
    rows = [row for frame in frames for row in frame.iter_rows(named=True)]
    seen: dict[str, int] = {}
    for row in rows:
        seen[row["type"]] = seen.get(row["type"], 0) + 1
    assert seen == expected
    # The server stamped every subject; nothing restricted reached the lake.
    assert not any(row["restricted"] for row in rows)
    impressions = [r for r in rows if r["type"] == "impression" and r["account"]]
    assert impressions and all(r["ctx_row_rank"] and r["ctx_rank"] for r in impressions)
    assert all(r["ctx_policy"] for r in impressions)
    # The pseudonymous keys are the ones this pipeline derives (ids.pseudonym).
    demo = pseudonym(manifest["pseudonymKey"].encode(), "account", manifest["accountId"])
    assert any(row["account"] == demo for row in rows)
    # Server events carry the server platform and no sequence; client events a sequence.
    for entry in manifest["objects"]:
        for line in gzip.decompress((FIXTURE / entry["file"]).read_bytes()).splitlines():
            event = orjson.loads(line)
            assert (event["source"] == "server") == (event["sessionSeq"] is None)

    result = compact(str(tmp_path), now_ms=1_800_000_000_000)
    assert result.hours_compacted == 1
    assert result.invalid_quarantined == 0
    assert result.events_written == sum(expected.values())
