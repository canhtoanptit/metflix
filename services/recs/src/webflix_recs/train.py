"""`train`: fit every model at one knowledge cutoff and record a reproducible run.

Temporal stacking, so the ranker never learns from features that already saw its labels:

    stage A  candidate models (co-watch, ALS, content) on history as of  T - ranker_window
    stage B  the ranker on impressions in [T - ranker_window, T), features from stage A,
             position bias from the exploration impressions received before T
    stage C  candidate models refitted on history as of T: what evaluation and scoring use

Everything the run used is in its manifest (`recs-work/runs/{run}/manifest.json`): dataset and
knowledge cutoff, the largest receipt time read, code version and digest, parameters, seeds,
recipe hash and training metrics. Model files are stored next to it with their SHA-256, which
is checked before loading.
"""

from __future__ import annotations

import io
import pickle
import time
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
import polars as pl

from webflix_recs.catalog import Catalog
from webflix_recs.dataset import DatasetResult
from webflix_recs.features import FEATURES, FeatureContext
from webflix_recs.history import History, LeakError
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.models.als import ImplicitALS
from webflix_recs.models.content import ContentModel
from webflix_recs.models.cowatch import CoWatch
from webflix_recs.models.propensity import FIXED_ROWS, Propensity
from webflix_recs.models.ranker import Ranker
from webflix_recs.models.rerank import RerankWeights
from webflix_recs.provenance import code_version, recipe_hash, sha256
from webflix_recs.storage import Storage, get_json, put_json

RUNS_PREFIX = "recs-work/runs/"


@dataclass(frozen=True)
class TrainParams:
    seed: int = 7
    # Chosen on the validation window before the cutoff (logged NDCG@10, never the simulator's
    # truth): with ~120 titles, 32 factors overfit; 12 with strong regularisation do not.
    factors: int = 12
    regularisation: float = 30.0
    alpha: float = 8.0
    iterations: int = 12
    shrinkage: float = 20.0
    blend_prior: float = 30.0
    content_dimensions: int = 24
    ranker_window_days: int = 7
    ranker_mode: str = "em"
    em_rounds: int = 3
    max_training_impressions: int = 1_500_000
    neighbours: int = 40
    rerank: RerankWeights = field(default_factory=RerankWeights)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TrainParams:
        values = dict(data)
        if isinstance(values.get("rerank"), dict):
            values["rerank"] = RerankWeights(**values["rerank"])
        return cls(**values)


@dataclass
class Models:
    params: TrainParams
    content: ContentModel
    cowatch: CoWatch
    als: ImplicitALS
    blend: np.ndarray[Any, Any]
    ranker: Ranker
    propensity: Propensity
    ranker_naive: Ranker | None = None

    def context(self, history: History) -> FeatureContext:
        return FeatureContext(history, self.cowatch, self.als, self.content, self.blend)


def _candidate_models(
    history: History, content: ContentModel, params: TrainParams
) -> tuple[CoWatch, ImplicitALS, Any]:
    cowatch = CoWatch.fit(history.watched, shrinkage=params.shrinkage)
    als = ImplicitALS(
        factors=params.factors,
        regularisation=params.regularisation,
        alpha=params.alpha,
        iterations=params.iterations,
        seed=params.seed,
    )
    als.fit(history.strength, history.negative)
    als.cold_start_items(content.vectors, warm=history.title_profiles > 0)
    blend = cowatch.blended(content.similarity, prior=params.blend_prior)
    return cowatch, als, blend


def ranker_examples(
    dataset: DatasetResult,
    history: History,
    start_ms: int,
    end_ms: int,
    *,
    max_rows: int,
    seed: int,
) -> pl.DataFrame:
    """Impressions in [start, end) of titles the profile had not watched, in browsing rows, with
    their labels (known by `end_ms`)."""
    impressions = dataset.tables["impressions"].filter(
        (pl.col("event_time") >= start_ms)
        & (pl.col("event_time") < end_ms - 30 * 60_000)
        & (pl.col("received_at") < end_ms)
        & ~pl.col("row_kind").is_in(list(FIXED_ROWS))
        & ~pl.col("censored")
        & pl.col("profile").is_in(history.profiles)
    )
    rows = np.array([history.index[p] for p in impressions["profile"].to_list()], dtype=np.int64)
    titles = np.array(
        [history.catalog.index.get(t, -1) for t in impressions["title_id"].to_list()],
        dtype=np.int64,
    )
    frame = impressions.with_columns(pl.Series("p", rows), pl.Series("t", titles)).filter(
        pl.col("t") >= 0
    )
    seen = history.watched[frame["p"].to_numpy(), frame["t"].to_numpy()]
    frame = frame.filter(pl.Series(~seen))
    if frame.height > max_rows:
        profiles = frame["profile"].unique().sort()
        keep = profiles.sample(fraction=max_rows / frame.height, seed=seed, shuffle=True)
        frame = frame.filter(pl.col("profile").is_in(keep.to_list()))
    return frame


