"""`evaluate`: a temporal backtest of a trained run against baselines.

Protocol:

* Cutoff T is the run's knowledge cutoff. The harness refuses (`LeakError`) a run trained on
  anything received at or after T, a run whose cutoff is later than T, external rankings
  produced after T, and a dataset that does not cover the test window [T, T + horizon).
* Population: eligible profiles (unrestricted, consenting) with at least one *discovery* in the
  test window: a qualified play (>= 30 s) of a title that had arrived by T and that the profile
  had not played (>= 30 s) before T. Gain 1, or 2 when an item was completed.
* Every system ranks the same universe per profile (arrived by T, not watched before T); titles
  outside it are dropped from every system's list before scoring, so no system is penalised
  for recommending what Continue Watching or Watch It Again cover.
* Systems: random, popularity, co-watch item-kNN, ALS, content, the ranker (debiased and naive),
  the final re-ranked list (`learned`), the real milestone 1 engine (`rule-engine`: its score
  order; `rule-engine-home`: its home page reading order), any external rankings file, and the
  oracle (true utility) when the simulator's truth is given.
* Three families of accuracy metrics, because logged plays are not neutral:
  - replay on all discoveries (`ndcg@10`, ...): what members played in the test window. They
    could only play what the platform showed them, and the platform showed them what the
    incumbent policy ranked high, so this family favours whatever resembles the logging policy
    (on the simulator the rule engine's home order scores above the oracle here);
  - replay on search discoveries (`search:ndcg@10`, ...): titles members reached through
    search, which they sought out whatever the rows showed; robust to exposure, smaller sample;
  - true utility (`utility@10`, `regret@10`): the simulator's ground truth, unaffected by
    exposure; simulator only.
* Intervals: percentile bootstrap over profiles (1000 resamples), paired for differences.

Gate (`GATE_METRIC`): `utility@10` of `learned` against `rule-engine` when the simulator's truth
is given, the paired 95% interval of the difference entirely above zero. Expected true utility
of the first ten recommendations is what the blueprint's "beats the rule engine on the
simulator" means once exposure bias is taken seriously; ten is about the first screen (the
billboard and the first rows' visible cards). Without truth (real data) the gate falls back to
`search:ndcg@10`, and the online experiment remains the decision.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import orjson
import polars as pl

from webflix_recs import schemas
from webflix_recs.catalog import Catalog
from webflix_recs.dataset import DatasetResult
from webflix_recs.evaluation import metrics as m
from webflix_recs.history import History, LeakError, targets
from webflix_recs.ids import DAY_MS, iso_ms, parse_iso_ms
from webflix_recs.recommend import Recommender
from webflix_recs.train import Models

GATE_METRIC = "utility@10"
FALLBACK_GATE_METRIC = "search:ndcg@10"
CANDIDATE = "learned"
BASELINE = "rule-engine"
KS = (10, 20)
KMAX = 20
COLD_TITLE_DAYS = 14
COLD_PROFILE_DAYS = 14
COLD_PROFILE_PLAYS = 3


@dataclass
class EvaluationInputs:
    catalog: Catalog
    dataset: DatasetResult
    models: Models
    run_manifest: dict[str, Any]
    horizon_days: int = 7
    truth_dir: Path | None = None
    externals: dict[str, Path] | None = None
    bootstrap: int = 1000
    seed: int = 7
    allow_leak: bool = False
    max_profiles: int | None = None
    gate_metric: str | None = None
    #: Evaluation cutoff; defaults to the run's own knowledge cutoff.
    cutoff_ms: int | None = None


def check_leaks(inputs: EvaluationInputs, cutoff_ms: int) -> None:
    data = inputs.run_manifest["data"]
    problems = []
    if data["asOfMs"] > cutoff_ms:
        problems.append(
            f"the run was trained as of {data['asOf']}, "
            f"after the evaluation cutoff {iso_ms(cutoff_ms)}"
        )
    if data.get("maxReceivedAtMs") is not None and data["maxReceivedAtMs"] >= cutoff_ms:
        problems.append(
            f"the run read an event received at {data['maxReceivedAt']}, not before the cutoff"
        )
    end = cutoff_ms + inputs.horizon_days * DAY_MS
    if inputs.dataset.manifest["asOfMs"] < end:
        problems.append(
            f"dataset {inputs.dataset.dataset_id} ends at {inputs.dataset.manifest['asOf']}, "
            "before the test window ends"
        )
    if problems and not inputs.allow_leak:
        raise LeakError("; ".join(problems))


def load_external(path: Path, cutoff_ms: int, allow_leak: bool) -> tuple[str, dict[str, list[str]]]:
    with path.open("rb") as handle:
        lines = [line for line in handle.read().split(b"\n") if line.strip()]
    header = orjson.loads(lines[0])
    schemas.validate("rankings-header", header)
    if parse_iso_ms(header["asOf"]) > cutoff_ms and not allow_leak:
        raise LeakError(
            f"rankings {path.name} were produced as of {header['asOf']}, "
            f"after the cutoff {iso_ms(cutoff_ms)}"
        )
    rankings: dict[str, list[str]] = {}
    for line in lines[1:]:
        entry = orjson.loads(line)
        schemas.validate("rankings-line", entry)
        rankings[entry["profileKey"]] = entry["titleIds"]
    return str(header["system"]), rankings


def _lists_from_scores(
    scores: npt.NDArray[np.float64], universe: npt.NDArray[np.bool_], k: int
) -> npt.NDArray[np.int64]:
    masked = np.where(universe, scores, -np.inf)
    order = np.argsort(-masked, axis=1, kind="stable")[:, :k]
    valid = np.take_along_axis(universe, order, axis=1)
    return np.where(valid, order, -1).astype(np.int64)


def _lists_from_ids(
    rankings: dict[str, list[str]],
    profiles: list[str],
    index: dict[str, int],
    universe: npt.NDArray[np.bool_],
    k: int,
) -> npt.NDArray[np.int64]:
    out = np.full((len(profiles), k), -1, dtype=np.int64)
    for row, profile in enumerate(profiles):
        position = 0
        for title in rankings.get(profile, []):
            t = index.get(title)
            if t is None or not universe[row, t]:
                continue
            out[row, position] = t
            position += 1
            if position == k:
                break
    return out


def evaluate(inputs: EvaluationInputs, *, work_dir: Path, log: Any = print) -> dict[str, Any]:
    started = time.perf_counter()
    cutoff = (
        inputs.cutoff_ms
        if inputs.cutoff_ms is not None
        else int(inputs.run_manifest["data"]["asOfMs"])
    )
    check_leaks(inputs, cutoff)
    catalog = inputs.catalog
    dataset = inputs.dataset
    end = cutoff + inputs.horizon_days * DAY_MS
    eligible = dataset.tables["profiles"]["profile"].sort().to_list()
    history_all = History.build(dataset, catalog, cutoff, profiles=eligible)
    future = targets(dataset, catalog, cutoff, end, eligible)
    searched = targets(dataset, catalog, cutoff, end, eligible, search_only=True)
    available = catalog.available_mask(cutoff)
    population: list[str] = []
    for profile in eligible:
        row = history_all.index[profile]
        discoveries = [
            t for t in future.get(profile, {}) if available[t] and not history_all.watched[row, t]
        ]
        if discoveries:
            population.append(profile)
    if inputs.max_profiles is not None and len(population) > inputs.max_profiles:
        rng = np.random.default_rng(inputs.seed)
        population = sorted(rng.choice(population, inputs.max_profiles, replace=False).tolist())
    log(
        f"evaluating {len(population)} profiles with a discovery in "
        f"[{iso_ms(cutoff)}, {iso_ms(end)})"
    )
    history = History.build(dataset, catalog, cutoff, profiles=population)
    n, t_count = len(population), len(catalog)
    universe = available[None, :] & ~history.watched
    gains = np.zeros((n, t_count))
    search_gains = np.zeros((n, t_count))
    for row, profile in enumerate(population):
        for title, gain in future[profile].items():
            if universe[row, title]:
                gains[row, title] = gain
        for title, gain in searched.get(profile, {}).items():
            if universe[row, title]:
                search_gains[row, title] = gain
    has_search = (search_gains > 0).any(axis=1)

    # --- systems -------------------------------------------------------------------------------
    lists: dict[str, npt.NDArray[np.int64]] = {}
    rng = np.random.default_rng(inputs.seed)
    lists["random"] = _lists_from_scores(rng.random((n, t_count)), universe, KMAX)
    recommender = Recommender(inputs.models, history)
    systems = ("popularity", "cowatch", "mf", "content", "ranker", "ranker-naive")
    for name in (*systems, "learned"):
        lists.setdefault(name, np.full((n, KMAX), -1, dtype=np.int64))
    chunk = 4000
    for start in range(0, n, chunk):
        rows = np.arange(start, min(n, start + chunk))
        block = recommender.score(rows, systems)
        for name, scores in block.scores.items():
            lists[name][rows] = _lists_from_scores(scores, universe[rows], KMAX)
        for local, profile_row in enumerate(rows):
            row = int(profile_row)
            order = recommender.learned_order(
                block.scores["ranker"][local], universe[row], row, KMAX
            )
            padded = (order + [-1] * KMAX)[:KMAX]
            lists["learned"][row] = padded
    if inputs.models.ranker_naive is None:
        del lists["ranker-naive"]
    externals = dict(inputs.externals or {})
    if not any(name.startswith("rule-engine") for name in externals):
        from webflix_recs.evaluation.rule_engine import run_rule_engine  # noqa: PLC0415

        externals.update(run_rule_engine(history, catalog, population, work_dir / "rule-engine"))
    external_coverage = {}
    for path in externals.values():
        system, rankings = load_external(path, cutoff, inputs.allow_leak)
        lists[system] = _lists_from_ids(rankings, population, catalog.index, universe, KMAX)
        external_coverage[system] = round(
            sum(1 for p in population if p in rankings) / max(n, 1), 4
        )

    truth = None
    kinds = None
    if inputs.truth_dir is not None:
        truth_frame = pl.read_parquet(Path(inputs.truth_dir) / "profiles" / "*.parquet").filter(
            pl.col("profile_key").is_in(population)
        )
        lookup = {
            key: (kind, utility)
            for key, kind, utility in truth_frame.select(
                "profile_key", "kind", "utility"
            ).iter_rows()
        }
        truth = np.array([lookup[p][1] for p in population], dtype=np.float64)
        kinds = np.array([lookup[p][0] for p in population])
        lists["oracle"] = _lists_from_scores(truth, universe, KMAX)

    # --- metrics -------------------------------------------------------------------------------
    similarity = catalog.engine_similarity
    training_profiles = max(len(eligible), 1)
    p_title = (history_all.title_profiles.astype(np.float64) + 1.0) / (training_profiles + 2.0)
    self_information = -np.log2(p_title)
    per_profile: dict[str, dict[str, npt.NDArray[np.float64]]] = {}
    coverage: dict[str, dict[str, float]] = {}
    for system, ranked in lists.items():
        values: dict[str, npt.NDArray[np.float64]] = {}
        for k in KS:
            values.update(m.accuracy(ranked, gains, k))
            values.update(
                {
                    f"search:{name}": array
                    for name, array in m.accuracy(ranked, search_gains, k).items()
                }
            )
            values[f"diversity@{k}"] = m.diversity(ranked, similarity, k)
            values[f"novelty@{k}"] = m.novelty(ranked, self_information, k)
            if truth is not None:
                values[f"utility@{k}"] = m.utility(ranked, truth, k)
        per_profile[system] = values
        coverage[system] = {
            f"coverage@{k}": round(m.coverage(ranked, k, int(available.sum())), 4) for k in KS
        }
    if truth is not None:
        for values in per_profile.values():
            for k in KS:
                values[f"regret@{k}"] = (
                    per_profile["oracle"][f"utility@{k}"] - values[f"utility@{k}"]
                )

    bootstrap = m.Bootstrap(n, inputs.bootstrap, inputs.seed)
    tenure = history.tenure_days()
    cold_profile = (tenure < COLD_PROFILE_DAYS) | (history.plays < COLD_PROFILE_PLAYS)
    slices: dict[str, npt.NDArray[np.bool_]] = {
        "all": np.ones(n, dtype=bool),
        "cold": cold_profile,
        "warm": ~cold_profile,
    }
    if kinds is not None:
        for kind in sorted(set(kinds.tolist())):
            slices[f"kind:{kind}"] = kinds == kind
    results: dict[str, Any] = {}
    for system, values in per_profile.items():
        plain = {name: array for name, array in values.items() if not name.startswith("search:")}
        search = {name: array for name, array in values.items() if name.startswith("search:")}
        results[system] = {}
        for name, mask in slices.items():
            if not mask.any():
                continue
            summary = m.summarise(plain, bootstrap, mask)
            if (mask & has_search).any():
                summary |= m.summarise(search, bootstrap, mask & has_search)
            if name == "all":
                summary |= coverage[system]
            results[system][name] = summary
    # Cold-start titles: recall of the discoveries that were titles under 14 days old at T.
    age = (cutoff - catalog.added_at) / DAY_MS
    cold_titles = available & (age < COLD_TITLE_DAYS)
    cold_gains = np.where(cold_titles[None, :], gains, 0.0)
    has_cold = (cold_gains > 0).any(axis=1)
    cold_title_results = {}
    if has_cold.any():
        for system, ranked in lists.items():
            recall = m.accuracy(ranked, cold_gains, 20)["recall@20"]
            cold_title_results[system] = bootstrap.interval(recall, has_cold).to_list()

    def masked(metric: str) -> npt.NDArray[np.bool_] | None:
        return has_search if metric.startswith("search:") else None

    compared: tuple[str, ...] = (
        "ndcg@10",
        "recall@20",
        "map@10",
        "search:ndcg@10",
        "search:recall@20",
    )
    if truth is not None:
        compared += ("utility@10", "regret@10", "utility@20")
    differences: dict[str, Any] = {}
    if BASELINE in per_profile:
        for system in per_profile:
            if system == BASELINE:
                continue
            differences[system] = {
                metric: bootstrap.interval(
                    per_profile[system][metric] - per_profile[BASELINE][metric], masked(metric)
                ).to_list()
                for metric in compared
            }
    # Ablations: what each stage adds, paired on the same profiles.
    ablations: dict[str, Any] = {}
    for name, (with_, without) in {
        "position-bias correction (ranker - ranker-naive)": ("ranker", "ranker-naive"),
        "re-ranking (learned - ranker)": ("learned", "ranker"),
    }.items():
        if with_ in per_profile and without in per_profile:
            ablations[name] = {
                metric: bootstrap.interval(
                    per_profile[with_][metric] - per_profile[without][metric], masked(metric)
                ).to_list()
                for metric in (*compared, "diversity@10", "novelty@10")
                if metric in per_profile[with_]
            }
    gate_metric = inputs.gate_metric or (GATE_METRIC if truth is not None else FALLBACK_GATE_METRIC)
    gate: dict[str, Any] = {
        "metric": gate_metric,
        "candidate": CANDIDATE,
        "baseline": BASELINE,
        "level": 0.95,
    }
    if gate_metric not in per_profile[CANDIDATE]:
        gate.update(
            difference=None, passed=False, reason=f"{gate_metric} is not available (truth missing?)"
        )
    elif BASELINE not in per_profile:
        gate.update(difference=None, passed=False, reason="the rule-engine baseline is missing")
    else:
        interval = bootstrap.interval(
            per_profile[CANDIDATE][gate_metric] - per_profile[BASELINE][gate_metric],
            masked(gate_metric),
        )
        gate.update(
            difference=interval.to_list(),
            passed=bool(interval.low > 0),
            reason="the 95% interval of the paired difference is above zero"
            if interval.low > 0
            else "the 95% interval of the paired difference includes or is below zero",
        )
    return {
        "format": "webflix.recs-evaluation",
        "formatVersion": 1,
        "run": inputs.run_manifest["run"],
        "recipeHash": inputs.run_manifest["recipeHash"],
        "cutoff": iso_ms(cutoff),
        "testWindowEnd": iso_ms(end),
        "datasetId": dataset.dataset_id,
        "profiles": n,
        "eligibleProfiles": len(eligible),
        "slices": {name: int(mask.sum()) for name, mask in slices.items()},
        "availableTitles": int(available.sum()),
        "coldStartTitles": int(cold_titles.sum()),
        "profilesWithColdTitleDiscovery": int(has_cold.sum()),
        "profilesWithSearchDiscovery": int(has_search.sum()),
        "discoveriesPerProfile": round(float((gains > 0).sum(axis=1).mean()), 3) if n else 0.0,
        "bootstrapReplicates": inputs.bootstrap,
        "externalCoverage": external_coverage,
        "results": results,
        "coldStartTitleRecall@20": cold_title_results,
        "differencesVsRuleEngine": differences,
        "ablations": ablations,
        "gate": gate,
        "propensity": inputs.models.propensity.to_dict(),
        "truthUsed": truth is not None,
        "leakCheck": "passed" if not inputs.allow_leak else "bypassed (allow_leak)",
        "seconds": round(time.perf_counter() - started, 2),
        "note": (
            "Simulator results validate the pipeline and the relative ordering of systems "
            "under the simulator's assumptions; they are not evidence of real-world lift."
        ),
    }
