"""`export-events`: the events part of members' data exports, as a batch job against the store.

"Download your data" includes every lake event of the member's account within the raw retention
window (13 months). Read inside one request of the product that is roughly 9,500 hour partitions
before a single row, far beyond a Cloudflare Worker's subrequest and CPU limits, so in a
deployed mode the product records the request and this job does the reading, on the pattern of
`erase` (services/recs/README.md, "Exports of members' events"):

1. **Requests**: a file holding `{"requests": [{"requestId", "accountKey", "from", "to"}]}` (the
   answer the product's operator route is expected to give, see the README), one per pending
   export: the request id, the account's pseudonymous key and the receipt window `[from, to)`.
2. **Deferral**: a request whose window ends less than the grace period ago (15 minutes,
   longer than the outbox's scheduler tick) is reported `deferred`: events received before `to`
   may not have reached the lake yet.
3. **Erased subjects yield nothing**: a key whose erasure is pending or watched (the erasure plan,
   and with `--erasures` the staff API's pending list or a file) is reported `erased`, and any
   output of that request is deleted.
4. **One pass for every request**: each hour partition any window touches is read once, by the
   readers' rule (lake.snapshot_hour: the current Parquet file and the raw objects it does not
   cover, nothing twice, a consistent state); Parquet files are scanned with a filter on
   `account`, so row groups whose statistics exclude every requested key are not decoded; raw
   objects are parsed only where a key occurs.
5. **Output**, per request, under the private prefix the product's documents use:
   `privacy/export-events/{requestId}/events.ndjson.gz` (the member's events exactly as stored,
   one per line, deduplicated by `eventId` keeping the earliest receipt, ordered by receipt then
   id; gzip without a timestamp, so the same lake gives the same bytes) and then
   `privacy/export-events/{requestId}/manifest.json` (written last: its presence means the
   events file is complete).
6. **Results**: one entry per request (`complete`, `erased`, `deferred`, `failed`) for the
   product to record (README: the confirmation shape).

Safe to rerun: a request whose manifest exists for the same account and window, with an events
file of the recorded size and SHA-256, is reported complete again without rewriting; a run that
failed between the events file and the manifest writes both again. Outputs older than
`keep_days` (7) are pruned: the product folds them into its export document and deletes them;
this is the backstop. The job holds the lake lease (lease.py) so an erasure never interleaves
with it.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import re
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

import orjson
import polars as pl

from webflix_recs import schemas
from webflix_recs.ids import DAY_MS, HOUR_MS, iso_ms, parse_iso_ms
from webflix_recs.lake import list_hours, relist_hour, snapshot_hour
from webflix_recs.parallel import parallel_map
from webflix_recs.storage import Storage, get_json, open_storage, put_json

EXPORT_PREFIX = "privacy/export-events/"
DEFAULT_GRACE_MS = 15 * 60_000
DEFAULT_KEEP_DAYS = 7
#: The product's private document names (packages/core/src/ports/event-sink.ts).
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SUBJECT_KEY = re.compile(r"^[A-Za-z0-9_-]{22}$")
_SUBJECT_SCHEMA = {"subject": pl.Struct({"account": pl.String})}


@dataclass(frozen=True)
class ExportRequest:
    request_id: str
    account: str
    from_ms: int
    to_ms: int

    @property
    def events_key(self) -> str:
        return f"{EXPORT_PREFIX}{self.request_id}/events.ndjson.gz"

    @property
    def manifest_key(self) -> str:
        return f"{EXPORT_PREFIX}{self.request_id}/manifest.json"


def parse_requests(document: Any) -> list[ExportRequest]:
    """`{"requests": [...]}` or a bare list; refuses anything malformed (nothing is guessed)."""
    schemas.validate(
        "export-events-requests",
        document if isinstance(document, dict) else {"requests": document},
    )
    items = document["requests"] if isinstance(document, dict) else document
    requests = []
    for item in items:
        if not _REQUEST_ID.match(item["requestId"]) or not _SUBJECT_KEY.match(item["accountKey"]):
            raise ValueError(f"export request {item['requestId']!r}: invalid id or account key")
        start, end = parse_iso_ms(item["from"]), parse_iso_ms(item["to"])
        if end <= start:
            raise ValueError(f"export request {item['requestId']}: `to` must be after `from`")
        requests.append(ExportRequest(item["requestId"], item["accountKey"], start, end))
    if len({r.request_id for r in requests}) != len(requests):
        raise ValueError("export requests: a request id appears twice")
    return requests


# --- Reading the lake once for every request ------------------------------------------------


@dataclass
class HourMatches:
    rows: list[tuple[str, str, str, bytes]] = field(default_factory=list)  # account, at, id, raw
    objects: int = 0
    invalid: int = 0
    errors: list[str] = field(default_factory=list)


def _raw_matches(body: bytes, keys: frozenset[str], out: HourMatches) -> None:
    text = gzip.decompress(body)
    try:
        subjects = pl.read_ndjson(io.BytesIO(text), schema=_SUBJECT_SCHEMA)
        if not subjects["subject"].struct.field("account").is_in(list(keys)).any():
            return
    except Exception:  # noqa: S110 - a malformed line: the per-line path below decides
        pass
    for line in text.split(b"\n"):
        if not line.strip():
            continue
        try:
            event = orjson.loads(line)
        except orjson.JSONDecodeError:
            continue
        subject = event.get("subject") if isinstance(event, dict) else None
        if not isinstance(subject, dict) or subject.get("account") not in keys:
            continue
        if not schemas.is_valid_event(event):
            out.invalid += 1
            continue
        out.rows.append((subject["account"], event["receivedAt"], event["eventId"], line))


def _hour_job(args: tuple[str, int, frozenset[str]]) -> HourMatches:
    """One hour partition: every valid event of the given accounts (process-pool job)."""
    location, hour_ms, keys = args
    storage = open_storage(location)
    out = HourMatches()
    snapshot = snapshot_hour(storage, relist_hour(storage, hour_ms))
    out.errors.extend(snapshot.errors)
    for _key, body in snapshot.parquet:
        out.objects += 1
        # The filter is pushed into the scan: row groups whose `account` statistics exclude
        # every key are skipped. Compacted rows were validated when the hour was compacted.
        frame = (
            pl.scan_parquet(io.BytesIO(body))
            .filter(pl.col("account").is_in(list(keys)))
            .select("account", "received_at", "event_id", "raw")
            .collect()
        )
        out.rows.extend(
            (account, received, event_id, raw.encode())
            for account, received, event_id, raw in frame.iter_rows()
        )
    for _key, body in snapshot.raw:
        out.objects += 1
        _raw_matches(body, keys, out)
    return out


def _read(
    location: str, storage: Storage, requests: list[ExportRequest], workers: int
) -> tuple[HourMatches, int]:
    """Every hour any request's window touches, once, with the keys whose window covers it."""
    jobs: list[tuple[str, int, frozenset[str]]] = []
    earliest = min(r.from_ms for r in requests)
    latest = max(r.to_ms for r in requests)
    for hour in list_hours(storage, since_ms=earliest, until_ms=latest):
        keys = frozenset(
            r.account
            for r in requests
            if hour.hour_ms + HOUR_MS > r.from_ms and hour.hour_ms < r.to_ms
        )
        if keys:
            jobs.append((location, hour.hour_ms, keys))
    total = HourMatches()
    for outcome in parallel_map(_hour_job, jobs, workers=workers):
        _merge(total, outcome)
    return total, len(jobs)


