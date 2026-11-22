"""Turning simulated behaviour into lake events, kept apart from where they go.

Generation (`behaviour.py`) calls an `Emitter`, which builds and validates the envelope exactly
as the ingestion endpoint would store it (server-added subject, receipt time, delivery faults),
then applies the product's collection rules (packages/core/src/areas/events/collector.ts and
the experiments area) so the lake holds only what the real writer would store:

* a restricted profile (kids, or a lowered maturity ceiling) produces no event at all, client or
  server (`restricted: true` never reaches the lake);
* an account with no consented purpose (neither analytics nor personalisation) produces nothing
  but its `consent.change` events;
* an exposure is logged once per unit and variant per 30 days (the product's exposure marker).

Suppression happens after every random draw for the event (receipt jitter, event id, the
duplicate decision), so the random streams and every stored event are exactly what they would
be without it: switching a rule on or off changes nothing else in the lake. The emitter hands
each stored event to a `Sink`:

* `LakeSink` writes gzip NDJSON objects under `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz`,
  partitioned by receipt time: one object per hour and shard (`hourly`, the default: fast), or
  shaped like the product's writer (`writer`: a client batch of at most 50 events and 64 KiB
  per device, an outbox drain of at most 100 playback events, one object per other server
  event) to exercise compaction and erasure at realistic object counts.
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
from webflix_recs.ids import HOUR_MS, floor_hour, iso_ms, parse_iso_ms, partition_prefix, uuid7
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


CLIENT_BATCH_EVENTS = 50
CLIENT_BATCH_BYTES = 64 * 1024
OUTBOX_BATCH = 100


def writer_objects(lines: list[bytes]) -> list[list[bytes]]:
    """Group one hour's events the way the product's writer stores them: client events per
    device in batches of at most 50 events and 64 KiB, playback events in outbox drains of at
    most 100, every other server event alone."""
    client: dict[str, list[list[bytes]]] = defaultdict(list)
    playback: list[list[bytes]] = []
    single: list[list[bytes]] = []
    for line in lines:
        event = orjson.loads(line)
        if event["source"] == "client":
            batches = client[event["deviceId"]]
            if (
                not batches
                or len(batches[-1]) >= CLIENT_BATCH_EVENTS
                or sum(len(item) + 1 for item in batches[-1]) + len(line) > CLIENT_BATCH_BYTES
            ):
                batches.append([])
            batches[-1].append(line)
        elif event["type"].startswith("playback."):
            if not playback or len(playback[-1]) >= OUTBOX_BATCH:
                playback.append([])
            playback[-1].append(line)
        else:
            single.append([line])
    objects = [batch for device in sorted(client) for batch in client[device]]
    return objects + playback + single


class LakeSink:
    """Buffers events by receipt hour; writes gzip NDJSON objects per hour and shard."""

    def __init__(
        self,
        storage: Storage,
        *,
        shard: int,
        seed: int,
        compress_level: int = 6,
        layout: str = "hourly",
    ) -> None:
        if layout not in {"hourly", "writer"}:
            raise ValueError(f"unknown object layout {layout!r}")
        self.storage = storage
        self.shard = shard
        self.seed = seed
        self.level = compress_level
        self.layout = layout
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
        groups = [lines] if self.layout == "hourly" else writer_objects(lines)
        # Deterministic object names: UUIDv7s on the hour, random bits from (seed, shard, hour).
        rng = np.random.default_rng([self.seed, 9, self.shard, hour // HOUR_MS])
        for index, group in enumerate(groups):
            body = gzip.compress(b"\n".join(group) + b"\n", compresslevel=self.level, mtime=0)
            bits = int.from_bytes(rng.bytes(10), "big")
            name = uuid7(hour + (self.shard % HOUR_MS if index == 0 else index % HOUR_MS), bits)
            self.storage.put(
                f"{partition_prefix(hour)}{name}.ndjson.gz", body, content_type="application/gzip"
            )
            self.objects += 1
            self.events += len(group)
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


EXPOSURE_MARKER_MS = 30 * 24 * HOUR_MS


@dataclass(slots=True)
class Emitter:
    sink: Sink
    rng: np.random.Generator
    app_version: str
    duplicate_rate: float
    validate: bool = True
    #: Apply the product's collection rules (module docstring). Off only to measure their effect.
    collect_like_the_product: bool = True
    counts: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    _exposed: dict[str, int] = field(default_factory=dict)

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
        receipt_delay_ms: int = 0,
    ) -> None:
        # `receipt_delay_ms`: received later than it happened by more than the queue's jitter
        # (a playback session nobody released is ended by a sweep minutes after its last report).
        received = at_ms + int(self.rng.integers(5, 400)) + receipt_delay_ms
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
            # The product stamps server events without a country (it only knows the request's).
            "subject": {**subject.stamp(), "country": None},
            "payload": payload,
        }
        self._emit(event, received)

    def _suppressed(self, event: dict[str, Any]) -> str | None:
        """Why the product would not store this event, or None (module docstring)."""
        if not self.collect_like_the_product:
            return None
        subject = event["subject"]
        if subject["restricted"]:
            return "restricted"
        consent = subject["consent"]
        if (
            event["type"] != schemas.CONSENT_CHANGE
            and not consent["analytics"]
            and not consent["personalisation"]
        ):
            return "noConsent"
        if event["type"] == schemas.EXPOSURE:
            payload = event["payload"]
            unit = subject["profile"] if payload["unitType"] == "profile" else event["deviceId"]
            marker = f"{payload['experimentKey']}:{payload['variant']}:{payload['unitType']}:{unit}"
            at = parse_iso_ms(event["occurredAt"])
            last = self._exposed.get(marker)
            if last is not None and at - last < EXPOSURE_MARKER_MS:
                return "exposureRepeat"
            self._exposed[marker] = at
        return None

    def _emit(self, event: dict[str, Any], received_ms: int) -> None:
        if self.validate:
            errors = schemas.event_errors(event)
            if errors:
                raise ValueError(f"simulator produced an invalid {event['type']} event: {errors}")
        reason = self._suppressed(event)
        if reason is None:
            self.sink.write(event, received_ms)
            self.counts[event["type"]] += 1
        else:
            self.counts[f"suppressed.{reason}"] += 1
        if self.rng.random() < self.duplicate_rate:
            # At-least-once delivery: a queue redelivery (same receipt) or a client retry that
            # the endpoint accepted again (a later receipt; client events only). Same eventId
            # either way. The draws happen whether or not the event is stored, so suppression
            # perturbs nothing else.
            if self.rng.random() < 0.5:
                again, at = event, received_ms
            else:
                delay = int(self.rng.integers(1_000, 6 * HOUR_MS))
                again, at = dict(event, receivedAt=iso_ms(received_ms + delay)), received_ms + delay
                if event["source"] == "server":
                    # A server event is stamped once, when emitted: a job retry or a second
                    # outbox drain stores it again with the same receipt, never a later one.
                    again, at = event, received_ms
            if reason is None:
                self.sink.write(again, at)
                self.counts["duplicates"] += 1
