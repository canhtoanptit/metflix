"""`export-events`: each request gets its member's events exactly as stored, once each, in
receipt order, from compacted hours and stragglers without reading anything twice; erased
subjects get nothing; reruns are safe; erasure removes the outputs."""

from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import orjson
import pytest

from helpers import ANCHOR_MS, make_event, write_lake
from webflix_recs import cli, exports, lease, schemas
from webflix_recs.erasure import erase
from webflix_recs.exports import EXPORT_PREFIX, ExportRequest, export_events, parse_requests
from webflix_recs.ids import HOUR_MS, iso_ms, parse_iso_ms
from webflix_recs.lake import compact
from webflix_recs.storage import LocalStorage, get_json

FIXTURE = Path(__file__).parent / "fixtures" / "compacted"
A, PA = "A" * 22, "a" * 22
B, PB = "B" * 22, "b" * 22
H0 = ANCHOR_MS - 2 * 24 * HOUR_MS  # hour-aligned


def _lines(storage: LocalStorage, request_id: str) -> list[bytes]:
    body = storage.get(f"{EXPORT_PREFIX}{request_id}/events.ndjson.gz") or b""
    return gzip.decompress(body).splitlines()


def test_the_fixture_exports_are_what_the_contract_expects(tmp_path: Path) -> None:
    """The compacted-hour fixtures (real writer objects): the job returns exactly the events the
    data export must, each line as the writer stored it."""
    storage = LocalStorage(tmp_path)
    store = FIXTURE / "store"
    stored_lines: set[bytes] = set()
    for path in sorted(p for p in store.rglob("*") if p.is_file()):
        key = str(path.relative_to(store))
        storage.put(key, path.read_bytes())
        if key.endswith(".ndjson.gz"):
            stored_lines |= set(gzip.decompress(path.read_bytes()).splitlines())
    expected = json.loads((FIXTURE / "expected.json").read_text())
    requests = [
        ExportRequest(
            f"req-{i}",
            account,
            parse_iso_ms("2026-11-22T00:00:00.000Z"),
            parse_iso_ms("2026-11-23T00:00:00.000Z"),
        )
        for i, account in enumerate(sorted(expected["accounts"]))
    ]
    outcome = export_events(
        str(tmp_path), requests, now_ms=parse_iso_ms("2026-11-23T01:00:00.000Z"), log=lambda _: None
    )
    # One Parquet file and the two uncovered raw objects: the 13 covered objects not read.
    assert outcome.objects_read == 3
    for request, result in zip(requests, outcome.results, strict=True):
        assert result["status"] == "complete"
        lines = _lines(storage, request.request_id)
        events = [orjson.loads(line) for line in lines]
        assert (
            sorted(e["eventId"] for e in events)
            == expected["accounts"][request.account]["eventIds"]
        )
        assert [e["receivedAt"] for e in events] == sorted(e["receivedAt"] for e in events)
        assert all(line in stored_lines for line in lines)  # exactly as stored
        manifest: dict[str, Any] = get_json(storage, request.manifest_key) or {}
        schemas.validate("export-events-manifest", manifest)
        assert manifest["events"] == len(lines) == result["events"]
        body = storage.get(request.events_key) or b""
        assert manifest["sha256"] == hashlib.sha256(body).hexdigest() == result["sha256"]
    schemas.validate("export-events-results", outcome.document(ANCHOR_MS))


def _lake(root: Path) -> LocalStorage:
    storage = LocalStorage(root)
    events = [make_event("title.open", H0 + i * 60_000, account=A, profile=PA) for i in range(5)]
    events += [
        make_event("title.open", H0 + i * 60_000 + 9, account=B, profile=PB) for i in range(3)
    ]
    write_lake(storage, events, "a")
    compact(str(root), now_ms=H0 + 2 * HOUR_MS)  # hour 0 compacted, its sources kept
    # A client retry of an A event landing in the same hour after compaction (same id, a later
    # receipt), and a new late event of A.
    retried = {**events[1], "receivedAt": iso_ms(H0 + 50 * 60_000)}
    write_lake(
        storage,
        [retried, make_event("title.open", H0 + 51 * 60_000, account=A, profile=PA)],
        "late",
    )
    # Hour 1 (not compacted) and hour 3 (outside the first request's window).
    write_lake(
        storage, [make_event("playback.start", H0 + HOUR_MS + 5, account=A, profile=PA)], "h1"
    )
    write_lake(
        storage, [make_event("title.open", H0 + 3 * HOUR_MS + 5, account=A, profile=PA)], "h3"
    )
    return storage


