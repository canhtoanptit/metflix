"""A fast, event-level experiment generator, to calibrate `analyse-experiments`.

The full behaviour simulator (`webflix_recs.simulate`) exercises the event path but takes
seconds per run; checking a false-positive rate needs hundreds of independent experiments. This
generator produces the same rows the analysis reads (exposures and playback and billing
outcomes), with the features that make experiment statistics hard:

* staggered entry: units are first exposed uniformly over the first `entry_days`;
* zero inflation: a share of units never plays anything;
* heavy tails: play rates are gamma-distributed with shape below 1;
* samples: some sessions stop before the 30 s that make a play "qualified";
* churn: accounts cancel with a daily hazard and stop playing.

A planted effect multiplies the play rate of every non-control variant by `1 + effect`, so the
true relative lift on `qualified_plays` is `effect`. `to_events` turns an experiment into real
event envelopes (validated against the event schema) and `write_lake` stores them as the
ingestion consumer would, for end-to-end tests through the lake reader.
"""

from __future__ import annotations

import gzip
import math
from collections import defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import numpy as np
import orjson
import polars as pl

from webflix_recs import schemas
from webflix_recs.experiments.analysis import EXPOSURE_SCHEMA, OUTCOME_SCHEMA
from webflix_recs.ids import DAY_MS, floor_hour, iso_ms, parse_iso_ms, partition_prefix, uuid7

if TYPE_CHECKING:
    from webflix_recs.storage import Storage


@dataclass(frozen=True)
class SyntheticDesign:
    key: str = "recs-aa"
    units: int = 3000
    days: int = 14
    entry_days: float = 7.0
    variants: tuple[tuple[str, float], ...] = (("control", 0.5), ("treatment", 0.5))
    effect: float = 0.0
    zero_share: float = 0.35
    rate_shape: float = 0.6
    rate_mean: float = 0.45
    short_share: float = 0.15
    churn_daily: float = 0.004
    drop_treatment_exposures: float = 0.0
    start: str = "2026-09-01T00:00:00.000Z"
    alpha: float = 0.05
    mde: float = 0.10
    primary_metric: str = "qualified_plays"

    @property
    def start_ms(self) -> int:
        return parse_iso_ms(self.start)

    @property
    def end_ms(self) -> int:
        return self.start_ms + self.days * DAY_MS

    def definition(self) -> dict[str, Any]:
        """The pre-registered definition of this experiment."""
        return {
            "key": self.key,
            "variants": [{"name": name, "weight": weight} for name, weight in self.variants],
            "unit": "profile",
            "primaryMetric": self.primary_metric,
            "secondaryMetrics": [
                m
                for m in ("watch_hours", "any_play", "active_days", "retained")
                if m != self.primary_metric
            ],
            "alpha": self.alpha,
            "power": 0.8,
            "minimumDetectableEffect": self.mde,
            "registeredAt": iso_ms(self.start_ms - DAY_MS),
            "startsAt": self.start,
            "endsAt": iso_ms(self.end_ms),
            "analysis": {"method": "msprt", "looks": "daily"},
            "srmThreshold": 0.001,
        }

    def definitions(self) -> dict[str, Any]:
        return {
            "format": "webflix.experiment-definitions",
            "formatVersion": 1,
            "experiments": [self.definition()],
        }


@dataclass
class SyntheticExperiment:
    design: SyntheticDesign
    exposures: pl.DataFrame  # EXPOSURE_SCHEMA
    outcomes: pl.DataFrame  # OUTCOME_SCHEMA
    variant_of: dict[str, str]


def profile_key(index: int) -> str:
    """A string that satisfies the pseudonymous key pattern (22 characters of [A-Za-z0-9_-])."""
    return f"p{index:021d}"


def account_key(index: int) -> str:
    return f"a{index:021d}"