def _merge(total: HourMatches, part: HourMatches) -> None:
    total.rows.extend(part.rows)
    total.objects += part.objects
    total.invalid += part.invalid
    total.errors.extend(part.errors[: max(0, 20 - len(total.errors))])


# --- Writing one request's output -----------------------------------------------------------


def events_body(
    rows: list[tuple[str, str, str, bytes]], request: ExportRequest
) -> tuple[bytes, int]:
    """The request's events: in its window, once per eventId (earliest receipt), in receipt
    order, as stored. Returns the gzip bytes and the number of events."""
    start, end = iso_ms(request.from_ms), iso_ms(request.to_ms)
    best: dict[str, tuple[str, bytes]] = {}
    for account, received, event_id, raw in rows:
        if account != request.account or not (start <= received < end):
            continue
        current = best.get(event_id)
        if current is None or received < current[0]:
            best[event_id] = (received, raw)
    ordered = sorted(best.items(), key=lambda item: (item[1][0], item[0]))
    text = b"".join(raw + b"\n" for _, (_, raw) in ordered)
    return gzip.compress(text, mtime=0), len(ordered)


def _complete(storage: Storage, request: ExportRequest) -> dict[str, Any] | None:
    """The existing output of this request if it is complete and for the same window."""
    manifest = get_json(storage, request.manifest_key)
    if not isinstance(manifest, dict) or manifest.get("accountKey") != request.account:
        return None
    if (manifest.get("from"), manifest.get("to")) != (
        iso_ms(request.from_ms),
        iso_ms(request.to_ms),
    ):
        return None
    body = storage.get(request.events_key)
    if body is None or len(body) != manifest.get("bytes"):
        return None
    if hashlib.sha256(body).hexdigest() != manifest.get("sha256"):
        return None
    return manifest


def _delete_output(storage: Storage, request_id: str) -> None:
    storage.delete([info.key for info in storage.list(f"{EXPORT_PREFIX}{request_id}/")])


