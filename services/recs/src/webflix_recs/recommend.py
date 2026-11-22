"""Scoring profiles: candidate scores per system, and the lists published for the engine."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt

from webflix_recs.features import FeatureContext
from webflix_recs.history import History
from webflix_recs.ids import DAY_MS
from webflix_recs.models.rerank import rerank
from webflix_recs.train import Models

Array = npt.NDArray[np.float64]
SYSTEMS = ("popularity", "cowatch", "mf", "content", "ranker", "ranker-naive", "learned")

# Lengths of the published lists (README: artefact schema).
PERSONAL_ITEMS = 60
TOP_PICKS_ITEMS = 30
BILLBOARD_ITEMS = 5
BECAUSE_SOURCES = 3
BECAUSE_ITEMS = 15


@dataclass
class ProfileScores:
    rows: npt.NDArray[np.int64]
    candidates: npt.NDArray[np.bool_]  # n x T
    scores: dict[str, Array]  # system -> n x T


class Recommender:
    def __init__(self, models: Models, history: History) -> None:
        self.models = models
        self.history = history
        self.context: FeatureContext = models.context(history)
        catalog = history.catalog
        self.age_days = (history.as_of_ms - catalog.added_at) / DAY_MS
        self.similarity = models.content.similarity

    def candidates(self, rows: npt.NDArray[np.int64]) -> npt.NDArray[np.bool_]:
        """Titles a list may contain: arrived, not watched (a qualified play), not disliked,
        not finished. All eligible profiles are unrestricted, so every title is visible."""
        history = self.history
        return (
            history.available[None, :]
            & ~history.watched[rows]
            & ~history.negative[rows]
            & ~history.finished[rows]
        )

    def score(
        self, rows: npt.NDArray[np.int64], systems: tuple[str, ...] = SYSTEMS
    ) -> ProfileScores:
        history = self.history
        features = self.context.matrix(rows)
        from webflix_recs.features import FEATURES  # noqa: PLC0415

        column = {name: i for i, name in enumerate(FEATURES)}
        out: dict[str, Array] = {}
        if "popularity" in systems:
            pop = (
                np.log1p(history.title_plays_28d.astype(np.float64))
                + 1e-3 * self.history.catalog.popularity / 100
            )
            out["popularity"] = np.repeat(pop[None, :], len(rows), axis=0)
        if "cowatch" in systems:
            out["cowatch"] = features[:, :, column["cowatch_score"]].astype(np.float64)
        if "mf" in systems:
            out["mf"] = features[:, :, column["mf_score"]].astype(np.float64)
        if "content" in systems:
            out["content"] = features[:, :, column["content_affinity"]].astype(np.float64)
        if "ranker" in systems or "learned" in systems:
            out["ranker"] = self.models.ranker.predict(features).astype(np.float64)
        if "ranker-naive" in systems and self.models.ranker_naive is not None:
            out["ranker-naive"] = self.models.ranker_naive.predict(features).astype(np.float64)
        candidates = self.candidates(rows)
        return ProfileScores(rows=rows, candidates=candidates, scores=out)

    def top_picks(
        self, scores: Array, candidates: npt.NDArray[np.bool_], row: int, k: int
    ) -> list[int]:
        return rerank(
            scores,
            candidates,
            self.similarity,
            self.age_days,
            self.history.repetition[row].astype(np.float64),
            k,
            self.models.params.rerank,
        )

    def learned_order(
        self, scores: Array, candidates: npt.NDArray[np.bool_], row: int, k: int
    ) -> list[int]:
        """The final list a member would see first: re-ranked top picks, then the rest by score."""
        head = self.top_picks(scores, candidates, row, k)
        rest_mask = candidates.copy()
        rest_mask[head] = False
        rest = np.flatnonzero(rest_mask)
        rest = rest[np.lexsort((rest, -scores[rest]))]
        return head + [int(i) for i in rest]

    def lists(self, block: ProfileScores) -> Iterator[tuple[str, list[dict[str, Any]]]]:
        """The published rows for each profile of the block (README: profile lists)."""
        history = self.history
        ids = history.catalog.ids
        ranker = block.scores["ranker"]
        for local, profile_row in enumerate(block.rows):
            row = int(profile_row)
            candidates = block.candidates[local]
            scores = ranker[local]
            order = np.flatnonzero(candidates)
            order = order[np.lexsort((order, -scores[order]))][:PERSONAL_ITEMS]
            rows: list[dict[str, Any]] = [
                {
                    "type": "personal",
                    "param": None,
                    "items": [[ids[t], round(float(scores[t]), 5)] for t in order],
                }
            ]
            picks = self.top_picks(scores, candidates, row, TOP_PICKS_ITEMS)
            rows.append(
                {
                    "type": "top-picks",
                    "param": None,
                    "items": [[ids[t], round(float(scores[t]), 5)] for t in picks],
                }
            )
            unstarted = candidates & ~history.started[row]
            repetition = history.repetition[row].astype(np.float64)
            billboard = rerank(
                scores, unstarted, self.similarity, self.age_days, repetition,
                BILLBOARD_ITEMS, self.models.params.rerank,
            )  # fmt: skip
            rows.append(
                {
                    "type": "billboard",
                    "param": None,
                    "items": [[ids[t], round(float(scores[t]), 5)] for t in billboard],
                }
            )
            for source in self._sources(row):
                neighbour = self.models.blend[source]
                mixed = 0.6 * neighbour + 0.4 * self._percentile(scores, candidates)
                mask = candidates.copy()
                mask[source] = False
                items = np.flatnonzero(mask & (neighbour > 0))
                items = items[np.lexsort((items, -mixed[items]))][:BECAUSE_ITEMS]
                if len(items) >= 4:
                    rows.append(
                        {
                            "type": "because-you-watched",
                            "param": ids[source],
                            "items": [[ids[t], round(float(mixed[t]), 5)] for t in items],
                        }
                    )
            yield history.profiles[row], rows

    def _sources(self, row: int) -> list[int]:
        """Recently watched titles worth a "Because you watched" row: strongest recent first."""
        history = self.history
        watched = np.flatnonzero(
            history.watched[row] & ~history.negative[row] & (history.strength[row] >= 1.0)
        )
        recent = watched[np.lexsort((watched, -history.last_time[row, watched]))]
        return [int(t) for t in recent[:BECAUSE_SOURCES]]

    @staticmethod
    def _percentile(scores: Array, candidates: npt.NDArray[np.bool_]) -> Array:
        out = np.zeros_like(scores)
        index = np.flatnonzero(candidates)
        if len(index):
            order = index[np.argsort(-scores[index], kind="stable")]
            out[order] = 1.0 - np.arange(len(order)) / max(len(order) - 1, 1)
        return out
