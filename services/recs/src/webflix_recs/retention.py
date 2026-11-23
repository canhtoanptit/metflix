"""`retain`: what the product promises about retention, made true for this pipeline's store.

The product tells members that what is recorded is kept for 13 months and totals for 37 (the
privacy page, from `WEBFLIX_EVENTS_RETENTION_DAYS`, default 396, and
`WEBFLIX_AGGREGATES_RETENTION_DAYS`, default 1126; packages/core/src/areas/events/config.ts).
This job reads the same two variables, with the same defaults and the same rule (a positive
integer, anything else refused), and deletes by age everything in the store that the promise
covers:

* **activity** (older than the events period, by receipt): raw lake objects and compacted hours
  of every hour partition that ended before the cutoff (manifest, Parquet files, raw objects),
  quarantined lines of those hours, the rows of datasets received before it (profiles last seen
  before it, account states set before it), and artefact versions computed as of before it
  (per-profile lists; the published one and the one before it are kept: they expire on their own);
* **totals** (older than the aggregates period): training runs (item-level models), evaluation
  reports, experiment results and the history of published pointers.

It holds the lake lease (lease.py) like the other jobs that rewrite the lake, writes its plan
(cutoffs and what it will remove) to `recs-work/retention/last-run.json` before deleting
anything, and is safe to rerun: a run that stops half-way leaves only older-than-cutoff objects,
which the next run deletes. Hours are deleted manifest first, then Parquet, then raw objects, so
a concurrent reader sees an expired hour either whole or without its compacted copy, never
twice.
"""

from __future__ import annotations

import io
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import polars as pl

from webflix_recs.ids import DAY_MS, HOUR_MS, iso_ms, parse_iso_ms, parse_partition
from webflix_recs.lake import COMPACTION_MANIFEST, EVENTS_PREFIX, QUARANTINE_PREFIX, list_hours
from webflix_recs.storage import Storage, get_json, open_storage, put_json

EVENTS_VARIABLE = "WEBFLIX_EVENTS_RETENTION_DAYS"
AGGREGATES_VARIABLE = "WEBFLIX_AGGREGATES_RETENTION_DAYS"
DEFAULT_EVENTS_DAYS = 396
DEFAULT_AGGREGATES_DAYS = 1126
RECORD_KEY = "recs-work/retention/last-run.json"


class RetentionConfigError(ValueError):
    """A retention variable is not a positive integer (CLI exit code 2, as the product refuses
    to start)."""


@dataclass(frozen=True)
class Periods:
    events_days: int
    aggregates_days: int

    @classmethod
    def from_environment(cls, env: Mapping[str, str] | None = None) -> Periods:
        env = os.environ if env is None else env
        values = []
        for name, default in (
            (EVENTS_VARIABLE, DEFAULT_EVENTS_DAYS),
            (AGGREGATES_VARIABLE, DEFAULT_AGGREGATES_DAYS),
        ):
            text = env.get(name)
            if text is None or text == "":
                values.append(default)
                continue
            if not text.strip().isdigit() or int(text) <= 0:
                raise RetentionConfigError(f"{name}: must be a positive integer, got {text!r}")
            values.append(int(text))
        return cls(values[0], values[1])


@dataclass
class RetentionOutcome:
    events_cutoff: str
    aggregates_cutoff: str
    removed: dict[str, int] = field(default_factory=dict)
    dry_run: bool = False

    def add(self, name: str, amount: int = 1) -> None:
        self.removed[name] = self.removed.get(name, 0) + amount

    def to_dict(self) -> dict[str, Any]:
        return {
            "eventsCutoff": self.events_cutoff,
            "aggregatesCutoff": self.aggregates_cutoff,
            "dryRun": self.dry_run,
            "removed": dict(sorted(self.removed.items())),
        }


def _expired_hours(storage: Storage, cutoff_ms: int) -> list[Any]:
    return [h for h in list_hours(storage, until_ms=cutoff_ms) if h.hour_ms + HOUR_MS <= cutoff_ms]


def _quarantine_keys(storage: Storage, cutoff_ms: int) -> list[str]:
    expired = []
    for info in storage.list(QUARANTINE_PREFIX):
        hour = parse_partition(EVENTS_PREFIX + info.key[len(QUARANTINE_PREFIX) :])
        if hour is not None and hour + HOUR_MS <= cutoff_ms:
            expired.append(info.key)
    return expired


def _dataset_pass(storage: Storage, cutoff_ms: int, out: RetentionOutcome, dry_run: bool) -> None:
    prefix = "recs-work/datasets/"
    rules = {"received_at": "received_at", "last_seen": "last_seen", "state_at": "state_at"}
    for info in list(storage.list(prefix)):
        if not info.key.endswith(".parquet"):
            continue
        body = storage.get(info.key)
        if body is None:
            continue
        columns = pl.read_parquet_schema(io.BytesIO(body))
        column = next((rules[name] for name in rules if name in columns), None)
        if column is None:
            continue
        frame = pl.read_parquet(io.BytesIO(body))
        expired = frame[column].fill_null(0) < cutoff_ms
        count = int(expired.sum())
        if not count:
            continue
        out.add("datasetRows", count)
        out.add("datasetTables")
        if dry_run:
            continue
        buffer = io.BytesIO()
        frame.filter(~expired).write_parquet(buffer, compression="zstd")
        storage.put(info.key, buffer.getvalue())
        manifest_key = info.key.rsplit("/", 1)[0] + "/manifest.json"
        manifest = get_json(storage, manifest_key)
        name = info.key.rsplit("/", 1)[1].removesuffix(".parquet")
        if isinstance(manifest, dict) and isinstance(manifest.get("rows"), dict):
            manifest["rows"][name] = frame.height - count
            manifest.setdefault("retention", {})["cutoff"] = iso_ms(cutoff_ms)
            put_json(storage, manifest_key, manifest)