def test_windows_duplicates_other_members_and_deferral(tmp_path: Path) -> None:
    storage = _lake(tmp_path)
    now = H0 + 5 * HOUR_MS
    requests = [
        ExportRequest("r-a", A, H0, H0 + 2 * HOUR_MS),
        ExportRequest("r-b", B, H0, H0 + HOUR_MS),
        ExportRequest("r-late", A, H0, now - 5 * 60_000),  # its window ended 5 minutes ago
    ]
    outcome = export_events(str(tmp_path), requests, now_ms=now, log=lambda _: None)
    statuses = {r["requestId"]: r["status"] for r in outcome.results}
    assert statuses == {"r-a": "complete", "r-b": "complete", "r-late": "deferred"}
    a = [orjson.loads(line) for line in _lines(storage, "r-a")]
    # 5 compacted + 1 late in hour 0 (the retry once, at its earliest receipt) + 1 in hour 1.
    assert len(a) == 7 and len({e["eventId"] for e in a}) == 7
    assert all(e["subject"]["account"] == A for e in a)
    assert all(H0 <= parse_iso_ms(e["receivedAt"]) < H0 + 2 * HOUR_MS for e in a)
    b = [orjson.loads(line) for line in _lines(storage, "r-b")]
    assert len(b) == 3 and all(e["subject"]["account"] == B for e in b)
    assert storage.get(f"{EXPORT_PREFIX}r-late/manifest.json") is None
    assert outcome.results[2]["notBefore"] == iso_ms(now - 5 * 60_000 + 15 * 60_000)


def test_an_erased_subject_yields_nothing(tmp_path: Path) -> None:
    storage = _lake(tmp_path)
    now = H0 + 5 * HOUR_MS
    request = ExportRequest("r-a", A, H0, H0 + 2 * HOUR_MS)
    export_events(str(tmp_path), [request], now_ms=now, log=lambda _: None)
    assert storage.get(request.manifest_key) is not None
    # Its erasure is pending in the product: nothing, and the earlier output goes.
    outcome = export_events(str(tmp_path), [request], erased=[A], now_ms=now, log=lambda _: None)
    assert outcome.results[0]["status"] == "erased"
    assert list(storage.list(f"{EXPORT_PREFIX}r-a/")) == []
    # Or the erasure already ran (the plan holds the key while it is watched).
    erase(str(tmp_path), [B], now_ms=now, log=lambda _: None)
    outcome = export_events(
        str(tmp_path), [ExportRequest("r-b", B, H0, H0 + HOUR_MS)], now_ms=now, log=lambda _: None
    )
    assert outcome.results[0]["status"] == "erased"


def test_a_rerun_after_a_failure_half_way_completes_and_a_complete_one_is_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _lake(tmp_path)
    now = H0 + 5 * HOUR_MS
    requests = [
        ExportRequest("r-a", A, H0, H0 + 2 * HOUR_MS),
        ExportRequest("r-b", B, H0, H0 + HOUR_MS),
    ]
    real = exports.put_json
    calls = {"n": 0}

    def failing(store: Any, key: str, document: object) -> Any:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("store unavailable")
        return real(store, key, document)

    monkeypatch.setattr(exports, "put_json", failing)
    first = export_events(str(tmp_path), requests, now_ms=now, log=lambda _: None)
    # The first request failed between its events file and its manifest; the other completed.
    assert [r["status"] for r in first.results] == ["failed", "complete"]
    assert storage.get(requests[0].events_key) is not None
    assert storage.get(requests[0].manifest_key) is None
    monkeypatch.setattr(exports, "put_json", real)
    second = export_events(str(tmp_path), requests, now_ms=now + 1, log=lambda _: None)
    assert [r["status"] for r in second.results] == ["complete", "complete"]
    assert [r["reused"] for r in second.results] == [False, True]
    body = storage.get(requests[0].events_key)
    third = export_events(str(tmp_path), requests, now_ms=now + 2, log=lambda _: None)
    assert all(r["reused"] for r in third.results) and third.objects_read == 0
    forced = export_events(str(tmp_path), requests, now_ms=now + 3, force=True, log=lambda _: None)
    assert not forced.results[0]["reused"] and storage.get(requests[0].events_key) == body


def test_erasure_removes_an_export_of_the_subject(tmp_path: Path) -> None:
    storage = _lake(tmp_path)
    now = H0 + 5 * HOUR_MS
    export_events(
        str(tmp_path),
        [ExportRequest("r-a", A, H0, H0 + 2 * HOUR_MS), ExportRequest("r-b", B, H0, H0 + HOUR_MS)],
        now_ms=now,
        log=lambda _: None,
    )
    outcome = erase(str(tmp_path), [A], now_ms=now, log=lambda _: None)
    assert outcome.counts["exports.deleted"] == 1
    assert list(storage.list(f"{EXPORT_PREFIX}r-a/")) == []
    assert storage.get(f"{EXPORT_PREFIX}r-b/manifest.json") is not None


