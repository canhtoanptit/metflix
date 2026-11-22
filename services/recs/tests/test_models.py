"""Models on planted data where the right answer is known."""

from __future__ import annotations

import numpy as np
import polars as pl

from helpers import synthetic_catalog
from webflix_recs.evaluation import metrics as m
from webflix_recs.models.als import ImplicitALS
from webflix_recs.models.content import ContentModel
from webflix_recs.models.cowatch import CoWatch
from webflix_recs.models.propensity import Propensity
from webflix_recs.models.ranker import Ranker
from webflix_recs.models.rerank import RerankWeights, rerank


def _planted(
    users: int = 3000, items: int = 60, rank: int = 4, seed: int = 3
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    u = rng.normal(size=(users, rank))
    v = rng.normal(size=(items, rank))
    utility = u @ v.T + 0.3 * rng.normal(size=(users, items))
    watched = rng.random((users, items)) < 1 / (1 + np.exp(-(utility - 2.5)))
    held_out = watched & (rng.random(watched.shape) < 0.2)
    return utility, watched & ~held_out, held_out


def test_als_recovers_planted_preferences_better_than_popularity() -> None:
    _, train, test = _planted()
    als = ImplicitALS(factors=8, regularisation=5.0, alpha=4.0, iterations=8)
    als.fit(train.astype(np.float32), np.zeros_like(train))
    assert als.loss_history is not None and als.loss_history[-1] < als.loss_history[0]
    assert als.item_factors is not None
    scores = als.fold_in(train.astype(np.float32), np.zeros_like(train)) @ als.item_factors.T
    universe = ~train

    def ndcg(s: np.ndarray) -> float:
        lists = np.argsort(-np.where(universe, s, -np.inf), axis=1)[:, :10]
        return float(m.accuracy(lists, test.astype(float), 10)["ndcg@10"].mean())

    popularity = np.repeat(train.sum(axis=0, keepdims=True).astype(float), train.shape[0], axis=0)
    assert ndcg(scores) > ndcg(popularity) + 0.05


def test_cowatch_is_symmetric_shrunk_and_blends_content_for_unwatched_titles() -> None:
    rng = np.random.default_rng(1)
    watched = rng.random((500, 20)) < 0.2
    watched[:, 19] = False  # a new title nobody has watched
    model = CoWatch.fit(watched, shrinkage=20.0)
    assert np.allclose(model.similarity, model.similarity.T)
    assert np.all(np.diag(model.similarity) == 0)
    weak = CoWatch.fit(watched[:20], shrinkage=20.0)
    assert weak.similarity.max() < model.similarity.max()  # little support, pulled to zero
    content = np.full((20, 20), 0.5)
    blend = model.blended(content)
    assert np.allclose(blend[19, :19], 0.5)  # pure content for the unwatched title


def test_content_vectors_are_normalised_and_group_similar_titles() -> None:
    catalog = synthetic_catalog(40)
    model = ContentModel.fit(catalog, dimensions=12)
    assert np.allclose(np.linalg.norm(model.vectors, axis=1), 1.0)
    kids = [t.index for t in catalog.titles if "g-kids-family" in t.genre_ids]
    others = [t.index for t in catalog.titles if "g-kids-family" not in t.genre_ids]
    sim = model.similarity
    assert sim[np.ix_(kids, kids)].mean() > sim[np.ix_(kids, others)].mean() + 0.2


def _biased_impressions(
    n: int, gamma: float, seed: int, explore_share: float = 0.3
) -> pl.DataFrame:
    """Rows of 8 cards; play = examined(rank) x relevant(quality). Exploration rows are random;
    the others put the most popular titles first (a popularity-led logging policy)."""
    rng = np.random.default_rng(seed)
    rows = []
    for row in range(n):
        explore = rng.random() < explore_share
        quality = rng.random(8)
        popularity = quality * 0.3 + rng.random(8) * 0.7
        order = rng.permutation(8) if explore else np.argsort(-popularity)
        for k, item in enumerate(order, start=1):
            examined = rng.random() < k**-gamma
            played = examined and rng.random() < quality[item] * 0.6
            rows.append((f"p{row % 400}", k, 3, explore, played, quality[item], popularity[item]))
    return pl.DataFrame(
        rows,
        schema=["profile", "rank", "row_rank", "explore", "started", "quality", "popularity"],
        orient="row",
    ).with_columns(
        pl.lit("genre").alias("row_kind"),
        pl.col("started").alias("played"),
        pl.col("started").alias("opened"),
    )


def test_propensity_estimate_recovers_the_planted_position_bias() -> None:
    frame = _biased_impressions(12_000, gamma=0.7, seed=4)
    estimate = Propensity.estimate(frame, bootstrap=100)
    assert abs(estimate.exponent - 0.7) < 0.12
    low, high = estimate.exponent_interval
    assert low < 0.7 < high


def test_em_ranker_corrects_position_bias_that_a_naive_ranker_learns() -> None:
    frame = _biased_impressions(5_000, gamma=1.0, seed=5, explore_share=0.0)
    features = frame.select("popularity", "quality").to_numpy().astype(np.float32)
    # Popularity predicts position, position predicts plays: a naive model over-credits it.
    features = np.column_stack(
        [features[:, 0], features[:, 1] + np.random.default_rng(0).normal(0, 0.15, len(frame))]
    ).astype(np.float32)
    played = frame["played"].to_numpy()
    theta = frame["rank"].to_numpy().astype(float) ** -1.0
    ranker = Ranker(mode="em", rounds=3, seed=1, iterations=60).fit(
        features, played, theta, ("popularity", "quality_signal")
    )
    naive = ranker.naive()
    grid = np.random.default_rng(9).random((4000, 2)).astype(np.float32)
    truth = grid[:, 1]

    def corr(model: Ranker) -> float:
        return float(np.corrcoef(model.predict(grid), truth)[0, 1])

    assert corr(ranker) > corr(naive) + 0.02


def test_rerank_returns_k_distinct_candidates_and_trades_relevance_for_diversity() -> None:
    scores = np.linspace(1.0, 0.0, 30)
    similarity = np.eye(30)
    similarity[:10, :10] = 0.95  # the ten best are near duplicates
    np.fill_diagonal(similarity, 1.0)
    candidates = np.ones(30, dtype=bool)
    candidates[5] = False
    picks = rerank(
        scores,
        candidates,
        similarity,
        np.full(30, 100.0),
        np.zeros(30),
        10,
        RerankWeights(diversity_lambda=0.5),
    )
    assert len(picks) == len(set(picks)) == 10 and 5 not in picks
    assert picks[0] == 0 and sum(p < 10 for p in picks) < 10
    plain = rerank(
        scores,
        candidates,
        similarity,
        np.full(30, 100.0),
        np.zeros(30),
        10,
        RerankWeights(diversity_lambda=1.0),
    )
    assert plain == [i for i in range(11) if i != 5]