def gather_features(
    context: FeatureContext, frame: pl.DataFrame, chunk: int = 4000
) -> np.ndarray[Any, Any]:
    rows = frame["p"].to_numpy()
    titles = frame["t"].to_numpy()
    unique = np.unique(rows)
    out = np.empty((len(rows), len(FEATURES)), dtype=np.float32)
    for start in range(0, len(unique), chunk):
        block = unique[start : start + chunk]
        matrix = context.matrix(block)
        local = {int(p): i for i, p in enumerate(block)}
        selected = np.isin(rows, block)
        positions = np.array([local[int(p)] for p in rows[selected]], dtype=np.int64)
        out[selected] = matrix[positions, titles[selected]]
    return out


def train(
    catalog: Catalog,
    dataset: DatasetResult,
    *,
    as_of_ms: int,
    params: TrainParams,
    naive_ablation: bool = True,
    log: Any = print,
    allow_future: bool = False,
) -> tuple[Models, dict[str, Any]]:
    if as_of_ms > dataset.manifest["asOfMs"] and not allow_future:
        raise LeakError(
            f"cannot train as of {iso_ms(as_of_ms)}: dataset {dataset.dataset_id} only knows "
            f"events received before {dataset.manifest['asOf']}"
        )
    timings: dict[str, float] = {}
    started = time.perf_counter()
    profiles = dataset.tables["profiles"]["profile"].sort().to_list()
    window_start = as_of_ms - params.ranker_window_days * DAY_MS
    content = ContentModel.fit(catalog, dimensions=params.content_dimensions, seed=params.seed)

    stage = time.perf_counter()
    history_a = History.build(dataset, catalog, window_start, profiles=profiles)
    cowatch_a, als_a, blend_a = _candidate_models(history_a, content, params)
    timings["stageA"] = time.perf_counter() - stage

    stage = time.perf_counter()
    known = dataset.tables["impressions"].filter(pl.col("received_at") < as_of_ms)
    propensity = Propensity.estimate(
        known.filter(pl.col("event_time") < as_of_ms - 30 * 60_000), seed=params.seed
    )
    examples = ranker_examples(
        dataset,
        history_a,
        window_start,
        as_of_ms,
        max_rows=params.max_training_impressions,
        seed=params.seed,
    )
    context_a = FeatureContext(history_a, cowatch_a, als_a, content, blend_a)
    features = gather_features(context_a, examples)
    played = examples["played"].to_numpy()
    theta = propensity.theta(examples["row_rank"].to_numpy(), examples["rank"].to_numpy())
    ranker = Ranker(mode=params.ranker_mode, rounds=params.em_rounds, seed=params.seed).fit(
        features, played, theta, FEATURES
    )
    naive = ranker.naive() if naive_ablation and params.ranker_mode != "naive" else None
    timings["stageB"] = time.perf_counter() - stage

    stage = time.perf_counter()
    history = History.build(
        dataset, catalog, as_of_ms, profiles=profiles, allow_future=allow_future
    )
    cowatch, als, blend = _candidate_models(history, content, params)
    timings["stageC"] = time.perf_counter() - stage
    models = Models(params, content, cowatch, als, blend, ranker, propensity, naive)
    report = {
        "profiles": len(profiles),
        "historyProfilesWithPlays": int((history.plays > 0).sum()),
        "rankerExamples": len(played),
        "rankerPositives": int(played.sum()),
        "rankerHistory": ranker.history,
        "alsLoss": als.loss_history,
        "contentExplainedVariance": round(content.explained_variance, 4),
        "propensity": propensity.to_dict(),
        "maxReceivedAt": iso_ms(history.max_received_ms) if history.max_received_ms else None,
        "maxReceivedAtMs": history.max_received_ms,
        "timings": {k: round(v, 2) for k, v in timings.items()},
        "seconds": round(time.perf_counter() - started, 2),
    }
    log(
        f"trained as of {iso_ms(as_of_ms)}: {report['rankerExamples']} ranker examples, "
        f"propensity gamma={propensity.exponent:.3f}"
    )
    return models, report