def prune_outputs(storage: Storage, *, keep_days: int, now_ms: int, protect: set[str]) -> int:
    removed = 0
    for info in list(storage.list(EXPORT_PREFIX)):
        if not info.key.endswith("/manifest.json"):
            continue
        request_id = info.key[len(EXPORT_PREFIX) :].split("/", 1)[0]
        manifest = get_json(storage, info.key) or {}
        generated = manifest.get("generatedAt")
        if request_id in protect or not isinstance(generated, str):
            continue
        if parse_iso_ms(generated) + keep_days * DAY_MS <= now_ms:
            _delete_output(storage, request_id)
            removed += 1
    return removed


@dataclass
class ExportOutcome:
    results: list[dict[str, Any]]
    objects_read: int
    hours: int
    pruned: int

    @property
    def failed(self) -> bool:
        return any(result["status"] == "failed" for result in self.results)

    def document(self, now_ms: int) -> dict[str, Any]:
        return {
            "format": "webflix.export-events-results",
            "formatVersion": 1,
            "generatedAt": iso_ms(now_ms),
            "results": self.results,
        }


def export_events(
    location: str,
    requests: list[ExportRequest],
    *,
    erased: Iterable[str] = (),
    now_ms: int | None = None,
    grace_ms: int = DEFAULT_GRACE_MS,
    keep_days: int = DEFAULT_KEEP_DAYS,
    force: bool = False,
    workers: int = 1,
    take_lease: bool = True,
    log: Callable[[str], object] = print,
) -> ExportOutcome:
    """Extract the events of every due request (module docstring). Never raises for one
    request's failure: it is reported `failed`, the others proceed."""
    from webflix_recs.erasure import load_plan  # noqa: PLC0415
    from webflix_recs.lease import lake_lease  # noqa: PLC0415

    now = int(time.time() * 1000) if now_ms is None else now_ms
    storage = open_storage(location)
    if take_lease:
        with lake_lease(storage, "export-events"):
            return export_events(
                location, requests, erased=erased, now_ms=now, grace_ms=grace_ms,
                keep_days=keep_days, force=force, workers=workers, take_lease=False, log=log,
            )  # fmt: skip
    blocked = set(erased) | set(load_plan(storage)["subjects"])
    results: dict[str, dict[str, Any]] = {}
    due: list[ExportRequest] = []
    for request in requests:
        base = {
            "requestId": request.request_id,
            "from": iso_ms(request.from_ms),
            "to": iso_ms(request.to_ms),
        }
        if request.account in blocked:
            _delete_output(storage, request.request_id)
            results[request.request_id] = {**base, "status": "erased", "events": 0}
        elif request.to_ms + grace_ms > now:
            results[request.request_id] = {
                **base,
                "status": "deferred",
                "notBefore": iso_ms(request.to_ms + grace_ms),
            }
        elif not force and (manifest := _complete(storage, request)) is not None:
            results[request.request_id] = _result(base, request, manifest, reused=True)
        else:
            due.append(request)
    objects = hours = 0
    if due:
        log(f"export-events: reading the lake for {len(due)} requests")
        matches, hours = _read(location, storage, due, workers)
        objects = matches.objects
        for request in due:
            base = {
                "requestId": request.request_id,
                "from": iso_ms(request.from_ms),
                "to": iso_ms(request.to_ms),
            }
            try:
                body, count = events_body(matches.rows, request)
                storage.put(request.events_key, body, content_type="application/gzip")
                manifest = {
                    "format": "webflix.export-events",
                    "formatVersion": 1,
                    "requestId": request.request_id,
                    "accountKey": request.account,
                    "from": iso_ms(request.from_ms),
                    "to": iso_ms(request.to_ms),
                    "events": count,
                    "file": request.events_key,
                    "bytes": len(body),
                    "sha256": hashlib.sha256(body).hexdigest(),
                    "generatedAt": iso_ms(now),
                }
                schemas.validate("export-events-manifest", manifest)
                put_json(storage, request.manifest_key, manifest)  # last: complete
                results[request.request_id] = _result(base, request, manifest, reused=False)
            except Exception as error:
                results[request.request_id] = {**base, "status": "failed", "error": str(error)}
    pruned = prune_outputs(
        storage,
        keep_days=keep_days,
        now_ms=now,
        protect={r.request_id for r in requests},
    )
    ordered = [results[r.request_id] for r in requests]
    return ExportOutcome(ordered, objects, hours, pruned)


def _result(
    base: dict[str, Any], request: ExportRequest, manifest: dict[str, Any], *, reused: bool
) -> dict[str, Any]:
    return {
        **base,
        "status": "complete",
        "events": manifest["events"],
        "file": request.events_key,
        "manifest": request.manifest_key,
        "bytes": manifest["bytes"],
        "sha256": manifest["sha256"],
        "generatedAt": manifest["generatedAt"],
        "reused": reused,
    }


__all__ = [
    "EXPORT_PREFIX",
    "ExportOutcome",
    "ExportRequest",
    "export_events",
    "parse_requests",
    "prune_outputs",
    "put_json",
]
