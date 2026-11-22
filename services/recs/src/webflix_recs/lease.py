"""The lake lease: compaction, erasure and exports never run at the same time.

Compaction and erasure rewrite hour partitions (a new Parquet file, a manifest flip, deletions);
run concurrently they could undo each other (an erasure flipping a manifest back to a Parquet
file it cleaned while a compaction had folded, and with `--delete-sources` deleted, newer raw
objects into another), and an export could read an hour an erasure is rewriting. So each takes
the lease `recs-work/locks/lake.json` first and refuses to start while someone else holds it
(exit code 75: try again later). Readers that are not jobs on the lake (train-and-score,
analyse-experiments, the product's inline export reader) never take it: every rewrite is safe
for a concurrent reader.

**The lease only works where a create-only write works.** It is created with `put_if_absent`:
a hard link on the filesystem layout, `PutObject` with `If-None-Match: *` on an S3-compatible
store. AWS S3 honours that header and R2 documents that it evaluates it atomically, but Garage
(v2.5.0) accepts it and overwrites anyway: there every job would "acquire" the lease. So before
the first acquisition in a process, the store is probed (a create-only write twice on a scratch
key: the second must be refused). A store that fails the probe, or refuses conditional writes
outright, makes `acquire` raise `LeaseUnsupported` (CLI exit code 10, with the reason): a lock
that cannot work never reports success. Where the scheduler itself serialises the three jobs
(one CronJob running them one after another with `concurrencyPolicy: Forbid`, as the chart does
with Garage), declare it with `WEBFLIX_RECS_LAKE_SERIALIZED=true` (or `--lake-serialized`): the
lease is then neither probed nor taken, and each job's summary says `"lakeLease": "scheduler"`
instead of `"held"`.

A lease names its holder and expires (default 6 hours), so a job killed half-way does not block
the lake for ever: an expired lease is taken over.
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import orjson

from webflix_recs.ids import iso_ms, parse_iso_ms
from webflix_recs.storage import ConditionalWriteUnsupported, Storage, get_json

LAKE_LEASE_KEY = "recs-work/locks/lake.json"
PROBE_PREFIX = "recs-work/locks/probe-"
DEFAULT_TTL_MS = 6 * 3_600_000
SERIALIZED_ENV = "WEBFLIX_RECS_LAKE_SERIALIZED"
SCHEDULER = "scheduler"

#: How the last acquisition in this process was made (`held` or `scheduler`), for summaries.
LAST_MODE: str | None = None
_PROBED: dict[str, str | None] = {}


class LakeBusy(RuntimeError):
    """Another job holds the lake lease (CLI exit code 75)."""


class LeaseUnsupported(RuntimeError):
    """The store cannot hold the lease (CLI exit code 10): it ignores or refuses create-only
    writes, and nothing declared that the scheduler serialises the lake jobs."""


def last_mode() -> str | None:
    """How the last acquisition in this process was made: `held`, `scheduler`, or None."""
    return LAST_MODE


def serialized_by_scheduler() -> bool:
    return os.environ.get(SERIALIZED_ENV, "").strip().lower() in {"1", "true", "yes"}


def conditional_write_problem(storage: Storage) -> str | None:
    """Why the store cannot do a create-only write, or None when it can (probed once per store
    and process: two create-only writes on a scratch key, the second must be refused)."""
    where = storage.describe()
    if where in _PROBED:
        return _PROBED[where]
    key = f"{PROBE_PREFIX}{uuid.uuid4().hex}.json"
    problem: str | None = None
    try:
        first = storage.put_if_absent(key, b'{"probe":1}', content_type="application/json")
        second = storage.put_if_absent(key, b'{"probe":2}', content_type="application/json")
        if not first:
            problem = f"{where} refused a create-only write of a new key"
        elif second:
            problem = (
                f"{where} accepted a create-only write (If-None-Match: *) onto an existing key "
                "and overwrote it: it ignores conditional writes (Garage does), so the lake "
                "lease cannot keep compact, erase and export-events apart"
            )
    except ConditionalWriteUnsupported as error:
        problem = f"{error}: the lake lease cannot keep compact, erase and export-events apart"
    finally:
        storage.delete([key])
    _PROBED[where] = problem
    return problem


def _document(holder: str, job: str, now_ms: int, ttl_ms: int) -> bytes:
    return orjson.dumps(
        {
            "format": "webflix.lake-lease",
            "formatVersion": 1,
            "holder": holder,
            "job": job,
            "acquiredAt": iso_ms(now_ms),
            "expiresAt": iso_ms(now_ms + ttl_ms),
        }
    )


def acquire(
    storage: Storage, job: str, *, ttl_ms: int = DEFAULT_TTL_MS, now_ms: int | None = None
) -> str:
    """Take the lease for `job`; returns the holder token (`scheduler` when the scheduler is
    declared to serialise the lake jobs). Raises `LakeBusy` or `LeaseUnsupported`."""
    global LAST_MODE  # noqa: PLW0603 - one process, one job: the summary reports it
    if serialized_by_scheduler():
        LAST_MODE = SCHEDULER
        print(
            f"lake lease not taken: {SERIALIZED_ENV} declares that the scheduler runs compact, "
            "erase and export-events one at a time",
            file=sys.stderr,
            flush=True,
        )
        return SCHEDULER
    problem = conditional_write_problem(storage)
    if problem is not None:
        raise LeaseUnsupported(
            f"{problem}. Refusing to run {job} unprotected. If the scheduler runs these jobs one "
            f"at a time, set {SERIALIZED_ENV}=true (or pass --lake-serialized)."
        )
    now = int(time.time() * 1000) if now_ms is None else now_ms
    holder = uuid.uuid4().hex
    body = _document(holder, job, now, ttl_ms)
    if storage.put_if_absent(LAKE_LEASE_KEY, body, content_type="application/json"):
        LAST_MODE = "held"
        return holder
    current: dict[str, Any] = get_json(storage, LAKE_LEASE_KEY) or {}
    expires = current.get("expiresAt")
    if isinstance(expires, str) and parse_iso_ms(expires) <= now:
        # Expired: its holder died. Remove it and race for a fresh one (one winner).
        storage.delete([LAKE_LEASE_KEY])
        if storage.put_if_absent(LAKE_LEASE_KEY, body, content_type="application/json"):
            LAST_MODE = "held"
            return holder
        current = get_json(storage, LAKE_LEASE_KEY) or {}
    raise LakeBusy(
        f"the lake is busy: {current.get('job', 'another job')} holds {LAKE_LEASE_KEY} "
        f"until {current.get('expiresAt', '?')}"
    )


def release(storage: Storage, holder: str) -> None:
    """Drop the lease if (and only if) it is still ours."""
    if holder == SCHEDULER:
        return
    current = get_json(storage, LAKE_LEASE_KEY) or {}
    if current.get("holder") == holder:
        storage.delete([LAKE_LEASE_KEY])


@contextmanager
def lake_lease(storage: Storage, job: str, *, ttl_ms: int = DEFAULT_TTL_MS) -> Iterator[str]:
    holder = acquire(storage, job, ttl_ms=ttl_ms)
    try:
        yield holder
    finally:
        release(storage, holder)
