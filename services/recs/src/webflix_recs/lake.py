"""The event lake: reading raw NDJSON and compacted Parquet alike, and compacting closed hours.

Layout (blueprint §6.2): `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz`, partitioned by the
hour of receipt, written by the product's lake writer (`createBlobLakeEventSink`): one object
per client batch, per outbox drain or per server event, never overwritten, at least once.
Compaction adds, per closed hour (the contract the product's data export reads; the exact rules
are in services/recs/README.md, "Compacted hours"):

* `events/dt=…/hh=…/part-{sha256-16}.parquet`: every valid event of the hour once (deduplicated
  by `eventId`, earliest receipt kept), each as the exact line the writer stored (`raw`), with a
  few typed columns, sorted by the pseudonymous `account` so row-group statistics let a reader
  of one account skip most of the file; Snappy only, so a small JavaScript reader (hyparquet)
  decodes it without a WASM codec;
* `events/dt=…/hh=…/_compaction.json`, written after the Parquet file: which Parquet file is
  current and which raw objects it covers.

A reader takes the current Parquet file plus every raw object the manifest does not cover (a
straggler written after compaction: a late outbox drain, a retried batch), deduplicating by
`eventId`, so compaction never hides an event and never double counts one. Rewrites (a
re-compaction, an erasure) write a new Parquet file, flip the manifest, and only then delete
what the new manifest no longer needs; a reader that finds an object gone starts the hour again
and sees the newer state. Re-running compaction over an unchanged hour is a no-op. Invalid
events never reach Parquet: they are counted and kept under `events-quarantine/`.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any

import orjson
import polars as pl

from webflix_recs import schemas
from webflix_recs.ids import HOUR_MS, iso_ms, parse_partition, partition_prefix
from webflix_recs.parallel import process_pool
from webflix_recs.storage import ObjectInfo, Storage, get_json, open_storage, put_json

COMPACTION_MANIFEST = "_compaction.json"
COMPACTION_FORMAT = "webflix.events-compaction"
#: The manifest and Parquet layout this code writes. Version 1 (zstd, sorted by receipt, `raw`
#: re-serialised, erased keys listed in the manifest) is still read, and rewritten as version 2
#: by the next compaction of its hour.
COMPACTION_VERSION = 2
READABLE_COMPACTION_VERSIONS = frozenset({1, 2})
PARQUET_FORMAT = "webflix.events-compacted/2"
#: Rows per Parquet row group: about 1 MB of `raw` before compression. Small enough that a
#: reader of one account reads one group per hour, large enough that the footer stays small.
ROW_GROUP_ROWS = 1_000
SORT_ORDER = ("account", "received_at", "event_id")
COMPACTED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("account", "pseudonymous account key (subject.account); null on signed-out events"),
    ("profile", "pseudonymous profile key (subject.profile); null without a profile"),
    ("event_id", "eventId"),
    ("type", "event type"),
    ("received_at", "receivedAt, exactly as stored (RFC 3339, milliseconds, Z)"),
    ("occurred_at", "occurredAt, exactly as stored"),
    ("title_id", "payload.titleId when the type has one, else null"),
    ("raw", "the event exactly as the lake writer stored it: one JSON line, UTF-8"),
)
EVENTS_PREFIX = "events/"
QUARANTINE_PREFIX = "events-quarantine/"
READ_ATTEMPTS = 3


class LakeReadError(RuntimeError):
    """An hour could not be read consistently (objects kept vanishing)."""


@dataclass
class HourObjects:
    hour_ms: int
    ndjson: list[ObjectInfo] = field(default_factory=list)
    parquet: list[ObjectInfo] = field(default_factory=list)
    manifest: ObjectInfo | None = None

    @property
    def prefix(self) -> str:
        return partition_prefix(self.hour_ms)


def _classify(hours: dict[int, HourObjects], info: ObjectInfo) -> None:
    hour = parse_partition(info.key)
    if hour is None:
        return
    rest = info.key[len(partition_prefix(hour)) :]
    if "/" in rest:
        return  # not directly in an hour partition
    objects = hours.setdefault(hour, HourObjects(hour))
    if rest.endswith(".ndjson.gz"):
        objects.ndjson.append(info)
    elif rest.endswith(".parquet"):
        objects.parquet.append(info)
    elif rest == COMPACTION_MANIFEST:
        objects.manifest = info


def list_hours(
    storage: Storage, *, until_ms: int | None = None, since_ms: int | None = None
) -> list[HourObjects]:
    """Lake partitions in time order, with their objects."""
    hours: dict[int, HourObjects] = {}
    for info in storage.list(EVENTS_PREFIX):
        hour = parse_partition(info.key)
        if hour is None:
            continue
        if until_ms is not None and hour >= until_ms:
            continue
        if since_ms is not None and hour + HOUR_MS <= since_ms:
            continue
        _classify(hours, info)
    return [hours[hour] for hour in sorted(hours)]


def relist_hour(storage: Storage, hour_ms: int) -> HourObjects:
    """One hour partition listed afresh."""
    hours: dict[int, HourObjects] = {}
    for info in storage.list(partition_prefix(hour_ms)):
        _classify(hours, info)
    return hours.get(hour_ms, HourObjects(hour_ms))


@dataclass
class ReadStats:
    objects: int = 0
    lines: int = 0
    valid: int = 0
    invalid: int = 0
    unparseable: int = 0
    errors: list[str] = field(default_factory=list)

    def merge(self, other: ReadStats) -> None:
        self.objects += other.objects
        self.lines += other.lines
        self.valid += other.valid
        self.invalid += other.invalid
        self.unparseable += other.unparseable
        for error in other.errors:
            if len(self.errors) < 20:
                self.errors.append(error)

    def to_dict(self) -> dict[str, Any]:
        return {
            "objects": self.objects,
            "lines": self.lines,
            "valid": self.valid,
            "invalid": self.invalid,
            "unparseable": self.unparseable,
            "errorSamples": self.errors[:10],
        }


def _validated_lines(
    lines: Iterable[bytes], source: str, stats: ReadStats, rejected: list[bytes] | None = None
) -> Iterator[bytes]:
    for line in lines:
        if not line.strip():
            continue
        stats.lines += 1
        try:
            event = orjson.loads(line)
        except orjson.JSONDecodeError:
            stats.unparseable += 1
            if rejected is not None:
                rejected.append(line)
            continue
        if schemas.is_valid_event(event):
            stats.valid += 1
            yield line
        else:
            stats.invalid += 1
            if rejected is not None:
                rejected.append(line)
            if len(stats.errors) < 20:
                stats.errors.append(f"{source}: {'; '.join(schemas.event_errors(event))}")


def ndjson_lines(body: bytes) -> list[bytes]:
    """The lines of a raw lake object (gzip, one JSON event per line)."""
    return gzip.decompress(body).split(b"\n")


def parquet_raw_lines(body: bytes) -> list[bytes]:
    """The `raw` column of a compacted Parquet file (either version), as stored lines."""
    raw = pl.read_parquet(io.BytesIO(body), columns=["raw"])["raw"]
    return [value.encode() for value in raw]


def read_manifest(storage: Storage, hour: HourObjects) -> dict[str, Any] | None:
    """The hour's compaction manifest, or None when the hour has none (any more). A manifest
    of a version this code does not know is an error, never silently ignored: its hour may
    have no raw objects left."""
    if hour.manifest is None:
        return None
    manifest = get_json(storage, hour.manifest.key)
    if manifest is None:
        return None
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != COMPACTION_FORMAT
        or not isinstance(manifest.get("parquet"), str)
    ):
        raise LakeReadError(f"{hour.manifest.key} is not a {COMPACTION_FORMAT} manifest")
    if manifest.get("formatVersion") not in READABLE_COMPACTION_VERSIONS:
        raise LakeReadError(
            f"{hour.manifest.key}: format version {manifest.get('formatVersion')} is not one "
            f"this pipeline reads ({sorted(READABLE_COMPACTION_VERSIONS)})"
        )
    return manifest


def covered_sources(
    storage: Storage, hour: HourObjects, manifest: dict[str, Any] | None = None
) -> tuple[list[ObjectInfo], set[str]]:
    """The Parquet object the manifest names, and the raw keys it covers. Empty when there is
    no manifest or the file it names is not listed."""
    if manifest is None:
        manifest = read_manifest(storage, hour)
    if manifest is None:
        return [], set()
    current = [info for info in hour.parquet if info.key == manifest["parquet"]]
    if not current:
        return [], set()
    return current, {str(source["key"]) for source in manifest.get("sources", [])}


@dataclass
class HourSnapshot:
    """The bytes of one hour as a reader must take them: the current Parquet file (if any) and
    every raw object it does not cover, fetched from one consistent state of the hour."""

    hour: HourObjects
    parquet: list[tuple[str, bytes]]
    raw: list[tuple[str, bytes]]
    errors: list[str]


def snapshot_hour(storage: Storage, hour: HourObjects) -> HourSnapshot:
    """Fetch an hour by the readers' rule (README, "Compacted hours"): the manifest's Parquet
    file and the raw objects it does not cover. If an object disappears meanwhile (a
    re-compaction or an erasure flipped the manifest and deleted what it no longer needs), the
    hour is listed and fetched again: deletions only ever follow the manifest that makes them
    safe."""
    for attempt in range(READ_ATTEMPTS):
        if attempt:
            hour = relist_hour(storage, hour.hour_ms)
        manifest = read_manifest(storage, hour)
        parquet, covered = covered_sources(storage, hour, manifest)
        vanished = manifest is not None and not parquet and attempt < READ_ATTEMPTS - 1
        parquet_bodies: list[tuple[str, bytes]] = []
        raw_bodies: list[tuple[str, bytes]] = []
        for info in parquet:
            body = storage.get(info.key)
            if body is None:
                vanished = True
                break
            parquet_bodies.append((info.key, body))
        if not vanished:
            for info in hour.ndjson:
                if info.key in covered:
                    continue
                body = storage.get(info.key)
                if body is None:
                    vanished = True
                    break
                raw_bodies.append((info.key, body))
        if not vanished:
            errors = []
            if manifest is not None and not parquet:
                errors.append(
                    f"{hour.prefix}: the manifest names a missing Parquet file; raw objects read"
                )
            return HourSnapshot(hour, parquet_bodies, raw_bodies, errors)
    raise LakeReadError(f"{partition_prefix(hour.hour_ms)} kept changing while it was read")


def read_hour_lines(storage: Storage, hour: HourObjects) -> tuple[list[bytes], ReadStats]:
    """Every valid event line of one hour partition (snapshot_hour's objects)."""
    snapshot = snapshot_hour(storage, hour)
    stats = ReadStats(errors=list(snapshot.errors))
    lines: list[bytes] = []
    for key, body in snapshot.parquet:
        stats.objects += 1
        lines.extend(_validated_lines(parquet_raw_lines(body), key, stats))
    for key, body in snapshot.raw:
        stats.objects += 1
        lines.extend(_validated_lines(ndjson_lines(body), key, stats))
    return lines, stats


def parse_lines(lines: list[bytes]) -> pl.DataFrame:
    """Validated event lines -> the flat projection (schemas.FLAT_EVENT_SCHEMA)."""
    if not lines:
        return pl.DataFrame(schema=schemas.FLAT_EVENT_SCHEMA)
    nested = pl.read_ndjson(io.BytesIO(b"\n".join(lines)), schema=schemas.EVENT_PROJECTION)
    return schemas.flatten_projection(nested)


# --- Parallel reading ---------------------------------------------------------------------------


def _read_batch(args: tuple[str, list[HourObjects], Any]) -> tuple[Any, ReadStats]:
    """One worker's share: hour by hour, read, validate, parse and (if given) transform, so
    only one hour of raw events is in memory at a time."""
    location, hours, transform = args
    storage = open_storage(location)
    results: list[Any] = []
    stats = ReadStats()
    for hour in hours:
        lines, hour_stats = read_hour_lines(storage, hour)
        stats.merge(hour_stats)
        frame = parse_lines(lines)
        del lines
        results.append(transform(frame) if transform is not None else frame)
    if not results:
        empty = pl.DataFrame(schema=schemas.FLAT_EVENT_SCHEMA)
        return (transform(empty) if transform is not None else empty), stats
    if isinstance(results[0], dict):
        merged = {key: pl.concat([r[key] for r in results], how="vertical") for key in results[0]}
        return merged, stats
    return pl.concat(results, how="vertical"), stats


def read_events(
    location: str,
    *,
    until_ms: int | None = None,
    since_ms: int | None = None,
    workers: int = 1,
    transform: Any = None,
    hours_per_task: int = 12,
) -> tuple[list[Any], ReadStats, int]:
    """Read and validate every event in the partitions before `until_ms`.

    `transform` (a picklable function of the flat frame) runs inside the workers, so a caller
    can split and slim the frame before it crosses process boundaries. Returns one transformed
    result per task, the read statistics and the number of hour partitions read.
    """
    storage = open_storage(location)
    hours = list_hours(storage, until_ms=until_ms, since_ms=since_ms)
    batches = [hours[i : i + hours_per_task] for i in range(0, len(hours), hours_per_task)]
    stats = ReadStats()
    results: list[Any] = []
    jobs = [(location, batch, transform) for batch in batches]
    if workers <= 1 or len(jobs) <= 1:
        for job in jobs:
            result, batch_stats = _read_batch(job)
            results.append(result)
            stats.merge(batch_stats)
    else:
        with process_pool(workers) as pool:
            for result, batch_stats in pool.map(_read_batch, jobs):
                results.append(result)
                stats.merge(batch_stats)
    return results, stats, len(hours)


# --- Writing a compacted hour -------------------------------------------------------------------


def compacted_frame(lines: list[bytes]) -> pl.DataFrame:
    """Validated, deduplicated event lines -> the compacted table, in its sort order."""
    columns: dict[str, list[str | None]] = {name: [] for name, _ in COMPACTED_COLUMNS}
    for line in lines:
        event = orjson.loads(line)
        subject = event["subject"]
        columns["account"].append(subject["account"])
        columns["profile"].append(subject["profile"])
        columns["event_id"].append(event["eventId"])
        columns["type"].append(event["type"])
        columns["received_at"].append(event["receivedAt"])
        columns["occurred_at"].append(event["occurredAt"])
        title = event["payload"].get("titleId")
        columns["title_id"].append(title if isinstance(title, str) else None)
        columns["raw"].append(line.decode("utf-8"))
    frame = pl.DataFrame(columns, schema={name: pl.String for name, _ in COMPACTED_COLUMNS})
    return frame.sort(list(SORT_ORDER), nulls_last=True)


def write_compacted(frame: pl.DataFrame, hour_ms: int) -> bytes:
    """The Parquet bytes of a compacted hour: Snappy, UTF-8 strings, row-group statistics."""
    buffer = io.BytesIO()
    frame.write_parquet(
        buffer,
        compression="snappy",
        statistics=True,
        row_group_size=ROW_GROUP_ROWS,
        metadata={"webflix.format": PARQUET_FORMAT, "webflix.hour": iso_ms(hour_ms)},
    )
    return buffer.getvalue()


def parquet_key(hour: HourObjects, body: bytes) -> str:
    """Content-addressed: the name changes exactly when the content does."""
    return f"{hour.prefix}part-{hashlib.sha256(body).hexdigest()[:16]}.parquet"


def manifest_document(
    hour: HourObjects,
    *,
    key: str,
    body: bytes,
    rows: int,
    sources: list[dict[str, Any]],
    duplicates: int,
    invalid: int,
    erased: int,
    compacted_at_ms: int,
) -> dict[str, Any]:
    groups = (rows + ROW_GROUP_ROWS - 1) // ROW_GROUP_ROWS
    return {
        "format": COMPACTION_FORMAT,
        "formatVersion": COMPACTION_VERSION,
        "hour": iso_ms(hour.hour_ms),
        "parquet": key,
        "parquetBytes": len(body),
        "parquetSha256": hashlib.sha256(body).hexdigest(),
        "rows": rows,
        "rowGroups": groups,
        "rowGroupRows": ROW_GROUP_ROWS,
        "sortedBy": list(SORT_ORDER),
        "compression": "SNAPPY",
        "columns": [{"name": name, "description": text} for name, text in COMPACTED_COLUMNS],
        "duplicatesDropped": duplicates,
        "invalid": invalid,
        "erased": erased,
        "sources": sources,
        "compactedAt": iso_ms(compacted_at_ms),
    }


def flip(
    storage: Storage,
    hour: HourObjects,
    body: bytes,
    manifest: dict[str, Any],
) -> None:
    """Install a new compacted file: Parquet first, then the manifest naming it, then remove
    every other Parquet file of the hour. A reader or a crash at any point sees a consistent
    hour (the old manifest and its file, or the new ones)."""
    schemas.validate("events-compaction", manifest)
    key = str(manifest["parquet"])
    if storage.head(key) is None:  # content-addressed: an existing object has these bytes
        storage.put(key, body, content_type="application/vnd.apache.parquet")
    put_json(storage, hour.prefix + COMPACTION_MANIFEST, manifest)
    others = [info.key for info in relist_hour(storage, hour.hour_ms).parquet if info.key != key]
    storage.delete(others)


# --- Compaction ---------------------------------------------------------------------------------


@dataclass
class CompactionResult:
    hours_seen: int = 0
    hours_compacted: int = 0
    hours_unchanged: int = 0
    hours_upgraded: int = 0
    hours_open: int = 0
    events_written: int = 0
    duplicates_dropped: int = 0
    invalid_quarantined: int = 0
    sources_deleted: int = 0

    def to_dict(self) -> dict[str, int]:
        return dict(self.__dict__)


def _quarantine(storage: Storage, hour: HourObjects, rejected: list[bytes]) -> None:
    body = b"\n".join(rejected) + b"\n"
    digest = hashlib.sha256(body).hexdigest()[:16]
    partition = hour.prefix.removeprefix(EVENTS_PREFIX)
    storage.put(f"{QUARANTINE_PREFIX}{partition}{digest}.ndjson.gz", gzip.compress(body, mtime=0))


def compact_hour(
    storage: Storage,
    hour: HourObjects,
    *,
    delete_sources: bool = False,
    result: CompactionResult | None = None,
    clock_ms: int | None = None,
) -> str:
    """Compact one closed hour. Returns `compacted`, `upgraded`, `unchanged` or `empty`."""
    result = result or CompactionResult()
    manifest = read_manifest(storage, hour)
    parquet, covered = covered_sources(storage, hour, manifest)
    if manifest is not None and not parquet:
        manifest, covered = None, set()  # names a missing file: start over from raw objects
    pending = [info for info in hour.ndjson if info.key not in covered]
    upgrade = manifest is not None and manifest.get("formatVersion") != COMPACTION_VERSION
    if parquet and not pending and not upgrade:
        if delete_sources:
            stale = [info.key for info in hour.ndjson]
            storage.delete(stale)
            result.sources_deleted += len(stale)
        return "unchanged"
    if not hour.ndjson and not parquet:
        return "empty"
    stats = ReadStats()
    rejected: list[bytes] = []
    candidates: list[bytes] = []
    for info in parquet:
        body = storage.get(info.key)
        if body is not None:
            # Re-validated: a line the current schema refuses is quarantined, not lost.
            candidates.extend(_validated_lines(parquet_raw_lines(body), info.key, stats, rejected))
    for info in sorted(pending, key=lambda i: i.key.encode()):
        body = storage.get(info.key)
        if body is not None:
            candidates.extend(_validated_lines(ndjson_lines(body), info.key, stats, rejected))
    # At least once: keep each eventId once, its earliest receipt (ties: the first seen, so the
    # row already compacted wins over a straggler, then key order, then line order).
    best: dict[str, tuple[str, bytes]] = {}
    for line in candidates:
        event = orjson.loads(line)
        current = best.get(event["eventId"])
        if current is None or event["receivedAt"] < current[0]:
            best[event["eventId"]] = (event["receivedAt"], line)
    duplicates = len(candidates) - len(best)
    frame = compacted_frame([line for _, line in best.values()])
    body = write_compacted(frame, hour.hour_ms)
    previous_sources = list((manifest or {}).get("sources", [])) if parquet else []
    sources = sorted(
        [{"key": s.key, "size": s.size, "etag": s.etag} for s in pending] + previous_sources,
        key=lambda s: str(s["key"]).encode(),
    )
    document = manifest_document(
        hour,
        key=parquet_key(hour, body),
        body=body,
        rows=frame.height,
        sources=sources,
        duplicates=int((manifest or {}).get("duplicatesDropped", 0)) + duplicates,
        invalid=int((manifest or {}).get("invalid", 0)) + len(rejected),
        erased=int((manifest or {}).get("erased", 0)),
        compacted_at_ms=int(time.time() * 1000) if clock_ms is None else clock_ms,
    )
    flip(storage, hour, body, document)
    if rejected:
        _quarantine(storage, hour, rejected)
        result.invalid_quarantined += len(rejected)
    if delete_sources:
        # Only now that the manifest covers them (deletion always follows the flip).
        doomed = [info.key for info in hour.ndjson]
        storage.delete(doomed)
        result.sources_deleted += len(doomed)
    result.events_written += frame.height
    result.duplicates_dropped += duplicates
    return "upgraded" if upgrade and not pending else "compacted"


def _compact_job(args: tuple[str, HourObjects, bool, int | None]) -> tuple[str, CompactionResult]:
    location, hour, delete_sources, clock_ms = args
    result = CompactionResult()
    outcome = compact_hour(
        open_storage(location),
        hour,
        delete_sources=delete_sources,
        result=result,
        clock_ms=clock_ms,
    )
    return outcome, result


def compact(
    location: str,
    *,
    now_ms: int,
    grace_ms: int = 15 * 60_000,
    delete_sources: bool = False,
    workers: int = 1,
    clock_ms: int | None = None,
    take_lease: bool = True,
) -> CompactionResult:
    """Compact every closed hour (its end plus `grace_ms` is before `now_ms`), hours in
    parallel, under the lake lease (lease.py) unless the caller already holds it."""
    from webflix_recs.lease import lake_lease  # noqa: PLC0415

    storage = open_storage(location)
    if take_lease:
        with lake_lease(storage, "compact"):
            return compact(
                location,
                now_ms=now_ms,
                grace_ms=grace_ms,
                delete_sources=delete_sources,
                workers=workers,
                clock_ms=clock_ms,
                take_lease=False,
            )
    total = CompactionResult()
    jobs = []
    for hour in list_hours(storage):
        total.hours_seen += 1
        if hour.hour_ms + HOUR_MS + grace_ms > now_ms:
            total.hours_open += 1
            continue
        jobs.append((location, hour, delete_sources, clock_ms))
    if workers <= 1:
        outcomes = [_compact_job(job) for job in jobs]
    else:
        with process_pool(workers) as pool:
            outcomes = list(pool.map(_compact_job, jobs, chunksize=4))
    for outcome, result in outcomes:
        if outcome == "compacted":
            total.hours_compacted += 1
        elif outcome == "upgraded":
            total.hours_upgraded += 1
        elif outcome == "unchanged":
            total.hours_unchanged += 1
        for name in (
            "events_written",
            "duplicates_dropped",
            "invalid_quarantined",
            "sources_deleted",
        ):
            setattr(total, name, getattr(total, name) + getattr(result, name))
    return total
