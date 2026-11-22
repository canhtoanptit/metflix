"""Identifiers and times: UUIDv7, pseudonymous keys, ISO instants, lake partitions."""

from __future__ import annotations

import base64
import functools
import hashlib
import hmac
from datetime import UTC, datetime
from typing import Final

DAY_MS: Final = 86_400_000
HOUR_MS: Final = 3_600_000


def uuid7(unix_ms: int, random_bits: int) -> str:
    """A UUIDv7 (RFC 9562) from a millisecond timestamp and 74 random bits.

    The randomness is passed in so that a seeded simulator produces the same ids every run.
    """
    if not 0 <= unix_ms < 1 << 48:
        raise ValueError("timestamp out of range for UUIDv7")
    rand_a = (random_bits >> 62) & 0xFFF
    rand_b = random_bits & ((1 << 62) - 1)
    value = (unix_ms << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    text = f"{value:032x}"
    return f"{text[:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:]}"


def pseudonym(key: bytes, kind: str, internal_id: str) -> str:
    """The lake's pseudonymous key for an internal id: HMAC-SHA256(key, "{kind}:{id}"),
    base64url without padding, first 22 characters (128 bits).

    `kind` is `account` or `profile`. The serving side computes the same function to find a
    profile's recommendation list (README: Pseudonymous keys).
    """
    digest = hmac.new(key, f"{kind}:{internal_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii")[:22]


@functools.lru_cache(maxsize=4096)
def _minute_prefix(minute: int) -> str:
    return datetime.fromtimestamp(minute * 60, tz=UTC).strftime("%Y-%m-%dT%H:%M:")


def iso_ms(unix_ms: int) -> str:
    """`2026-10-27T13:05:00.123Z`, exactly as `Date.prototype.toISOString()` prints it."""
    minute, rest = divmod(unix_ms, 60_000)
    return f"{_minute_prefix(minute)}{rest // 1000:02d}.{rest % 1000:03d}Z"


def parse_iso_ms(text: str) -> int:
    """Parse an RFC 3339 instant (Z or offset) to epoch milliseconds."""
    value = text.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return round(moment.timestamp() * 1000)


def utc_day(unix_ms: int) -> str:
    return datetime.fromtimestamp(unix_ms / 1000, tz=UTC).strftime("%Y-%m-%d")


def partition_prefix(unix_ms: int) -> str:
    """The lake partition of an instant: `events/dt=YYYY-MM-DD/hh=HH/` (blueprint §6.2)."""
    moment = datetime.fromtimestamp(unix_ms / 1000, tz=UTC)
    return f"events/dt={moment:%Y-%m-%d}/hh={moment:%H}/"


def parse_partition(key: str) -> int | None:
    """Start (epoch ms) of the hour partition a lake key belongs to, or None."""
    parts = key.split("/")
    if len(parts) < 4 or parts[0] != "events":
        return None
    if not (parts[1].startswith("dt=") and parts[2].startswith("hh=")):
        return None
    try:
        moment = datetime.strptime(f"{parts[1][3:]} {parts[2][3:]}", "%Y-%m-%d %H").replace(
            tzinfo=UTC
        )
    except ValueError:
        return None
    return int(moment.timestamp() * 1000)


def floor_hour(unix_ms: int) -> int:
    return unix_ms - unix_ms % HOUR_MS
