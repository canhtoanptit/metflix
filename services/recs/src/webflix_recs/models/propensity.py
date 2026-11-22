"""Position-bias (examination propensity) estimation from exploration traffic.

A small share of sessions (the simulator's `explore_rate`; in production an exploration slice of
the ranking policy) shows rows in random order and the items of each row in random order, and
says so in `context.policy.explore`. In those sessions what a card shows is independent of where
it is shown, so the rate at which cards at position k are opened, relative to position 1,
estimates the relative probability that a member looks at position k at all (Joachims et al.
2017; Wang et al. 2018). Opens are attributed to the card (dataset.py): a title opened from
another row does not count for this one.

Model (the examination hypothesis): P(open | impression at row r, rank k) = theta(r, k) x
P(open | examined, title), with theta(r, k) = k^-gamma x a(r), theta(first row, 1) = 1.

* gamma: weighted least squares of the open rate on rank (power law), with a bootstrap interval
  over profiles;
* a(r): open rate by module position relative to the first shuffled module, made monotone
  (pool-adjacent-violators) and clipped to [0.1, 1]. Deeper modules are reached by members
  who found nothing above, so this part mixes attention with intent and runs below the truth.

The estimate is checked against the simulator's true parameters in tests and in the report.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt
import polars as pl

#: Rows whose order is not randomised by exploration (fixed or re-consumption rows).
FIXED_ROWS = ("billboard", "continue-watching", "my-list", "watch-again")
MAX_RANK = 12


def _isotonic_decreasing(
    values: npt.NDArray[np.float64], weights: npt.NDArray[np.float64]
) -> npt.NDArray[np.float64]:
    """Pool-adjacent-violators for a non-increasing fit."""
    blocks: list[list[float]] = []  # [value, weight, count]
    for value, weight in zip(values, weights, strict=True):
        blocks.append([float(value), float(weight), 1.0])
        while len(blocks) > 1 and blocks[-2][0] < blocks[-1][0]:
            v2, w2, c2 = blocks.pop()
            v1, w1, c1 = blocks.pop()
            total = w1 + w2
            blocks.append([(v1 * w1 + v2 * w2) / total if total else (v1 + v2) / 2, total, c1 + c2])
    out: list[float] = []
    for value, _, count in blocks:
        out.extend([value] * int(count))
    return np.array(out)


def _fit_exponent(
    ranks: npt.NDArray[np.float64], rates: npt.NDArray[np.float64], counts: npt.NDArray[np.float64]
) -> float:
    """Least squares of rate ~ c * rank^-gamma (counts as weights), by grid search on gamma."""
    best = (np.inf, 0.0)
    for gamma in np.linspace(0.0, 2.0, 401):
        basis = ranks**-gamma
        c = float((counts * rates * basis).sum() / max((counts * basis * basis).sum(), 1e-12))
        error = float((counts * (rates - c * basis) ** 2).sum())
        if error < best[0]:
            best = (error, float(gamma))
    return best[1]


@dataclass
class Propensity:
    exponent: float
    exponent_interval: tuple[float, float]
    row_ranks: list[int]
    row_attention: list[float]
    rank_rates: dict[int, float] = field(default_factory=dict)
    impressions: int = 0
    plays: int = 0

    def theta(self, row_rank: npt.ArrayLike, rank: npt.ArrayLike) -> npt.NDArray[np.float64]:
        ranks = np.asarray(rank, dtype=np.float64)
        rows = np.asarray(row_rank, dtype=np.int64)
        attention = np.ones(rows.shape)
        if self.row_ranks:
            lookup = dict(zip(self.row_ranks, self.row_attention, strict=True))
            first, last = self.row_ranks[0], self.row_ranks[-1]
            attention = np.array(
                [
                    lookup.get(min(max(int(r), first), last), self.row_attention[-1])
                    for r in rows.ravel()
                ]
            ).reshape(rows.shape)
        return np.clip(np.power(np.maximum(ranks, 1.0), -self.exponent) * attention, 0.02, 1.0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "model": "theta(r, k) = k^-gamma * a(r)",
            "gamma": round(self.exponent, 4),
            "gammaInterval95": [round(v, 4) for v in self.exponent_interval],
            "rowAttention": {
                str(r): round(a, 4) for r, a in zip(self.row_ranks, self.row_attention, strict=True)
            },
            "playRateByRank": {str(k): round(v, 5) for k, v in self.rank_rates.items()},
            "impressions": self.impressions,
            "plays": self.plays,
        }

    @classmethod
    def neutral(cls) -> Propensity:
        return cls(exponent=0.0, exponent_interval=(0.0, 0.0), row_ranks=[], row_attention=[])

    @classmethod
    def estimate(
        cls,
        impressions: pl.DataFrame,
        *,
        label: str = "opened",
        bootstrap: int = 200,
        seed: int = 7,
    ) -> Propensity:
        if "censored" in impressions.columns:
            impressions = impressions.filter(~pl.col("censored"))
        explore = impressions.filter(
            pl.col("explore")
            & ~pl.col("row_kind").is_in(list(FIXED_ROWS))
            & (pl.col("rank") <= MAX_RANK)
        )
        if explore.height < 500 or int(explore[label].sum()) < 20:
            return cls.neutral()
        by_rank = (
            explore.group_by("rank")
            .agg(pl.len().alias("n"), pl.col(label).sum().alias("plays"))
            .sort("rank")
        )
        ranks = by_rank["rank"].to_numpy().astype(np.float64)
        counts = by_rank["n"].to_numpy().astype(np.float64)
        rates = by_rank["plays"].to_numpy() / counts
        gamma = _fit_exponent(ranks, rates, counts)
        # Bootstrap over profiles: impressions of one profile are not independent.
        rng = np.random.default_rng(seed)
        per_profile = explore.group_by(["profile", "rank"]).agg(
            pl.len().alias("n"), pl.col(label).sum().alias("plays")
        )
        profiles = per_profile["profile"].unique().sort().to_list()
        position = {p: i for i, p in enumerate(profiles)}
        rows = np.array([position[p] for p in per_profile["profile"].to_list()])
        rank_of = per_profile["rank"].to_numpy().astype(np.int64)
        n_of = per_profile["n"].to_numpy().astype(np.float64)
        plays_of = per_profile["plays"].to_numpy().astype(np.float64)
        samples = []
        for _ in range(bootstrap):
            weight = np.bincount(
                rng.integers(0, len(profiles), len(profiles)), minlength=len(profiles)
            )[rows]
            n = np.bincount(rank_of, weights=n_of * weight, minlength=MAX_RANK + 1)[1:]
            k = np.bincount(rank_of, weights=plays_of * weight, minlength=MAX_RANK + 1)[1:]
            present = n > 0
            samples.append(
                _fit_exponent(
                    np.arange(1, MAX_RANK + 1, dtype=np.float64)[present],
                    k[present] / n[present],
                    n[present],
                )
            )
        interval = (float(np.percentile(samples, 2.5)), float(np.percentile(samples, 97.5)))
        # Row attention: rates by module position, corrected for the rank mix within each.
        corrected = explore.with_columns(
            (pl.col("rank").cast(pl.Float64) ** gamma).alias("inv_theta_rank")
        )
        by_row = (
            corrected.group_by("row_rank")
            .agg(
                pl.len().alias("n"),
                (pl.col(label).cast(pl.Float64) * pl.col("inv_theta_rank")).sum().alias("weighted"),
            )
            .filter(pl.col("n") >= 200)
            .sort("row_rank")
        )
        row_ranks: list[int] = by_row["row_rank"].to_list()
        if row_ranks:
            rate = by_row["weighted"].to_numpy() / by_row["n"].to_numpy()
            relative = rate / max(rate[0], 1e-12)
            smooth = _isotonic_decreasing(
                np.minimum(relative, 1.0), by_row["n"].to_numpy().astype(np.float64)
            )
            attention = [float(v) for v in np.clip(smooth, 0.1, 1.0)]
        else:
            attention = []
        return cls(
            exponent=gamma,
            exponent_interval=interval,
            row_ranks=row_ranks,
            row_attention=attention,
            rank_rates={int(k): float(r) for k, r in zip(ranks, rates, strict=True)},
            impressions=explore.height,
            plays=int(explore[label].sum()),
        )