def test_outputs_are_pruned_after_the_keep_period(tmp_path: Path) -> None:
    storage = _lake(tmp_path)
    now = H0 + 5 * HOUR_MS
    request = ExportRequest("r-a", A, H0, H0 + 2 * HOUR_MS)
    export_events(str(tmp_path), [request], now_ms=now, log=lambda _: None)
    later = export_events(str(tmp_path), [], now_ms=now + 8 * 24 * HOUR_MS, log=lambda _: None)
    assert later.pruned == 1 and storage.get(request.manifest_key) is None


def test_malformed_requests_are_refused() -> None:
    with pytest.raises(ValueError, match="after"):
        parse_requests(
            {
                "requests": [
                    {"requestId": "r", "accountKey": A, "from": iso_ms(H0), "to": iso_ms(H0)}
                ]
            }
        )
    with pytest.raises(schemas.SchemaError):
        parse_requests(
            {
                "requests": [
                    {"requestId": "../x", "accountKey": A, "from": iso_ms(H0), "to": iso_ms(H0 + 1)}
                ]
            }
        )


def test_the_command_writes_the_results_for_the_product(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    store = tmp_path / "store"
    storage = _lake(store)
    requests = tmp_path / "requests.json"
    requests.write_bytes(
        orjson.dumps(
            {
                "requests": [
                    {
                        "requestId": "r-a",
                        "accountKey": A,
                        "from": iso_ms(H0),
                        "to": iso_ms(H0 + 2 * HOUR_MS),
                    }
                ]
            }
        )
    )
    results = tmp_path / "results.json"
    args = [
        "--store", str(store), "--workers", "1", "export-events", "--requests", str(requests),
        "--results", str(results), "--now", iso_ms(H0 + 5 * HOUR_MS),
    ]  # fmt: skip
    cli.main(args)
    summary = orjson.loads(capsys.readouterr().out)
    assert summary["statuses"] == {"complete": 1}
    document = orjson.loads(results.read_bytes())
    schemas.validate("export-events-results", document)
    assert document["results"][0]["events"] == 7
    # Exports and erasures never interleave: the lake lease.
    lease.acquire(storage, "erase")
    with pytest.raises(SystemExit) as stop:
        cli.main(args)
    assert stop.value.code == cli.EXIT_LAKE_BUSY


def test_a_window_that_is_not_hour_aligned_is_exact(tmp_path: Path) -> None:
    storage = _lake(tmp_path)
    request = ExportRequest("r-mid", A, H0 + 30 * 60_000, H0 + HOUR_MS + 60_000)
    export_events(str(tmp_path), [request], now_ms=H0 + 5 * HOUR_MS, log=lambda _: None)
    received = [orjson.loads(line)["receivedAt"] for line in _lines(storage, "r-mid")]
    # The retried copy (received at :50), the late event (:51) and hour 1's event; not the
    # compacted ones received in the first minutes.
    assert len(received) == 3
    assert all(iso_ms(request.from_ms) <= r < iso_ms(request.to_ms) for r in received)


def test_an_unbounded_window_exports_everything_still_held(tmp_path: Path) -> None:
    """The product asks from 1970-01-01 (retention, not the request, bounds an export): every
    event of the account still in the lake comes back, an hour 500 days old included, and the
    lake is listed once, not walked hour by hour from 1970."""
    storage = _lake(tmp_path)
    old = H0 - 500 * 24 * HOUR_MS
    write_lake(storage, [make_event("title.open", old + 7, account=A, profile=PA)], "old")
    now = H0 + 5 * HOUR_MS
    (request,) = parse_requests(
        {
            "requests": [
                {
                    "requestId": "r-all",
                    "accountKey": A,
                    "from": "1970-01-01T00:00:00.000Z",
                    "to": iso_ms(now - HOUR_MS),
                }
            ]
        }
    )
    outcome = export_events(str(tmp_path), [request], now_ms=now, log=lambda _: None)
    assert outcome.results[0]["status"] == "complete"
    events = [orjson.loads(line) for line in _lines(storage, "r-all")]
    # 7 in hours 0 and 1 (as above), 1 in hour 3, 1 from 500 days before.
    assert len(events) == 9 and old <= parse_iso_ms(events[0]["receivedAt"]) < old + HOUR_MS
    assert outcome.hours == 4