def _versions_pass(storage: Storage, cutoff_ms: int, out: RetentionOutcome, dry_run: bool) -> None:
    pointer = get_json(storage, "recs/current.json") or {}
    protect = {pointer.get("run"), pointer.get("previous")}
    versions: dict[str, list[str]] = {}
    for info in storage.list("recs/v="):
        versions.setdefault(info.key[len("recs/v=") :].split("/", 1)[0], []).append(info.key)
    for run, keys in versions.items():
        if run in protect:
            continue
        manifest = get_json(storage, f"recs/v={run}/manifest.json") or {}
        as_of = manifest.get("asOf")
        if not isinstance(as_of, str) or parse_iso_ms(as_of) >= cutoff_ms:
            continue
        out.add("artefactVersions")
        if not dry_run:
            storage.delete(keys)


def _aggregates_pass(
    storage: Storage, cutoff_ms: int, out: RetentionOutcome, dry_run: bool
) -> None:
    # Training runs: by creation time; evaluations: by their cutoff; result runs and pointer
    # history: by the time in their name.
    runs: dict[str, list[str]] = {}
    for info in storage.list("recs-work/runs/"):
        runs.setdefault(info.key[len("recs-work/runs/") :].split("/", 1)[0], []).append(info.key)
    for run, keys in runs.items():
        manifest = get_json(storage, f"recs-work/runs/{run}/manifest.json") or {}
        created = manifest.get("createdAt")
        if isinstance(created, str) and parse_iso_ms(created) < cutoff_ms:
            out.add("trainingRuns")
            if not dry_run:
                storage.delete(keys)
    for info in list(storage.list("recs-work/evaluations/")):
        report = get_json(storage, info.key) or {}
        stamp = report.get("cutoff") or report.get("decidedAt")
        if isinstance(stamp, str) and parse_iso_ms(stamp) < cutoff_ms:
            out.add("evaluations")
            if not dry_run:
                storage.delete([info.key])
    results: dict[str, list[str]] = {}
    for info in storage.list("experiments/results/r="):
        results.setdefault(info.key.split("/")[2][2:], []).append(info.key)
    for name, keys in results.items():
        stamp = f"{name[0:4]}-{name[4:6]}-{name[6:8]}T{name[9:11]}:{name[11:13]}:{name[13:15]}Z"
        try:
            at = parse_iso_ms(stamp)
        except ValueError:
            continue
        if at < cutoff_ms:
            out.add("experimentResultRuns")
            if not dry_run:
                storage.delete(keys)
    for info in list(storage.list("recs/history/")):
        pointer = get_json(storage, info.key) or {}
        published = pointer.get("publishedAt")
        if isinstance(published, str) and parse_iso_ms(published) < cutoff_ms:
            out.add("publishedPointerHistory")
            if not dry_run:
                storage.delete([info.key])


def retain(
    location: str,
    *,
    periods: Periods,
    now_ms: int | None = None,
    dry_run: bool = False,
    take_lease: bool = True,
    log: Callable[[str], object] = print,
) -> RetentionOutcome:
    """Delete what the retention periods no longer cover (module docstring)."""
    from webflix_recs.lease import lake_lease  # noqa: PLC0415

    now = int(time.time() * 1000) if now_ms is None else now_ms
    storage = open_storage(location)
    if take_lease and not dry_run:
        with lake_lease(storage, "retain"):
            return retain(
                location, periods=periods, now_ms=now, dry_run=False, take_lease=False, log=log
            )
    events_cutoff = now - periods.events_days * DAY_MS
    aggregates_cutoff = now - periods.aggregates_days * DAY_MS
    out = RetentionOutcome(iso_ms(events_cutoff), iso_ms(aggregates_cutoff), dry_run=dry_run)
    hours = _expired_hours(storage, events_cutoff)
    quarantine = _quarantine_keys(storage, events_cutoff)
    plan = {
        "format": "webflix.retention-run",
        "formatVersion": 1,
        "startedAt": iso_ms(now),
        "eventsDays": periods.events_days,
        "aggregatesDays": periods.aggregates_days,
        "eventsCutoff": out.events_cutoff,
        "aggregatesCutoff": out.aggregates_cutoff,
        "hours": len(hours),
        "oldestHour": iso_ms(hours[0].hour_ms) if hours else None,
        "newestHour": iso_ms(hours[-1].hour_ms) if hours else None,
        "quarantineObjects": len(quarantine),
        "done": False,
    }
    if not dry_run:
        put_json(storage, RECORD_KEY, plan)
    log(f"retain: {len(hours)} hours received before {out.events_cutoff} expire")
    for hour in hours:
        out.add("hours")
        out.add("rawObjects", len(hour.ndjson))
        out.add("parquetFiles", len(hour.parquet))
        if dry_run:
            continue
        if hour.manifest is not None:
            storage.delete([hour.prefix + COMPACTION_MANIFEST])
        storage.delete([info.key for info in hour.parquet])
        storage.delete([info.key for info in hour.ndjson])
    out.add("quarantineObjects", len(quarantine))
    if not dry_run:
        storage.delete(quarantine)
    _dataset_pass(storage, events_cutoff, out, dry_run)
    _versions_pass(storage, events_cutoff, out, dry_run)
    _aggregates_pass(storage, aggregates_cutoff, out, dry_run)
    if not dry_run:
        put_json(storage, RECORD_KEY, {**plan, "done": True, "removed": out.to_dict()["removed"]})
    return out
