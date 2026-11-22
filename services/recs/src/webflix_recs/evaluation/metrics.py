"""Ranking metrics per profile, and bootstrap confidence intervals over profiles.

Every metric is computed per profile from a ranked list (title indices, best first, -1 padded)
and averaged over profiles, so that a bootstrap over profiles (the independent unit) gives its
interval. Definitions (K is the cut-off):

* recall@K     hits in the top K / number of relevant titles
* ndcg@K       sum_k gain_k / log2(k + 1), over the ideal ordering of the profile's gains
               (gain 1 for a qualified play, 2 when an item was completed)
* map@K        sum_k precision@k * rel_k / min(relevant, K)
* diversity@K  1 - mean pairwise similarity of the top K, in the engine's content-feature space
               (genres, moods, people: a model-independent space)
* novelty@K    mean self-information -log2 p(title), p = share of training profiles who played it
* coverage@K   share of the available titles that appear in at least one profile's top K
* utility@K    mean true utility of the top K (simulator ground truth); regret@K is the oracle's
               utility@K minus the system's
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt

Array = npt.NDArray[np.float64]
IntArray = npt.NDArray[np.int64]


def _gather(matrix: Array, lists: IntArray) -> Array:
    """matrix[row, lists[row, k]] with 0 for padding (-1)."""
    rows = np.arange(lists.shape[0])[:, None]
    safe = np.where(lists >= 0, lists, 0)
    values = matrix[rows, safe]
    return np.where(lists >= 0, values, 0.0)


def accuracy(lists: IntArray, gains: Array, k: int) -> dict[str, Array]:
    top = lists[:, :k]
    gain = _gather(gains, top)
    hit = gain > 0
    relevant = (gains > 0).sum(axis=1).astype(np.float64)
    discounts = 1.0 / np.log2(np.arange(2, k + 2))
    dcg = (gain * discounts[: top.shape[1]]).sum(axis=1)
    ideal_gains = -np.sort(-gains, axis=1)[:, :k]
    idcg = (ideal_gains * discounts[: ideal_gains.shape[1]]).sum(axis=1)
    precision_at = np.cumsum(hit, axis=1) / np.arange(1, top.shape[1] + 1)
    ap = (precision_at * hit).sum(axis=1) / np.maximum(np.minimum(relevant, k), 1)
    return {
        f"recall@{k}": hit.sum(axis=1) / np.maximum(relevant, 1),
        f"ndcg@{k}": np.where(idcg > 0, dcg / np.maximum(idcg, 1e-12), 0.0),
        f"map@{k}": ap,
        f"hit@{k}": hit.any(axis=1).astype(np.float64),
    }


def diversity(lists: IntArray, similarity: Array, k: int, chunk: int = 4000) -> Array:
    out = np.zeros(lists.shape[0])
    for start in range(0, lists.shape[0], chunk):
        top = lists[start : start + chunk, :k]
        valid = top >= 0
        safe = np.where(valid, top, 0)
        pair = similarity[safe[:, :, None], safe[:, None, :]]
        mask = valid[:, :, None] & valid[:, None, :] & ~np.eye(top.shape[1], dtype=bool)[None]
        count = mask.sum(axis=(1, 2))
        mean = np.where(count > 0, (pair * mask).sum(axis=(1, 2)) / np.maximum(count, 1), 0.0)
        out[start : start + chunk] = np.where(count > 0, 1.0 - mean, 0.0)
    return out


def novelty(lists: IntArray, self_information: Array, k: int) -> Array:
    top = lists[:, :k]
    valid = top >= 0
    values = np.where(valid, self_information[np.where(valid, top, 0)], 0.0)
    return values.sum(axis=1) / np.maximum(valid.sum(axis=1), 1)


def coverage(lists: IntArray, k: int, available: int) -> float:
    top = lists[:, :k]
    return float(len(np.unique(top[top >= 0])) / max(available, 1))


def utility(lists: IntArray, truth: Array, k: int) -> Array:
    top = lists[:, :k]
    valid = top >= 0
    values = _gather(truth, top)
    return values.sum(axis=1) / np.maximum(valid.sum(axis=1), 1)


@dataclass(frozen=True)
class Interval:
    mean: float
    low: float
    high: float

    def to_list(self) -> list[float]:
        return [round(self.mean, 5), round(self.low, 5), round(self.high, 5)]


class Bootstrap:
    """Percentile bootstrap over profiles, with the same resamples for every metric and
    system, so paired differences (system A - system B on the same profiles) are consistent."""

    def __init__(self, n: int, replicates: int = 1000, seed: int = 7, chunk: int = 50) -> None:
        self.n = n
        self.replicates = replicates
        rng = np.random.default_rng(seed)
        # Resample counts per profile: replicates x n multinomial draws, memory ~ replicates * n.
        self.weights = np.empty((replicates, n), dtype=np.float32)
        for start in range(0, replicates, chunk):
            stop = min(replicates, start + chunk)
            draws = rng.integers(0, n, (stop - start, n))
            for row, sample in enumerate(draws):
                self.weights[start + row] = np.bincount(sample, minlength=n)

    def intervals(
        self, values: Array, mask: npt.NDArray[np.bool_] | None = None, level: float = 0.95
    ) -> list[Interval]:
        """Intervals for the columns of `values` (n x M), all from the same resamples."""
        if values.ndim == 1:
            values = values[:, None]
        if mask is not None:
            weights = self.weights[:, mask]
            values = values[mask]
        else:
            weights = self.weights
        if len(values) == 0:
            return [Interval(float("nan"), float("nan"), float("nan"))] * values.shape[1]
        totals = np.maximum(weights.sum(axis=1, keepdims=True), 1)
        means = (weights @ values.astype(np.float32)) / totals
        alpha = (1 - level) / 2
        low = np.quantile(means, alpha, axis=0)
        high = np.quantile(means, 1 - alpha, axis=0)
        centre = values.mean(axis=0)
        return [
            Interval(float(c), float(lo), float(hi))
            for c, lo, hi in zip(centre, low, high, strict=True)
        ]

    def interval(
        self, values: Array, mask: npt.NDArray[np.bool_] | None = None, level: float = 0.95
    ) -> Interval:
        return self.intervals(values, mask, level)[0]


def summarise(
    values: dict[str, Array], bootstrap: Bootstrap, mask: npt.NDArray[np.bool_] | None = None
) -> dict[str, Any]:
    names = list(values)
    matrix = np.stack([values[name] for name in names], axis=1)
    return {
        name: interval.to_list()
        for name, interval in zip(names, bootstrap.intervals(matrix, mask), strict=True)
    }
