"""Re-ranking a profile's scored candidates for diversity, freshness and repetition.

Greedy maximal marginal relevance (Carbonell & Goldstein 1998) over the top candidates:

    pick argmax_t  lambda * relevance(t) - (1 - lambda) * max_{s chosen} similarity(t, s)
                    + freshness_weight * exp(-age_days(t) / 14)        (titles under 30 days old)
                    - repetition_weight * log(1 + impressions without a play in 14 days)

`relevance` is the ranker's score turned into a within-profile percentile (so the trade-off
does not depend on the score's scale), and `similarity` the content vectors' cosine. The
weights are the run's parameters (recorded in its manifest).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

Array = npt.NDArray[np.float64]


@dataclass(frozen=True)
class RerankWeights:
    diversity_lambda: float = 0.85
    freshness: float = 0.06
    repetition: float = 0.05
    pool: int = 60


def rerank(
    scores: Array,
    candidates: npt.NDArray[np.bool_],
    similarity: Array,
    age_days: Array,
    repetition: Array,
    k: int,
    weights: RerankWeights = RerankWeights(),
) -> list[int]:
    indices = np.flatnonzero(candidates)
    if len(indices) == 0:
        return []
    order = indices[np.lexsort((indices, -scores[indices]))][: weights.pool]
    count = len(order)
    relevance = 1.0 - np.arange(count) / max(count - 1, 1)
    fresh = np.where(age_days[order] < 30, np.exp(-np.maximum(age_days[order], 0) / 14.0), 0.0)
    base = (
        weights.diversity_lambda * relevance
        + weights.freshness * fresh
        - weights.repetition * np.log1p(repetition[order])
    )
    chosen: list[int] = []
    max_sim = np.zeros(count)
    remaining = np.ones(count, dtype=bool)
    sub = similarity[np.ix_(order, order)]
    for _ in range(min(k, count)):
        value = np.where(remaining, base - (1.0 - weights.diversity_lambda) * max_sim, -np.inf)
        best = int(np.argmax(value))
        chosen.append(int(order[best]))
        remaining[best] = False
        max_sim = np.maximum(max_sim, sub[best])
    return chosen