def generate(design: SyntheticDesign, seed: int) -> SyntheticExperiment:
    rng = np.random.default_rng([seed, 11])
    n = design.units
    start, end = design.start_ms, design.end_ms
    names = [name for name, _ in design.variants]
    weights = np.array([weight for _, weight in design.variants], dtype=np.float64)
    variant = rng.choice(len(names), size=n, p=weights / weights.sum())
    entry = start + (rng.random(n) * design.entry_days * DAY_MS).astype(np.int64)
    player = rng.random(n) >= design.zero_share
    rate = np.where(
        player, rng.gamma(design.rate_shape, design.rate_mean / design.rate_shape, n), 0.0
    )
    rate = rate * np.where(variant > 0, 1.0 + design.effect, 1.0)
    cancel = entry + (rng.exponential(1.0 / design.churn_daily, n) * DAY_MS).astype(np.int64)
    active_until = np.minimum(cancel, end)
    duration = np.maximum(active_until - entry, 0)
    counts = rng.poisson(rate * duration / DAY_MS)
    unit = np.repeat(np.arange(n), counts)
    total = len(unit)
    when = entry[unit] + (rng.random(total) * duration[unit]).astype(np.int64)
    short = rng.random(total) < design.short_share
    watched = np.where(
        short,
        rng.uniform(1.0, 29.0, total),
        np.minimum(rng.lognormal(math.log(1500.0), 0.9, total), 4 * 3600.0),
    )
    profiles = [profile_key(i) for i in range(n)]
    accounts = [account_key(i) for i in range(n)]
    exposed = np.ones(n, dtype=bool)
    if design.drop_treatment_exposures > 0:
        exposed &= ~((variant > 0) & (rng.random(n) < design.drop_treatment_exposures))
    # One exposure at entry, then one per session (the treatment is experienced each visit).
    exposure_unit = np.concatenate([np.flatnonzero(exposed), unit[exposed[unit]]])
    exposure_time = np.concatenate([entry[exposed], when[exposed[unit]]])
    exposures = pl.DataFrame(
        {
            "profile": [profiles[i] for i in exposure_unit],
            "account": [accounts[i] for i in exposure_unit],
            "experiment_key": [design.key] * len(exposure_unit),
            "variant": [names[variant[i]] for i in exposure_unit],
            "occurred_at": exposure_time,
            "restricted": np.zeros(len(exposure_unit), dtype=bool),
            "analytics": np.ones(len(exposure_unit), dtype=bool),
        },
        schema=EXPOSURE_SCHEMA,
    )
    # Playback session ids as the analysis holds them (64-bit); events carry `pb<hex>`.
    sessions = [int(seed) << 32 | i for i in range(total)]
    end_time = when + (watched * 1000).astype(np.int64)
    churned = np.flatnonzero(cancel < end)
    playback_rows = 2 * total
    outcomes = pl.DataFrame(
        {
            "profile": [profiles[i] for i in unit] * 2 + [None] * len(churned),
            "account": [accounts[i] for i in unit] * 2 + [accounts[i] for i in churned],
            "type": [schemas.PLAYBACK_START] * total
            + [schemas.PLAYBACK_ABANDON] * total
            + [schemas.BILLING_TRANSITION] * len(churned),
            "occurred_at": np.concatenate([when, end_time, cancel[churned]]),
            "playback_id": sessions * 2 + [None] * len(churned),
            "watched_sec": np.concatenate(
                [np.zeros(total), watched, np.full(len(churned), np.nan)]
            ),
            "state_to": [None] * playback_rows + ["canceled"] * len(churned),
        },
        schema=OUTCOME_SCHEMA,
        nan_to_null=True,
    )
    return SyntheticExperiment(
        design, exposures, outcomes, {profiles[i]: names[variant[i]] for i in range(n)}
    )


# --- Real events ------------------------------------------------------------------------------


def _subject(
    profile: str | None, account: str, *, restricted: bool = False, analytics: bool = True
) -> dict[str, Any]:
    return {
        "account": account,
        "profile": profile,
        "plan": "standard",
        "country": "US",
        "restricted": restricted,
        "consent": {"analytics": analytics, "personalisation": True},
    }


def _context(experiments: dict[str, str], surface: str | None) -> dict[str, Any]:
    return {
        "surface": surface,
        "rowId": None,
        "rowRank": None,
        "rank": None,
        "experiments": experiments,
        "policy": None,
    }


def to_events(experiment: SyntheticExperiment, seed: int) -> list[dict[str, Any]]:
    """The experiment's rows as validated server events (exposure, playback, billing)."""
    rng = np.random.default_rng([seed, 12])
    key = experiment.design.key
    events: list[dict[str, Any]] = []

    def envelope(
        kind: str,
        at: int,
        subject: dict[str, Any],
        context: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        event = {
            "eventId": uuid7(at, int.from_bytes(rng.bytes(10), "big")),
            "type": kind,
            "version": 1,
            "source": "server",
            "occurredAt": iso_ms(at),
            "receivedAt": iso_ms(at + int(rng.integers(5, 400))),
            "deviceId": None,
            "sessionSeq": None,
            "app": {"platform": "server", "version": "2.0.0"},
            "context": context,
            "subject": subject,
            "payload": payload,
        }
        schemas.validate_event(event)
        return event

    for profile, account, variant, at in experiment.exposures.select(
        "profile", "account", "variant", "occurred_at"
    ).iter_rows():
        events.append(
            envelope(
                schemas.EXPOSURE,
                int(at),
                _subject(profile, account),
                _context({key: variant}, "home"),
                {"experimentKey": key, "variant": variant, "unitType": "profile"},
            )
        )
    for profile, account, kind, at, playback, watched, _ in experiment.outcomes.iter_rows():
        if kind == schemas.BILLING_TRANSITION:
            events.append(
                envelope(
                    kind,
                    int(at),
                    _subject(None, account),
                    _context({}, None),
                    {"from": "active", "to": "canceled", "planId": "standard"},
                )
            )
            continue
        variant = experiment.variant_of.get(profile, "control")
        payload: dict[str, Any] = {
            "playbackSessionId": f"pb{playback:016x}",
            "titleId": "t-synthetic",
            "episodeId": None,
            "positionSec": float(watched),
            "durationSec": 5400.0,
            "watchedSec": float(watched),
        }
        if kind == schemas.PLAYBACK_ABANDON:
            payload["reason"] = "closed"
        events.append(
            envelope(
                kind,
                int(at),
                _subject(profile, account),
                _context({key: variant}, "player"),
                payload,
            )
        )
    return events


def write_lake(storage: Storage, events: list[dict[str, Any]], *, seed: int = 0) -> int:
    """Store events as the ingestion consumer would: one gzip NDJSON object per receipt hour."""
    hours: dict[int, list[bytes]] = defaultdict(list)
    for event in events:
        hours[floor_hour(parse_iso_ms(event["receivedAt"]))].append(orjson.dumps(event))
    rng = np.random.default_rng([seed, 13])
    for hour, lines in sorted(hours.items()):
        name = uuid7(hour, int.from_bytes(rng.bytes(10), "big"))
        body = gzip.compress(b"\n".join(lines) + b"\n", mtime=0)
        storage.put(f"{partition_prefix(hour)}{name}.ndjson.gz", body)
    return len(hours)
