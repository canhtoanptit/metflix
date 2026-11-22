"""Implicit-feedback matrix factorisation: alternating least squares (Hu, Koren, Volinsky 2008).

Minimises  sum_{u,i} c_ui (p_ui - x_u . y_i)^2 + reg (|x_u|^2 + |y_i|^2)  with preference
p_ui = 1 when the feedback strength is positive, confidence c_ui = 1 + alpha * strength, and a
disliked title given p_ui = 0 with confidence 1 + alpha * dislike_confidence (a known "no").

Implementation note: the catalogue is small (about 120 titles), so the confidence matrix is
held dense and every user solve is one batched k x k system built with a single GEMM against
the per-item outer products. A catalogue in the tens of thousands would switch to the sparse
conjugate-gradient formulation (the `implicit` library); the model and its outputs are the same.

Profiles are not stored with the model: scoring folds a profile in (one solve against the
trained item factors) from its history at scoring time, so a profile that appeared after
training still gets a personal vector. Titles with no plays at training time get factors
mapped from their content vectors (ridge regression fitted on the warm titles).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

Matrix = npt.NDArray[np.float64]


@dataclass
class ImplicitALS:
    factors: int = 32
    regularisation: float = 0.08
    alpha: float = 8.0
    dislike_confidence: float = 1.0
    iterations: int = 12
    seed: int = 7
    item_factors: Matrix | None = None
    loss_history: list[float] | None = None

    def _confidence(
        self, strength: npt.NDArray[np.float32], negative: npt.NDArray[np.bool_]
    ) -> tuple[Matrix, Matrix]:
        preference = (strength > 0).astype(np.float64)
        confidence = 1.0 + self.alpha * strength.astype(np.float64)
        confidence = np.where(negative, 1.0 + self.alpha * self.dislike_confidence, confidence)
        return preference, confidence

    def _solve(
        self, fixed: Matrix, preference: Matrix, confidence: Matrix, chunk: int = 20_000
    ) -> Matrix:
        """Rows of the other side, given `fixed` (n x k) and per-row (preference, confidence)
        over the n columns."""
        k = fixed.shape[1]
        gram = fixed.T @ fixed
        outer = np.einsum("ik,il->ikl", fixed, fixed).reshape(fixed.shape[0], k * k)
        regulariser = self.regularisation * np.eye(k)
        out = np.empty((preference.shape[0], k))
        for start in range(0, preference.shape[0], chunk):
            c = confidence[start : start + chunk]
            p = preference[start : start + chunk]
            a = (c - 1.0) @ outer
            a = a.reshape(-1, k, k) + gram + regulariser
            b = (c * p) @ fixed
            out[start : start + chunk] = np.linalg.solve(a, b[:, :, None])[:, :, 0]
        return out

    def _solve_items(self, x: Matrix, preference: Matrix, confidence: Matrix) -> Matrix:
        """Item factors given profile factors: one k x k system per title, built from the
        profiles that interacted with it (the others contribute only the shared Gram matrix)."""
        k = x.shape[1]
        base = x.T @ x + self.regularisation * np.eye(k)
        out = np.empty((preference.shape[1], k))
        for item in range(preference.shape[1]):
            column = confidence[:, item]
            rows = np.flatnonzero(column != 1.0)
            xs = x[rows]
            a = base + (xs * (column[rows] - 1.0)[:, None]).T @ xs
            b = (column[rows] * preference[rows, item]) @ xs
            out[item] = np.linalg.solve(a, b)
        return out

    def fit(self, strength: npt.NDArray[np.float32], negative: npt.NDArray[np.bool_]) -> Matrix:
        """Train on a profiles x titles strength matrix; returns the profiles' factors."""
        rng = np.random.default_rng(self.seed)
        preference, confidence = self._confidence(strength, negative)
        users, items = strength.shape
        y = rng.normal(0.0, 0.1, (items, self.factors))
        x = np.zeros((users, self.factors))
        self.loss_history = []
        for _ in range(self.iterations):
            x = self._solve(y, preference, confidence)
            y = self._solve_items(x, preference, confidence)
            self.loss_history.append(self.loss(x, y, preference, confidence))
        self.item_factors = y
        return x

    def loss(self, x: Matrix, y: Matrix, preference: Matrix, confidence: Matrix) -> float:
        residual = preference - x @ y.T
        data = float((confidence * residual**2).sum())
        penalty = self.regularisation * float((x**2).sum() + (y**2).sum())
        return (data + penalty) / preference.size

    def fold_in(self, strength: npt.NDArray[np.float32], negative: npt.NDArray[np.bool_]) -> Matrix:
        """Profile factors for histories, against the trained item factors."""
        if self.item_factors is None:
            raise RuntimeError("fit the model first")
        preference, confidence = self._confidence(strength, negative)
        return self._solve(self.item_factors, preference, confidence)

    def cold_start_items(
        self, content: Matrix, warm: npt.NDArray[np.bool_], ridge: float = 1.0
    ) -> None:
        """Replace the factors of titles that had no positive feedback at training time by a
        ridge mapping from content vectors, fitted on the warm titles."""
        if self.item_factors is None:
            raise RuntimeError("fit the model first")
        if warm.sum() < 2 or warm.all():
            return
        features = np.hstack([content, np.ones((content.shape[0], 1))])
        a = features[warm]
        weights = np.linalg.solve(
            a.T @ a + ridge * np.eye(a.shape[1]), a.T @ self.item_factors[warm]
        )
        self.item_factors[~warm] = features[~warm] @ weights
