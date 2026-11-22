"""Ranking metrics against hand computations, and the bootstrap."""

from __future__ import annotations

import math

import numpy as np

from webflix_recs.evaluation import metrics as m


def test_accuracy_metrics_match_hand_computation() -> None:
    gains = np.zeros((1, 6))
    gains[0, 1] = 2.0
    gains[0, 4] = 1.0
    lists = np.array([[1, 2, 4, -1]])
    values = m.accuracy(lists, gains, 3)
    assert values["recall@3"][0] == 1.0
    dcg = 2.0 / math.log2(2) + 1.0 / math.log2(4)
    idcg = 2.0 / math.log2(2) + 1.0 / math.log2(3)
    assert math.isclose(values["ndcg@3"][0], dcg / idcg)
    assert math.isclose(values["map@3"][0], (1.0 + 2 / 3) / 2)
    assert values["hit@3"][0] == 1.0


def test_beyond_accuracy_metrics() -> None:
    similarity = np.eye(4)
    similarity[0, 1] = similarity[1, 0] = 1.0
    lists = np.array([[0, 1, -1], [2, 3, -1]])
    diversity = m.diversity(lists, similarity, 3)
    assert np.allclose(diversity, [0.0, 1.0])
    info = np.array([1.0, 2.0, 3.0, 4.0])
    assert np.allclose(m.novelty(lists, info, 3), [1.5, 3.5])
    assert m.coverage(lists, 3, available=8) == 0.5
    truth = np.arange(8, dtype=float).reshape(2, 4)
    assert np.allclose(m.utility(lists, truth, 3), [0.5, 6.5])


def test_bootstrap_interval_covers_the_mean_and_pairs_are_consistent() -> None:
    rng = np.random.default_rng(2)
    a = rng.normal(1.0, 1.0, 2000)
    b = a + 0.1 + rng.normal(0, 0.05, 2000)
    boot = m.Bootstrap(2000, replicates=400, seed=3)
    interval = boot.interval(a)
    standard_error = a.std() / math.sqrt(len(a))
    assert interval.low < a.mean() < interval.high
    assert math.isclose(interval.high - interval.low, 2 * 1.96 * standard_error, rel_tol=0.15)
    paired = boot.interval(b - a)
    unpaired_width = boot.interval(b).high - boot.interval(b).low
    assert paired.low > 0.09 and paired.high - paired.low < unpaired_width / 5
