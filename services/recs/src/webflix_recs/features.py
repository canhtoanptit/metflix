"""Candidate features for the ranker: one vector per (profile, title), computed from models and
history fitted at one knowledge cutoff."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from webflix_recs.history import History
from webflix_recs.ids import DAY_MS
from webflix_recs.models.als import ImplicitALS
from webflix_recs.models.content import ContentModel
from webflix_recs.models.cowatch import CoWatch

FEATURES = (
    "mf_score",
    "mf_percentile",
    "cowatch_score",
    "cowatch_max",
    "content_affinity",
    "genre_affinity",
    "plays_7d_log",
    "plays_28d_log",
    "trend_log",
    "seed_popularity",
    "age_days_log",
    "is_new",
    "is_series",
    "is_original",
    "length_hours_log",
    "tenure_days_log",
    "activity_log",
    "series_share",
    "series_match",
    "repetition_log",
    "in_list",
    "opened_log",
    "cold_profile",
)


@dataclass
class FeatureContext:
    history: History
    cowatch: CoWatch
    als: ImplicitALS
    content: ContentModel
    blend: npt.NDArray[np.float64]  # neighbour similarity (co-watch blended with content)

    def __post_init__(self) -> None:
        history = self.history
        catalog = history.catalog
        self.user_factors = self.als.fold_in(history.strength, history.negative)
        self.item_factors = (
            self.als.item_factors
            if self.als.item_factors is not None
            else np.zeros((len(catalog), 1))
        )
        age = (history.as_of_ms - catalog.added_at) / DAY_MS
        lengths = np.array([t.total_runtime_sec / 3600.0 for t in catalog.titles])
        plays_7d = history.title_plays_7d.astype(np.float64)
        plays_28d = history.title_plays_28d.astype(np.float64)
        self.item = {
            "plays_7d_log": np.log1p(plays_7d),
            "plays_28d_log": np.log1p(plays_28d),
            "trend_log": np.log((plays_7d + 1.0) / (plays_28d / 4.0 + 1.0)),
            "seed_popularity": catalog.popularity / 100.0,
            "age_days_log": np.log1p(np.maximum(age, 0.0)),
            "is_new": (age <= 14).astype(np.float64),
            "is_series": catalog.is_series.astype(np.float64),
            "is_original": catalog.is_original.astype(np.float64),
            "length_hours_log": np.log1p(lengths),
        }
        genre = catalog.genre_matrix
        self.genre_unit = genre / np.maximum(np.linalg.norm(genre, axis=1, keepdims=True), 1e-9)

    def matrix(self, rows: npt.NDArray[np.int64]) -> npt.NDArray[np.float32]:
        """Features of the given history rows against every title: (len(rows), T, F)."""
        history = self.history
        strength = history.strength[rows]
        watched = history.watched[rows] | history.in_list[rows]
        mf = self.user_factors[rows] @ self.item_factors.T
        available = history.available
        masked = np.where(available[None, :], mf, -np.inf)
        order = np.argsort(np.argsort(-masked, axis=1, kind="stable"), axis=1)
        percentile = 1.0 - order / max(int(available.sum()) - 1, 1)
        cowatch_score = self.cowatch.scores(strength, self.blend)
        cowatch_max = self.cowatch.max_similarity(watched, self.blend)
        content = self.content.profile_affinity(strength)
        genre_taste = strength.astype(np.float64) @ self.genre_unit
        genre_taste /= np.maximum(np.linalg.norm(genre_taste, axis=1, keepdims=True), 1e-9)
        genre_affinity = genre_taste @ self.genre_unit.T
        tenure = np.log1p(np.maximum(0.0, (history.as_of_ms - history.first_seen[rows]) / DAY_MS))
        plays = history.plays[rows].astype(np.float64)
        share = history.series_share[rows].astype(np.float64)
        n, t = len(rows), len(history.catalog)
        columns = {
            "mf_score": mf,
            "mf_percentile": percentile,
            "cowatch_score": cowatch_score,
            "cowatch_max": cowatch_max,
            "content_affinity": content,
            "genre_affinity": genre_affinity,
            "tenure_days_log": np.repeat(tenure[:, None], t, axis=1),
            "activity_log": np.repeat(np.log1p(plays)[:, None], t, axis=1),
            "series_share": np.repeat(share[:, None], t, axis=1),
            "series_match": np.where(
                self.item["is_series"][None, :] > 0, share[:, None], 1.0 - share[:, None]
            ),
            "repetition_log": np.log1p(history.repetition[rows]),
            "in_list": history.in_list[rows].astype(np.float64),
            "opened_log": np.log1p(history.opened[rows]),
            "cold_profile": np.repeat((plays < 3).astype(np.float64)[:, None], t, axis=1),
        }
        out = np.empty((n, t, len(FEATURES)), dtype=np.float32)
        for position, name in enumerate(FEATURES):
            if name in self.item:
                out[:, :, position] = self.item[name][None, :]
            else:
                out[:, :, position] = columns[name]
        return out
