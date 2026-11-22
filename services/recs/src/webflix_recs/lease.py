"""The lake lease: compaction and erasure never run at the same time.

Both rewrite hour partitions (a new Parquet file, a manifest flip, deletions). Run concurrently
they could undo each other: an erasure flipping a manifest back to a Parquet file it cleaned
while a compaction had folded (and, with `--delete-sources`, deleted) newer raw objects into
another. So each takes the lease `recs-work/locks/lake.json` first and refuses to start while
someone else holds it (exit code 75: try again later).

The lease is created with `put_if_absent`: atomic on the filesystem layout and on stores that
honour `If-None-Match: *` on `PutObject` (AWS S3; verified here against moto only); on a store
that answers `NotImplemented` it degrades to check-then-write, and the scheduling rule in the
README (one lake job at a time) is what remains. A lease names its holder and expires
(default 6 hours), so a job killed half-way does not block the lake forever: an expired lease is
taken over. Readers (the pipeline's own, the
product's data export) never take it: every rewrite is safe for a concurrent reader.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import orjson

from webflix_recs.ids import iso_ms, parse_iso_ms
from webflix_recs.storage import Storage, get_json

LAKE_LEASE_KEY = "recs-work/locks/lake.json"
DEFAULT_TTL_MS = 6 * 3_600_000


class LakeBusy(RuntimeError):
    """Another job holds the lake lease (CLI exit code 75)."""


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
    """Take the lease for `job`; returns the holder token. Raises `LakeBusy`."""
    now = int(time.time() * 1000) if now_ms is None else now_ms
    holder = uuid.uuid4().hex
    body = _document(holder, job, now, ttl_ms)
    if storage.put_if_absent(LAKE_LEASE_KEY, body, content_type="application/json"):
        return holder
    current: dict[str, Any] = get_json(storage, LAKE_LEASE_KEY) or {}
    expires = current.get("expiresAt")
    if isinstance(expires, str) and parse_iso_ms(expires) <= now:
        # Expired: its holder died. Remove it and race for a fresh one (one winner).
        storage.delete([LAKE_LEASE_KEY])
        if storage.put_if_absent(LAKE_LEASE_KEY, body, content_type="application/json"):
            return holder
        current = get_json(storage, LAKE_LEASE_KEY) or {}
    raise LakeBusy(
        f"the lake is busy: {current.get('job', 'another job')} holds {LAKE_LEASE_KEY} "
        f"until {current.get('expiresAt', '?')}"
    )


def release(storage: Storage, holder: str) -> None:
    """Drop the lease if (and only if) it is still ours."""
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