def run_id_for(as_of_ms: int, recipe: str) -> str:
    """`20261006-000000-36d19930`: knowledge cutoff (UTC) and recipe; lowercase and URL-safe so
    it reads the same as a blob key, a KV key and a database value."""
    stamp = iso_ms(as_of_ms)
    day = f"{stamp[0:4]}{stamp[5:7]}{stamp[8:10]}"
    return f"{day}-{stamp[11:13]}{stamp[14:16]}{stamp[17:19]}-{recipe[:8]}"


def save_run(
    storage: Storage,
    models: Models,
    report: dict[str, Any],
    *,
    dataset: DatasetResult,
    catalog: Catalog,
    as_of_ms: int,
    run_id: str | None = None,
) -> dict[str, Any]:
    params = models.params.to_dict()
    recipe = recipe_hash(params)
    run = run_id or run_id_for(as_of_ms, recipe)
    arrays = io.BytesIO()
    np.savez_compressed(
        arrays,
        content=models.content.vectors,
        item_factors=models.als.item_factors
        if models.als.item_factors is not None
        else np.zeros(0),
        cowatch=models.cowatch.similarity,
        support=models.cowatch.support,
        blend=models.blend,
    )
    blobs = {
        "models.npz": arrays.getvalue(),
        "ranker.pkl": pickle.dumps(models.ranker, protocol=5),
        "propensity.pkl": pickle.dumps(models.propensity, protocol=5),
    }
    if models.ranker_naive is not None:
        blobs["ranker-naive.pkl"] = pickle.dumps(models.ranker_naive, protocol=5)
    files = {}
    for name, body in blobs.items():
        storage.put(f"{RUNS_PREFIX}{run}/{name}", body)
        files[name] = {"sha256": sha256(body), "bytes": len(body)}
    manifest = {
        "format": "webflix.recs-run",
        "formatVersion": 1,
        "run": run,
        "recipeHash": recipe,
        "code": code_version(),
        "params": params,
        "data": {
            "datasetId": dataset.dataset_id,
            "datasetAsOf": dataset.manifest["asOf"],
            "asOf": iso_ms(as_of_ms),
            "asOfMs": as_of_ms,
            "maxReceivedAt": report.get("maxReceivedAt"),
            "maxReceivedAtMs": report.get("maxReceivedAtMs"),
            "catalogVersion": catalog.version,
        },
        "files": files,
        "metrics": report,
        "createdAt": iso_ms(int(time.time() * 1000)),
    }
    put_json(storage, f"{RUNS_PREFIX}{run}/manifest.json", manifest)
    return manifest


def load_run(storage: Storage, run: str) -> tuple[Models, dict[str, Any]]:
    manifest = get_json(storage, f"{RUNS_PREFIX}{run}/manifest.json")
    if manifest is None:
        raise FileNotFoundError(f"no run {run} in {storage.describe()}")
    blobs: dict[str, bytes] = {}
    for name, meta in manifest["files"].items():
        body = storage.get(f"{RUNS_PREFIX}{run}/{name}")
        if body is None or sha256(body) != meta["sha256"]:
            raise ValueError(f"run {run}: {name} is missing or does not match its recorded SHA-256")
        blobs[name] = body
    params = TrainParams.from_dict(manifest["params"])
    arrays = np.load(io.BytesIO(blobs["models.npz"]))
    als = ImplicitALS(
        factors=params.factors,
        regularisation=params.regularisation,
        alpha=params.alpha,
        iterations=params.iterations,
        seed=params.seed,
    )
    als.item_factors = arrays["item_factors"]
    support = arrays["support"]
    cowatch = CoWatch(
        similarity=arrays["cowatch"], support=support, item_counts=np.diag(support).copy()
    )
    content = ContentModel(
        vectors=arrays["content"],
        explained_variance=float(manifest["metrics"].get("contentExplainedVariance", 0.0)),
    )
    # The pickles were written by this pipeline and verified against the manifest's SHA-256.
    ranker = pickle.loads(blobs["ranker.pkl"])  # noqa: S301
    propensity = pickle.loads(blobs["propensity.pkl"])  # noqa: S301
    naive = pickle.loads(blobs["ranker-naive.pkl"]) if "ranker-naive.pkl" in blobs else None  # noqa: S301
    return Models(
        params, content, cowatch, als, arrays["blend"], ranker, propensity, naive
    ), manifest
