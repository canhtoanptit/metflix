"""Gradient-boosted ranker trained on impressions and plays, with position bias corrected.

Training example: an impression of a title the profile had not watched, in a browsing row,
labelled 1 when the profile went on to play it (>= 30 s, within 30 minutes). A play depends on
the title *and* on where it was shown: under the examination hypothesis

    P(play | impression at (r, k), x) = theta(r, k) * gamma(x)

where theta is the probability the member looked at that position (estimated from exploration
traffic, models/propensity.py) and gamma(x) the probability they play it once seen, which is
what ranking should order by. Training on raw labels would credit the logging policy's top
positions to their titles' features.

Correction: expectation-maximisation with theta fixed (regression-EM, Wang et al. WSDM 2018).
E-step: a play means relevant; for an impression without a play the posterior of relevance is
    P(R = 1 | no play) = (1 - theta) gamma / (1 - theta gamma).
M-step: fit the gradient-boosted classifier on soft labels, written as two weighted copies of
each example (positive with weight P(R=1), negative with weight 1 - P(R=1)), which is the exact
expected log-likelihood and keeps every weight non-negative. Three rounds, starting from the
naive model. Serving ranks by gamma(x): there is no position input to neutralise.

Why pointwise gradient boosting (scikit-learn's histogram GBDT) rather than LambdaMART in
LightGBM or XGBoost: both of those need a system OpenMP runtime on macOS (`brew install libomp`),
which this project does not allow; the pointwise EM objective is the standard unbiased one for
this setting and yields calibrated probabilities that the re-ranker can trade against diversity.
`mode="naive"` (raw labels) is kept for the ablation in the evaluation report.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt
from sklearn.ensemble import HistGradientBoostingClassifier

Array = npt.NDArray[np.float64]


def _model(seed: int, iterations: int) -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        loss="log_loss",
        learning_rate=0.06,
        max_iter=iterations,
        max_leaf_nodes=31,
        min_samples_leaf=80,
        l2_regularization=1.0,
        early_stopping=False,
        random_state=seed,
    )


@dataclass
class Ranker:
    mode: str = "em"
    rounds: int = 3
    iterations: int = 250
    seed: int = 7
    model: Any = None
    #: Round 0 of EM is the naive model (raw labels): kept for the ablation, not refitted.
    naive_model: Any = None
    feature_names: tuple[str, ...] = ()
    history: list[dict[str, float]] = field(default_factory=list)

    def fit(
        self,
        features: npt.NDArray[np.float32],
        played: npt.NDArray[np.bool_],
        theta: Array,
        feature_names: tuple[str, ...],
    ) -> Ranker:
        self.feature_names = feature_names
        played = np.asarray(played, dtype=bool)
        labels = played.astype(np.float64)
        model = _model(self.seed, self.iterations)
        model.fit(features, played.astype(np.int64))
        self.naive_model = model
        self.history = [{"round": 0, "mean_label": float(labels.mean())}]
        if self.mode == "em":
            theta = np.clip(theta, 0.02, 1.0)
            for round_ in range(1, self.rounds + 1):
                gamma = np.clip(model.predict_proba(features)[:, 1], 1e-6, 1 - 1e-6)
                # Under the model P(play) = theta * gamma <= theta: keep gamma below 1/theta.
                posterior = np.where(
                    played, 1.0, (1.0 - theta) * gamma / np.maximum(1.0 - theta * gamma, 1e-9)
                )
                negatives = ~played
                x = np.concatenate([features, features[negatives]])
                y = np.concatenate(
                    [
                        np.ones(len(features), dtype=np.int64),
                        np.zeros(int(negatives.sum()), dtype=np.int64),
                    ]
                )
                w = np.concatenate([posterior, 1.0 - posterior[negatives]])
                keep = w > 1e-9
                model = _model(self.seed + round_, self.iterations)
                model.fit(x[keep], y[keep], sample_weight=w[keep])
                self.history.append({"round": round_, "mean_relevance": float(posterior.mean())})
        self.model = model
        return self

    def naive(self) -> Ranker:
        """The round-0 model as a ranker of its own (the ablation without position correction)."""
        return Ranker(
            mode="naive",
            rounds=0,
            iterations=self.iterations,
            seed=self.seed,
            model=self.naive_model,
            feature_names=self.feature_names,
        )

    def predict(self, features: npt.NDArray[np.float32]) -> Array:
        if self.model is None:
            raise RuntimeError("fit the ranker first")
        shape = features.shape
        flat = features.reshape(-1, shape[-1])
        probability: Array = self.model.predict_proba(flat)[:, 1]
        return probability.reshape(shape[:-1])
