"""Simulator configuration and size presets."""

from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field, replace
from typing import Any

from webflix_recs.ids import DAY_MS, parse_iso_ms


@dataclass(frozen=True, slots=True)
class ExperimentSpec:
    """An experiment the simulated platform runs. Assignment is deterministic per profile
    (hash of salt, key and the profile's pseudonymous key); the treatment multiplies the
    profile's session rate by `1 + effect` (0 for an A/A test), a planted effect of known size
    on visits and hence on qualified plays per member."""

    key: str
    variants: tuple[tuple[str, float], ...] = (("control", 0.5), ("treatment", 0.5))
    effect: float = 0.0
    treatment: str = "treatment"
    salt: str = "sim"

    @classmethod
    def parse(cls, text: str) -> ExperimentSpec:
        """`key[:effect=0.1][:variants=control=50,treatment=50]`."""
        parts = text.split(":")
        key = parts[0]
        effect = 0.0
        variants: tuple[tuple[str, float], ...] = (("control", 0.5), ("treatment", 0.5))
        for part in parts[1:]:
            name, _, value = part.partition("=")
            if name == "effect":
                effect = float(value)
            elif name == "variants":
                pairs = [item.split("=") for item in value.split(",")]
                total = sum(float(weight) for _, weight in pairs)
                variants = tuple((label, float(weight) / total) for label, weight in pairs)
            else:
                raise ValueError(f"unknown experiment option {name!r} in {text!r}")
        return cls(key=key, variants=variants, effect=effect)

    def assign(self, unit: str) -> str:
        digest = hashlib.sha256(f"{self.salt}:{self.key}:{unit}".encode()).digest()
        point = int.from_bytes(digest[:8], "big") / 2**64
        cumulative = 0.0
        for label, weight in self.variants:
            cumulative += weight
            if point < cumulative:
                return label
        return self.variants[-1][0]


@dataclass(frozen=True, slots=True)
class SimConfig:
    seed: int = 7
    accounts: int = 300
    days: int = 21
    start: str = "2026-09-01T00:00:00.000Z"
    #: Accounts per shard. Shards are the unit of parallelism and of output files; the events are
    #: identical whatever the number of worker processes.
    shard_size: int = 1000
    #: Share of accounts that are already members on day 0 (the rest sign up during the run).
    existing_share: float = 0.65
    #: Session-level sampling of `impression` and `row.view` (blueprint §6.1: "sampled").
    impression_sample_rate: float = 1.0
    #: Share of sessions whose rows and row items are randomly ordered (exploration traffic,
    #: the source of unbiased position-bias estimates).
    explore_rate: float = 0.05
    #: Delivery faults: re-delivered events (same eventId, later receipt) and client events that
    #: arrive late (offline devices).
    duplicate_rate: float = 0.01
    late_rate: float = 0.02
    #: Devices whose clock is off (client `occurredAt` skewed by minutes to hours).
    skewed_device_rate: float = 0.03
    #: Accounts without personalisation consent, without analytics consent, and accounts that
    #: change their personalisation consent once during the run.
    personalisation_decline_rate: float = 0.12
    analytics_decline_rate: float = 0.06
    consent_change_rate: float = 0.03
    #: Mean sessions per active profile per day (before the profile's own multiplier).
    activity: float = 0.45
    experiments: tuple[ExperimentSpec, ...] = ()
    #: Key of the pseudonymous subject hash. Simulation only: production keeps its key secret.
    pseudonym_key: str = "webflix-sim-pseudonym-key"
    policy_id: str = "m1-rules-sim"
    app_version: str = "2.0.0"
    #: Lake objects: `hourly` (one per hour and shard, fast) or `writer` (shaped like the
    #: product's lake writer: client batches, outbox drains, single server events). The events
    #: are identical either way; only how they are grouped into objects differs.
    object_layout: str = "hourly"
    #: Store only what the product's collector would (emit.py). Off only to measure what the
    #: rules remove: the stored events are otherwise identical either way.
    collect_like_the_product: bool = True
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def start_ms(self) -> int:
        return parse_iso_ms(self.start)

    @property
    def end_ms(self) -> int:
        return self.start_ms + self.days * DAY_MS

    @property
    def shards(self) -> int:
        return (self.accounts + self.shard_size - 1) // self.shard_size

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["experiments"] = [
            {"key": e.key, "variants": [list(v) for v in e.variants], "effect": e.effect,
             "treatment": e.treatment, "salt": e.salt}
            for e in self.experiments
        ]  # fmt: skip
        return data


PRESETS: dict[str, SimConfig] = {
    # Seconds: CI and the unit tests.
    "smoke": SimConfig(accounts=300, days=21, shard_size=150),
    # About a minute: enough for every model to train and the evaluation to be meaningful.
    "medium": SimConfig(accounts=8_000, days=42, shard_size=500, impression_sample_rate=0.5),
    # The documented full run (docs/RECOMMENDATIONS-ML.md).
    "full": SimConfig(accounts=60_000, days=56, shard_size=1_000, impression_sample_rate=0.3),
}


def preset(name: str, **overrides: Any) -> SimConfig:
    try:
        base = PRESETS[name]
    except KeyError:
        raise ValueError(f"unknown preset {name!r} (choose from {sorted(PRESETS)})") from None
    return replace(base, **{k: v for k, v in overrides.items() if v is not None})
