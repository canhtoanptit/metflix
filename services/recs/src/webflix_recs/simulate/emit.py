"""Turning simulated behaviour into lake events, kept apart from where they go.

Generation (`behaviour.py`) calls an `Emitter`, which builds and validates the envelope exactly
as the ingestion endpoint would store it (server-added subject, receipt time, delivery faults).
The emitter hands each finished event to a `Sink`:

* `LakeSink` writes what the ingestion consumer would write: gzip NDJSON objects under
  `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz`, partitioned by receipt time.
* `MemorySink` keeps them in memory (tests).

A replay mode for the real `POST /events` endpoint (not built yet) plugs in as another sink:
it would post the client events of each app session in batches of at most 50 events and
64 KiB, dropping the server-added fields (`receivedAt`, `subject`), and drive the playback
routes for the server events instead of posting them. Nothing in generation would change.
"""

from __future__ import annotations

import gzip
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np
import orjson

from webflix_recs import schemas
from webflix_recs.ids import HOUR_MS, floor_hour, iso_ms, partition_prefix, uuid7
from webflix_recs.storage import Storage


class Sink(Protocol):
    def write(self, event: dict[str, Any], received_ms: int) -> None: ...

    def flush_before(self, received_ms: int) -> None:
        """Every event with receipt time before `received_ms` has been written."""
        ...

    def close(self) -> None: ...


class MemorySink:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def write(self, event: dict[str, Any], received_ms: int) -> None:  # noqa: ARG002 - Sink protocol
        self.events.append(event)

    def flush_before(self, received_ms: int) -> None:  # noqa: ARG002 - Sink protocol
        return None

    def close(self) -> None:
        return None


class LakeSink:
    """Buffers events by receipt hour; writes one gzip NDJSON object per hour and shard."""

    def __init__(self, storage: Storage, *, shard: int, seed: int, compress_level: int = 6) -> None:
        self.storage = storage
        self.shard = shard
        self.seed = seed
        self.level = compress_level
        self._hours: dict[int, list[bytes]] = defaultdict(list)
        self.objects = 0
        self.events = 0
        self.bytes = 0

    def write(self, event: dict[str, Any], received_ms: int) -> None:
        self._hours[floor_hour(received_ms)].append(orjson.dumps(event))

    def flush_before(self, received_ms: int) -> None:
        for hour in sorted(h for h in self._hours if h + HOUR_MS <= received_ms):
            self._write(hour)

    def close(self) -> None:
        for hour in sorted(self._hours):
            self._write(hour)

    def _write(self, hour: int) -> None:
        lines = self._hours.pop(hour)
        body = gzip.compress(b"\n".join(lines) + b"\n", compresslevel=self.level, mtime=0)
        # Deterministic object name: a UUIDv7 on the hour, random bits from (seed, shard, hour).
        bits = int.from_bytes(
            np.random.default_rng([self.seed, 9, self.shard, hour // HOUR_MS]).bytes(10), "big"
        )
        name = uuid7(hour + self.shard % HOUR_MS, bits)
        self.storage.put(
            f"{partition_prefix(hour)}{name}.ndjson.gz", body, content_type="application/gzip"
        )
        self.objects += 1
        self.events += len(lines)
        self.bytes += len(body)


@dataclass(slots=True)
class Device:
    id: str
    platform: str
    skew_ms: int


@dataclass(slots=True)
class AppSession:
    device: Device
    seq: int = 0
    late_ms: int = 0
    sampled: bool = True

    def next_seq(self) -> int:
        value = self.seq
        self.seq += 1
        return value


@dataclass(slots=True)
class Subject:
    account: str | None
    profile: str | None
    plan: str | None
    country: str | None
    restricted: bool
    analytics: bool
    personalisation: bool

    def stamp(self) -> dict[str, Any]:
        return {
            "account": self.account,
            "profile": self.profile,
            "plan": self.plan,
            "country": self.country,
            "restricted": self.restricted,
            "consent": {"analytics": self.analytics, "personalisation": self.personalisation},
        }


def context(
    *,
    surface: str | None = None,
    row_id: str | None = None,
    row_rank: int | None = None,
    rank: int | None = None,
    experiments: dict[str, str] | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "surface": surface,
        "rowId": row_id,
        "rowRank": row_rank,
        "rank": rank,
        "experiments": experiments or {},
        "policy": policy,
    }


@dataclass(slots=True)
class Emitter:
    sink: Sink
    rng: np.random.Generator
    app_version: str
    duplicate_rate: float
    validate: bool = True
    counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def client(
        self,
        kind: str,
        at_ms: int,
        session: AppSession,
        subject: Subject,
        ctx: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        occurred = at_ms + session.device.skew_ms
        received = at_ms + int(self.rng.integers(60, 1500)) + session.late_ms
        event = {
            "eventId": uuid7(max(occurred, 0), int.from_bytes(self.rng.bytes(10), "big")),
            "type": kind,
            "version": 1,
            "source": "client",
            "occurredAt": iso_ms(occurred),
            "receivedAt": iso_ms(received),
            "deviceId": session.device.id,
            "sessionSeq": session.next_seq(),
            "app": {"platform": session.device.platform, "version": self.app_version},
            "context": ctx,
            "subject": subject.stamp(),
            "payload": payload,
        }
        self._emit(event, received)

    def server(
        self,
        kind: str,
        at_ms: int,
        subject: Subject,
        ctx: dict[str, Any],
        payload: dict[str, Any],
        *,
        device_id: str | None = None,
    ) -> None:
        received = at_ms + int(self.rng.integers(5, 400))
        event = {
            "eventId": uuid7(at_ms, int.from_bytes(self.rng.bytes(10), "big")),
            "type": kind,
            "version": 1,
            "source": "server",
            "occurredAt": iso_ms(at_ms),
            "receivedAt": iso_ms(received),
            "deviceId": device_id,
            "sessionSeq": None,
            "app": {"platform": "server", "version": self.app_version},
            "context": ctx,
            "subject": subject.stamp(),
            "payload": payload,
        }
        self._emit(event, received)

    def _emit(self, event: dict[str, Any], received_ms: int) -> None:
        if self.validate:
            errors = schemas.event_errors(event)
            if errors:
                raise ValueError(f"simulator produced an invalid {event['type']} event: {errors}")
        self.sink.write(event, received_ms)
        self.counts[event["type"]] += 1
        if self.rng.random() < self.duplicate_rate:
            # At-least-once delivery: a queue redelivery (same receipt) or a client retry that
            # the endpoint accepted again (later receipt). Same eventId either way.
            if self.rng.random() < 0.5:
                self.sink.write(event, received_ms)
            else:
                delay = int(self.rng.integers(1_000, 6 * HOUR_MS))
                again = dict(event, receivedAt=iso_ms(received_ms + delay))
                self.sink.write(again, received_ms + delay)
            self.counts["duplicates"] += 1
