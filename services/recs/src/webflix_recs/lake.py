"""The event lake: reading NDJSON and compacted Parquet alike, and compacting closed hours.

Layout (blueprint §6.2): `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz`, partitioned by the
hour of receipt. Compaction adds, per closed hour:

* `events/dt=…/hh=…/part-{digest}.parquet`: every valid event of the hour once (deduplicated by
  `eventId`, earliest receipt kept), sorted by receipt time, with typed columns for analysts and
  the canonical event JSON in `raw`;
* `events/dt=…/hh=…/_compaction.json`, written after the Parquet file: which source objects
  (key, size, etag) the Parquet file covers.

A reader takes the Parquet file plus any NDJSON object the manifest does not cover (a straggler
written after compaction), so compaction never hides an event and never double counts one;
deduplication by `eventId` makes the rest safe. Re-running compaction over an unchanged hour is
a no-op; over an hour that gained objects, it rewrites the Parquet file under a new name, flips
the manifest, then removes the old file. Invalid events never reach Parquet: they are counted
and, when sources are deleted, kept under `events-quarantine/`.
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
EVENTS_PREFIX = "events/"


@dataclass
class HourObjects:
    hour_ms: int
    ndjson: list[ObjectInfo] = field(default_factory=list)
    parquet: list[ObjectInfo] = field(default_factory=list)
    manifest: ObjectInfo | None = None

    @property
    def prefix(self) -> str:
        return partition_prefix(self.hour_ms)


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
        objects = hours.setdefault(hour, HourObjects(hour))
        name = info.key.rsplit("/", 1)[-1]
        if name.endswith(".ndjson.gz"):
            objects.ndjson.append(info)
        elif name.endswith(".parquet"):
            objects.parquet.append(info)
        elif name == COMPACTION_MANIFEST:
            objects.manifest = info
    return [hours[hour] for hour in sorted(hours)]


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


def _ndjson_lines(body: bytes) -> list[bytes]:
    return gzip.decompress(body).split(b"\n")


def covered_sources(storage: Storage, hour: HourObjects) -> tuple[list[ObjectInfo], set[str]]:
    """The Parquet object a valid compaction manifest names, and the NDJSON keys it covers."""
    if hour.manifest is None:
        return [], set()
    manifest = get_json(storage, hour.manifest.key)
    if not manifest:
        return [], set()
    parquet_key = manifest.get("parquet")
    current = [info for info in hour.parquet if info.key == parquet_key]
    if not current:
        # The named file is missing (an interrupted re-compaction): ignore the manifest and read
        # the raw objects instead.
        return [], set()
    return current, {source["key"] for source in manifest.get("sources", [])}


def read_hour_lines(storage: Storage, hour: HourObjects) -> tuple[list[bytes], ReadStats]:
    """Every valid event line of one hour partition (NDJSON and compacted Parquet)."""
    stats = ReadStats()
    lines: list[bytes] = []
    parquet, covered = covered_sources(storage, hour)
    for info in parquet:
        body = storage.get(info.key)
        if body is None:
            continue
        stats.objects += 1
        raw = pl.read_parquet(io.BytesIO(body), columns=["raw"])["raw"]
        lines.extend(_validated_lines((value.encode() for value in raw), info.key, stats))
    for info in hour.ndjson:
        if info.key in covered:
            continue
        body = storage.get(info.key)
        if body is None:
            continue
        stats.objects += 1
        lines.extend(_validated_lines(_ndjson_lines(body), info.key, stats))
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


# --- Compaction ---------------------------------------------------------------------------------


@dataclass
class CompactionResult:
    hours_seen: int = 0
    hours_compacted: int = 0
    hours_unchanged: int = 0
    hours_open: int = 0
    events_written: int = 0
    duplicates_dropped: int = 0
    invalid_quarantined: int = 0
    erased: int = 0
    sources_deleted: int = 0

    def to_dict(self) -> dict[str, int]:
        return dict(self.__dict__)


def _source_digest(sources: list[ObjectInfo], erase: frozenset[str]) -> str:
    material = "\n".join(
        f"{info.key}|{info.size}|{info.etag}" for info in sorted(sources, key=lambda i: i.key)
    )
    material += "\n" + "\n".join(sorted(erase))
    return hashlib.sha256(material.encode()).hexdigest()[:16]


def compact_hour(
    storage: Storage,
    hour: HourObjects,
    *,
    delete_sources: bool = False,
    erase_accounts: frozenset[str] = frozenset(),
    result: CompactionResult | None = None,
) -> str:
    """Compact one closed hour. Returns `compacted`, `unchanged` or `empty`."""
    result = result or CompactionResult()
    manifest = get_json(storage, hour.manifest.key) if hour.manifest else None
    parquet, covered = covered_sources(storage, hour)
    pending = [info for info in hour.ndjson if info.key not in covered]
    erase_key = sorted(erase_accounts)
    if parquet and not pending and (manifest or {}).get("erase") == erase_key:
        return "unchanged"
    if not hour.ndjson and not parquet:
        return "empty"
    stats = ReadStats()
    rejected: list[bytes] = []
    lines: list[bytes] = []
    for info in parquet:
        body = storage.get(info.key)
        if body is not None:
            raw = pl.read_parquet(io.BytesIO(body), columns=["raw"])["raw"]
            lines.extend(_validated_lines((v.encode() for v in raw), info.key, stats, rejected))
    for info in pending:
        body = storage.get(info.key)
        if body is not None:
            lines.extend(_validated_lines(_ndjson_lines(body), info.key, stats, rejected))
    sources = sorted(
        [{"key": s.key, "size": s.size, "etag": s.etag} for s in pending]
        + list((manifest or {}).get("sources", []) if parquet else []),
        key=lambda s: s["key"],
    )
    events = [orjson.loads(line) for line in lines]
    best: dict[str, dict[str, Any]] = {}
    for event in events:
        current = best.get(event["eventId"])
        if current is None or event["receivedAt"] < current["receivedAt"]:
            best[event["eventId"]] = event
    duplicates = len(events) - len(best)
    kept = [e for e in best.values() if (e["subject"]["account"] or "") not in erase_accounts]
    erased = len(best) - len(kept)
    kept.sort(key=lambda e: (e["receivedAt"], e["eventId"]))
    frame = pl.DataFrame(
        {
            "event_id": [e["eventId"] for e in kept],
            "type": [e["type"] for e in kept],
            "occurred_at": [e["occurredAt"] for e in kept],
            "received_at": [e["receivedAt"] for e in kept],
            "account": [e["subject"]["account"] for e in kept],
            "profile": [e["subject"]["profile"] for e in kept],
            "restricted": [e["subject"]["restricted"] for e in kept],
            "title_id": [e["payload"].get("titleId") for e in kept],
            "raw": [orjson.dumps(e).decode() for e in kept],
        },
        schema={
            "event_id": pl.String, "type": pl.String, "occurred_at": pl.String,
            "received_at": pl.String, "account": pl.String, "profile": pl.String,
            "restricted": pl.Boolean, "title_id": pl.String, "raw": pl.String,
        },
    ).with_columns(
        pl.col(name).str.to_datetime(schemas.TIMESTAMP_FORMAT, time_zone="UTC", time_unit="ms")
        for name in ("occurred_at", "received_at")
    )  # fmt: skip
    all_sources = [ObjectInfo(s["key"], s["size"], s["etag"], 0) for s in sources]
    name = f"part-{_source_digest(all_sources, erase_accounts)}.parquet"
    key = hour.prefix + name
    buffer = io.BytesIO()
    frame.write_parquet(
        buffer,
        compression="zstd",
        metadata={
            "webflix.format": "webflix.events-compacted/1",
            "webflix.sources": str(len(sources)),
        },
    )
    storage.put(key, buffer.getvalue(), content_type="application/vnd.apache.parquet")
    put_json(
        storage,
        hour.prefix + COMPACTION_MANIFEST,
        {
            "format": "webflix.events-compaction",
            "formatVersion": 1,
            "hour": iso_ms(hour.hour_ms),
            "parquet": key,
            "events": len(kept),
            "duplicatesDropped": duplicates,
            "invalid": stats.invalid + stats.unparseable,
            "erased": erased,
            "erase": erase_key,
            "sources": sources,
            "compactedAt": iso_ms(int(time.time() * 1000)),
        },
    )
    # Only now that the manifest names the new file are older files removed.
    storage.delete([info.key for info in hour.parquet if info.key != key])
    if rejected:
        partition = hour.prefix.removeprefix(EVENTS_PREFIX)
        quarantine = f"events-quarantine/{partition}{name.removesuffix('.parquet')}.ndjson.gz"
        storage.put(quarantine, gzip.compress(b"\n".join(rejected) + b"\n", mtime=0))
        result.invalid_quarantined += len(rejected)
    if delete_sources:
        storage.delete([info.key for info in pending])
        result.sources_deleted += len(pending)
    result.events_written += len(kept)
    result.duplicates_dropped += duplicates
    result.erased += erased
    return "compacted"


def _compact_job(
    args: tuple[str, HourObjects, bool, frozenset[str]],
) -> tuple[str, CompactionResult]:
    location, hour, delete_sources, erase = args
    result = CompactionResult()
    outcome = compact_hour(
        open_storage(location),
        hour,
        delete_sources=delete_sources,
        erase_accounts=erase,
        result=result,
    )
    return outcome, result


def compact(
    location: str,
    *,
    now_ms: int,
    grace_ms: int = 15 * 60_000,
    delete_sources: bool = False,
    erase_accounts: Iterable[str] = (),
    workers: int = 1,
) -> CompactionResult:
    """Compact every closed hour (its end plus `grace_ms` is before `now_ms`), hours in parallel."""
    erase = frozenset(erase_accounts)
    total = CompactionResult()
    jobs = []
    for hour in list_hours(open_storage(location)):
        total.hours_seen += 1
        if hour.hour_ms + HOUR_MS + grace_ms > now_ms:
            total.hours_open += 1
            continue
        jobs.append((location, hour, delete_sources, erase))
    if workers <= 1:
        outcomes = [_compact_job(job) for job in jobs]
    else:
        with process_pool(workers) as pool:
            outcomes = list(pool.map(_compact_job, jobs, chunksize=4))
    for outcome, result in outcomes:
        if outcome == "compacted":
            total.hours_compacted += 1
        elif outcome == "unchanged":
            total.hours_unchanged += 1
        for name in (
            "events_written",
            "duplicates_dropped",
            "invalid_quarantined",
            "erased",
            "sources_deleted",
        ):
            setattr(total, name, getattr(total, name) + getattr(result, name))
    return total
