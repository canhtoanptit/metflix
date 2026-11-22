"""Item-to-item co-watch similarity with shrinkage.

    cos(i, j) = sum_u w_u x_ui x_uj / sqrt(sum_u w_u x_ui * sum_u w_u x_uj)
    sim(i, j) = cos(i, j) * n_ij / (n_ij + shrinkage)

`x_ui` is 1 when profile u has a qualified play of title i; `w_u = 1 / log2(2 + n_u)` damps
profiles that watch everything (inverse user frequency); `n_ij` is the number of profiles who
watched both (the support), and the shrinkage term pulls similarities with little support
towards zero (Koren 2008). Titles with too little support borrow content neighbours (blend in
`neighbours`).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

Matrix = npt.NDArray[np.float64]


@dataclass
class CoWatch:
    similarity: Matrix  # T x T, zero diagonal
    support: npt.NDArray[np.float64]  # T x T co-watch counts
    item_counts: npt.NDArray[np.float64]  # T

    @classmethod
    def fit(cls, watched: npt.NDArray[np.bool_], *, shrinkage: float = 20.0) -> CoWatch:
        x = watched.astype(np.float64)
        per_user = x.sum(axis=1)
        weights = 1.0 / np.log2(2.0 + per_user)
        weighted = x * weights[:, None]
        co = weighted.T @ x
        support = x.T @ x
        diagonal = np.diag(co).copy()
        denominator = np.sqrt(np.outer(diagonal, diagonal))
        with np.errstate(divide="ignore", invalid="ignore"):
            cosine = np.where(denominator > 0, co / denominator, 0.0)
        similarity = cosine * support / (support + shrinkage)
        np.fill_diagonal(similarity, 0.0)
        return cls(similarity=similarity, support=support, item_counts=np.diag(support).copy())

    def blended(self, content_similarity: Matrix, *, prior: float = 30.0) -> Matrix:
        """Co-watch where titles have support, content where they do not: per pair, weight
        `a = min(n_i, n_j) / (min(n_i, n_j) + prior)` on co-watch. New titles (no plays yet)
        therefore get pure content neighbours, and earn co-watch ones as they are watched."""
        counts = self.item_counts
        least = np.minimum(counts[:, None], counts[None, :])
        alpha = least / (least + prior)
        content = np.clip(content_similarity, 0.0, 1.0).copy()
        np.fill_diagonal(content, 0.0)
        # Co-watch similarities run lower than content cosines; rescale to a comparable range.
        scale = (
            np.percentile(self.similarity[self.similarity > 0], 99)
            if np.any(self.similarity > 0)
            else 1.0
        )
        cowatch = np.clip(self.similarity / max(scale, 1e-9), 0.0, 1.0)
        blend: Matrix = alpha * cowatch + (1.0 - alpha) * content
        np.fill_diagonal(blend, 0.0)
        return blend

    def scores(
        self, profile_strength: npt.NDArray[np.float32], similarity: Matrix | None = None
    ) -> Matrix:
        """Item-kNN score of every title for each profile: sum over watched titles of
        strength x similarity (normalised by total strength)."""
        sim = self.similarity if similarity is None else similarity
        strength = profile_strength.astype(np.float64)
        totals = np.maximum(strength.sum(axis=1, keepdims=True), 1e-9)
        result: Matrix = (strength @ sim) / totals
        return result

    def max_similarity(
        self, mask: npt.NDArray[np.bool_], similarity: Matrix | None = None, chunk: int = 1000
    ) -> Matrix:
        """For each profile and title: the largest similarity to any title in `mask`."""
        sim = self.similarity if similarity is None else similarity
        out = np.zeros((mask.shape[0], sim.shape[0]))
        for start in range(0, mask.shape[0], chunk):
            block = mask[start : start + chunk]
            out[start : start + chunk] = np.where(block[:, :, None], sim[None, :, :], 0.0).max(
                axis=1
            )
        return out
