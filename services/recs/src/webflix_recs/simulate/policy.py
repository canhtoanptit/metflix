"""The simulated platform's logging policy: how the home page is composed for a profile.

A stand-in for the milestone 1 rule engine (docs/RECOMMENDATIONS.md), written in Python so the
simulator can call it millions of times: the same scoring formula (affinity from content
features of what the profile engaged with, popularity, trend, freshness), the same row order and
the same row rules in simplified form. It sees only what the real engine would see (the
profile's library: plays, My List, ratings), never the simulator's ground truth.

The offline baseline is *not* this code: evaluation calls the real TypeScript engine
(scripts/rule-engine-rankings.ts).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt

from webflix_recs.catalog import Catalog
from webflix_recs.ids import DAY_MS

ROW_ITEMS = 20
MIN_ROW_ITEMS = 4
MIN_GENRE_ITEMS = 6
NEW_RELEASE_DAYS = 45
FRESHNESS_DAYS = 45.0
PROMINENT = 6


@dataclass(slots=True)
class Progress:
    """What the platform knows about one title for one profile (its progress records)."""

    item: int = 0
    position: float = 0.0
    started: int = 0
    completed: int = 0
    last_ms: int = 0
    finished: bool = False
    #: Hidden from the platform: the member gave up on it (it still shows in Continue Watching).
    dropped: bool = False
    engaged: bool = False


@dataclass(slots=True)
class Library:
    list_added: dict[int, int] = field(default_factory=dict)
    ratings: dict[int, str] = field(default_factory=dict)
    progress: dict[int, Progress] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Module:
    row_id: str
    kind: str
    items: npt.NDArray[np.int64]


class PopularitySeries:
    """Daily views per title from the seed baseline (the engine's synthetic `title_stats`):
    `((popularity/100)^2 * 400 + 5) * launch spike * noise`. The simulator's shards run in
    parallel, so the popularity the policy sees does not feed back from simulated plays."""

    def __init__(self, catalog: Catalog, start_ms: int, days: int, seed: int) -> None:
        rng = np.random.default_rng([seed, 3])
        history = 14
        self.first_day_ms = start_ms - history * DAY_MS
        total = days + history + 1
        day_starts = self.first_day_ms + np.arange(total) * DAY_MS
        age = (day_starts[:, None] - catalog.added_at[None, :]) / DAY_MS
        base = (catalog.popularity / 100.0) ** 2 * 400.0 + 5.0
        spike = np.where(age < 21, 1.0 + 2.5 * np.exp(-np.maximum(age, 0) / 5.0), 1.0)
        noise = rng.uniform(0.85, 1.15, (total, len(catalog)))
        views = np.where(age >= 0, base[None, :] * spike * noise, 0.0)
        self.views = views
        decay = 0.8 ** np.arange(7)
        trend = np.zeros_like(views)
        for lag, weight in enumerate(decay):
            trend[lag:] += weight * views[: total - lag]
        maxima = np.maximum(trend.max(axis=1, keepdims=True), 1e-9)
        self.trend = trend / maxima
        recent = views.copy()
        recent[1:] += views[:-1]
        self.recent = recent

    def day(self, now_ms: int) -> int:
        return int(min(max((now_ms - self.first_day_ms) // DAY_MS, 0), len(self.views) - 1))


class Policy:
    def __init__(self, catalog: Catalog, popularity: PopularitySeries, policy_id: str) -> None:
        self.catalog = catalog
        self.popularity = popularity
        self.policy_id = policy_id
        self.features = catalog.engine_features
        self.similarity = catalog.engine_similarity.copy()
        np.fill_diagonal(self.similarity, -1.0)
        index = catalog.engine_feature_index
        self.genre_columns = np.array([index[f"g:{g['id']}"] for g in catalog.genres])
        self.genre_slugs = [g["slug"] for g in catalog.genres]
        self.titles = len(catalog)
        self.ids = catalog.ids
        self.pop = catalog.popularity / 100.0
        self.original = catalog.is_original

    # --- the engine's taste and score -----------------------------------------------------

    def taste(
        self, library: Library, now_ms: int, visible: npt.NDArray[np.bool_]
    ) -> tuple[npt.NDArray[np.float64], float]:
        weights = np.zeros(self.titles)

        def decay(since: int, half_life: float, floor: float) -> float:
            return float(max(floor, 0.5 ** (max(0, now_ms - since) / DAY_MS / half_life)))

        for title, added in library.list_added.items():
            weights[title] += 1.2 * decay(added, 60.0, 0.5)
        for title, progress in library.progress.items():
            item = self.catalog.titles[title]
            if item.is_series:
                engagement = min(
                    1.0, max(0.3, 0.3 + 0.12 * progress.started + 0.08 * progress.completed)
                )
            elif progress.finished:
                engagement = 1.0
            else:
                duration = item.runtime_sec or 1
                engagement = min(0.9, max(0.15, 1.2 * progress.position / duration))
            weights[title] += 2.0 * engagement * decay(progress.last_ms, 30.0, 0.25)
        for title, value in library.ratings.items():
            if value == "dislike":
                weights[title] = -3.0
            else:
                weights[title] += 3.0 if value == "love" else 1.5
        weights[~visible] = 0.0
        total = float(np.abs(weights).sum())
        raw = self.features.T @ weights
        norm = float(np.linalg.norm(raw))
        return (raw / norm if norm > 0 else raw), total

    def home(
        self,
        *,
        profile_hash: int,
        ceiling_rank: int,
        library: Library,
        now_ms: int,
        explore: bool,
        rng: np.random.Generator,
    ) -> list[Module]:
        catalog = self.catalog
        visible = (catalog.maturity_rank <= ceiling_rank) & (catalog.added_at <= now_ms)
        taste, total = self.taste(library, now_ms, visible)
        cold = total < 0.5
        affinity = self.features @ taste if not cold else np.zeros(self.titles)
        day = self.popularity.day(now_ms)
        trend = self.popularity.trend[day]
        age_days = (now_ms - catalog.added_at) / DAY_MS
        fresh = np.exp(-np.maximum(age_days, 0) / FRESHNESS_DAYS)
        if cold:
            score = 0.5 * self.pop + 0.35 * trend + 0.15 * fresh
        else:
            score = 0.55 * affinity + 0.2 * self.pop + 0.15 * trend + 0.1 * fresh
        disliked = np.zeros(self.titles, dtype=bool)
        for title, value in library.ratings.items():
            if value == "dislike":
                disliked[title] = True
        finished = np.zeros(self.titles, dtype=bool)
        started = np.zeros(self.titles, dtype=bool)
        for title, progress in library.progress.items():
            finished[title] = progress.finished
            started[title] = progress.engaged
        candidates = visible & ~disliked
        ranked_score = score - finished.astype(np.float64)
        order = np.lexsort((np.arange(self.titles), -ranked_score))

        def by_score(mask: npt.NDArray[np.bool_]) -> npt.NDArray[np.int64]:
            return order[mask[order]][:ROW_ITEMS]

        modules: list[Module] = []
        # Billboard: a strong match the profile has not started, rotating daily among the top 3.
        pool = order[(candidates & ~started & ~finished)[order]][:12]
        if len(pool):
            bonus = (
                0.6 * (1 - np.arange(len(pool)) / max(1, len(pool) - 1))
                + 0.2 * fresh[pool]
                + 0.1 * self.original[pool]
            )
            top = pool[np.argsort(-bonus, kind="stable")][:3]
            pick = top[(profile_hash + day) % len(top)]
            modules.append(Module("home:billboard", "billboard", np.array([pick])))
        continuing = [
            (progress.last_ms, title)
            for title, progress in library.progress.items()
            if progress.engaged and not progress.finished and visible[title] and not disliked[title]
        ]
        if continuing:
            continuing.sort(reverse=True)
            modules.append(
                Module(
                    "home:continue-watching",
                    "continue-watching",
                    np.array([t for _, t in continuing][:ROW_ITEMS]),
                )
            )
        recent = np.where(visible, self.popularity.recent[day], -1.0)
        top10 = np.lexsort((np.arange(self.titles), -recent))[: min(10, int(visible.sum()))]
        modules.append(Module("home:top-10", "top-10", top10))
        trending_rank = trend + (0.0 if cold else 0.25 * np.maximum(affinity, 0)) + 0.001 * self.pop
        trending = np.lexsort((np.arange(self.titles), -trending_rank))
        modules.append(
            Module("home:trending", "trending", trending[candidates[trending]][:ROW_ITEMS])
        )
        if library.list_added:
            listed = sorted(library.list_added.items(), key=lambda item: -item[1])
            items = [t for t, _ in listed if visible[t]][:ROW_ITEMS]
            if items:
                modules.append(Module("home:my-list", "my-list", np.array(items)))
        sources = sorted(
            (
                (progress.last_ms, title)
                for title, progress in library.progress.items()
                if visible[title]
                and not disliked[title]
                and (progress.finished or progress.started >= 1)
                and progress.engaged
            ),
            reverse=True,
        )
        because: list[Module] = []
        for _, source in sources:
            if len(because) >= 3:
                break
            rank = 0.75 * self.similarity[source] + 0.25 * np.maximum(affinity, 0)
            neighbours = np.lexsort((np.arange(self.titles), -rank))
            neighbours = neighbours[(candidates & ~finished)[neighbours] & (neighbours != source)][
                :ROW_ITEMS
            ]
            if len(neighbours) >= MIN_ROW_ITEMS:
                because.append(
                    Module(
                        f"home:because-you-watched:{self.ids[source]}",
                        "because-you-watched",
                        neighbours,
                    )
                )
        if because:
            modules.append(because[0])
        added_order = np.lexsort((np.arange(self.titles), -catalog.added_at))
        new = added_order[(candidates & (age_days <= NEW_RELEASE_DAYS))[added_order]]
        if len(new) < 2 * MIN_ROW_ITEMS:
            new = added_order[candidates[added_order]][:ROW_ITEMS]
        if len(new) >= MIN_ROW_ITEMS:
            modules.append(Module("home:new-releases", "new-releases", new[:ROW_ITEMS]))
        genre_rows = self._genre_rows(candidates, visible, taste, cold, trend, by_score)
        if genre_rows:
            modules.append(genre_rows[0])
        originals = by_score(candidates & self.original)
        if len(originals) >= MIN_ROW_ITEMS:
            modules.append(Module("home:originals", "originals", originals))
        if len(because) > 1:
            modules.append(because[1])
        modules.extend(genre_rows[1:3])
        again = sorted(
            (
                (progress.last_ms, title)
                for title, progress in library.progress.items()
                if progress.finished and visible[title] and not disliked[title]
            ),
            reverse=True,
        )
        if again:
            modules.append(
                Module(
                    "home:watch-again", "watch-again", np.array([t for _, t in again][:ROW_ITEMS])
                )
            )
        modules.extend(genre_rows[3:4])
        if len(because) > 2:
            modules.append(because[2])
        modules.extend(genre_rows[4:])
        modules = self._variety(modules)
        if explore:
            modules = self._shuffle(modules, rng)
        return modules

    def _genre_rows(
        self,
        candidates: npt.NDArray[np.bool_],
        visible: npt.NDArray[np.bool_],
        taste: npt.NDArray[np.float64],
        cold: bool,
        trend: npt.NDArray[np.float64],
        by_score: Callable[[npt.NDArray[np.bool_]], npt.NDArray[np.int64]],
    ) -> list[Module]:
        membership = self.catalog.genre_membership
        counts = (membership & candidates[:, None]).sum(axis=0)
        prior = ((self.pop + trend)[:, None] * (membership & visible[:, None])).sum(axis=0)
        prior = prior / max(float(prior.max()), 1e-9)
        preference = (0.0 if cold else taste[self.genre_columns]) + 0.15 * prior
        eligible = np.where(counts >= MIN_GENRE_ITEMS)[0]
        chosen = eligible[np.lexsort((eligible, -preference[eligible]))][:8]
        rows = []
        for genre in chosen:
            items = by_score(candidates & membership[:, genre])
            rows.append(Module(f"home:genre:{self.genre_slugs[genre]}", "genre", items))
        return rows

    @staticmethod
    def _variety(modules: list[Module]) -> list[Module]:
        fixed = {
            "billboard",
            "continue-watching",
            "my-list",
            "top-10",
            "watch-again",
            "because-you-watched",
            "new-releases",
        }
        prominent: set[int] = set()
        out = []
        for module in modules:
            items = module.items
            if module.kind not in fixed and len(items):
                seen = np.array([int(i) in prominent for i in items])
                items = np.concatenate([items[~seen], items[seen]])
            prominent.update(int(i) for i in items[:PROMINENT])
            out.append(Module(module.row_id, module.kind, items))
        return out

    @staticmethod
    def _shuffle(modules: list[Module], rng: np.random.Generator) -> list[Module]:
        """Exploration: random module order (billboard and Continue Watching stay first) and
        random item order within each row."""
        head = [m for m in modules if m.kind in {"billboard", "continue-watching"}]
        tail = [m for m in modules if m.kind not in {"billboard", "continue-watching"}]
        permutation = rng.permutation(len(tail))
        shuffled = [tail[i] for i in permutation]
        return head + [Module(m.row_id, m.kind, rng.permutation(m.items)) for m in shuffled]
