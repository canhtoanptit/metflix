"""`analyse-experiments`: per-experiment analysis from exposure and outcome events.

What a run does, per pre-registered experiment (schemas/experiment-definitions.schema.json):

1. Population. Units are profiles. A unit enters at its first `experiment.exposure` (logged when
   the treatment is experienced, blueprint §8.1) inside [startsAt, analysis end). Units are
   excluded, and counted, when any of their events is flagged `restricted` (kids and capped
   profiles are never in experiment populations), when their latest consent stamp lacks
   `analytics`, when they were exposed to a variant the definition does not name, or when they
   were exposed to more than one variant (an assignment bug must not be averaged away).
2. Pre-registration. The definition fixes the primary metric, alpha, the minimum detectable
   effect (MDE) and the horizon before the start. The analysis refuses an experiment registered
   after it started or with exposures before its registration, and there is no parameter to
   choose another primary metric afterwards.
3. Sample-ratio mismatch: chi-square goodness of fit of the units per variant against the design
   weights, flagged below `srmThreshold` (default 0.001). A flagged experiment's decision is
   `invalid-sample-ratio-mismatch`: the split itself is broken, so no effect is trusted.
4. Metrics per unit over [first exposure, look): `qualified_plays` (playback sessions with at
   least 30 s credited), `watch_hours`, `any_play`, `active_days` (UTC days with a qualified
   play) and `retained` (no billing transition to `canceled`). Per-variant means with normal 95%
   intervals, the difference with a Welch interval and the relative lift with a delta-method
   interval.
5. Peeking protection: a mixture sequential probability ratio test (mSPRT; Johari, Koomen,
   Pekelis, Walsh, "Peeking at A/B tests", KDD 2017) with a normal mixing distribution, evaluated
   at every daily look from the start. It yields an always-valid p-value (the running minimum of
   1/Lambda) and a confidence sequence (the running intersection), so the false-positive rate
   stays below alpha however often anyone looks. That matters here because staff read results
   in the admin console whenever they like: a fixed-horizon test checked daily rejects a true
   null far more often than alpha (tests/test_experiments.py measures by how much).
   The normal mixture gives Lambda in closed form for the asymptotically normal difference of
   means, so its p-value and confidence sequence are exact formulas rather than numerical
   integrals. Mixing scale: tau = MDE x control mean at the look, i.e. the prior puts its mass on
   effects of the size the experiment was registered to detect, which is where mSPRT is most
   powerful. With several treatment variants each comparison uses alpha / (variants - 1).
   The fixed-horizon Welch test is reported too, labelled valid only once the analysis reaches
   the pre-registered `endsAt`; it never drives the decision before that.
6. Power: `msprt_power` (Monte Carlo of the Gaussian path of the estimator at the planned looks)
   and `fixed_horizon_power` (closed form), for sizing and for the calibration tests.
"""

from __future__ import annotations

import functools
import math
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final

import numpy as np
import numpy.typing as npt
import polars as pl
from scipy import stats

from webflix_recs import schemas
from webflix_recs.dataset import event_key_columns
from webflix_recs.ids import DAY_MS, HOUR_MS, iso_ms, parse_iso_ms
from webflix_recs.lake import read_events
from webflix_recs.provenance import code_version

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

METRICS: Final[tuple[str, ...]] = (
    "qualified_plays",
    "watch_hours",
    "any_play",
    "active_days",
    "retained",
)
QUALIFIED_PLAY_SEC: Final = 30.0
DEFAULT_SRM_THRESHOLD: Final = 0.001
Z95: Final = float(stats.norm.ppf(0.975))

FloatArray = npt.NDArray[np.float64]
IntArray = npt.NDArray[np.int64]

EXPOSURE_SCHEMA: Final = {
    "profile": pl.String,
    "account": pl.String,
    "experiment_key": pl.String,
    "variant": pl.String,
    "occurred_at": pl.Int64,
    "restricted": pl.Boolean,
    "analytics": pl.Boolean,
}
OUTCOME_SCHEMA: Final = {
    "profile": pl.String,
    "account": pl.String,
    "type": pl.String,
    "occurred_at": pl.Int64,
    "playback_id": pl.UInt64,
    "watched_sec": pl.Float64,
    "state_to": pl.String,
}


class PreRegistrationError(ValueError):
    """The experiment cannot be analysed as registered (refused, not silently adjusted)."""


# --- Statistics -----------------------------------------------------------------------------


def msprt_log_lambda(difference: FloatArray, variance: FloatArray, tau2: FloatArray) -> FloatArray:
    """log Lambda of the normal-mixture SPRT for H0: difference = 0, with the estimator's
    variance `variance` and mixing variance `tau2` (all broadcastable)."""
    v = np.asarray(variance, dtype=np.float64)
    t = np.asarray(tau2, dtype=np.float64)
    d = np.asarray(difference, dtype=np.float64)
    result: FloatArray = 0.5 * np.log(v / (v + t)) + (d * d * t) / (2.0 * v * (v + t))
    return result


def msprt_half_width(variance: float, tau2: float, alpha: float) -> float:
    """Half width of the (1 - alpha) confidence sequence at one look."""
    return math.sqrt(
        variance
        * (variance + tau2)
        / tau2
        * (2.0 * math.log(1.0 / alpha) + math.log((variance + tau2) / variance))
    )


def msprt_power(
    delta: Sequence[float] | FloatArray,
    cov: Sequence[Sequence[float]] | FloatArray,
    tau: Sequence[float] | FloatArray,
    *,
    alpha: float,
    simulations: int = 4000,
    seed: int = 7,
) -> float:
    """Probability that the mSPRT rejects at some look, when the estimator's path across the
    looks is Gaussian with means `delta` (the true difference at each look) and covariance
    `cov`; `tau` is the mixing scale used at each look. Monte Carlo, deterministic seed.

    For a metric that is a fixed per-unit value with standard deviation sd and n_j units per arm
    at look j, cov[i][j] = 2 sd^2 / max(n_i, n_j); for accumulating metrics derive delta and cov
    from a pilot (tests/test_experiments.py does both)."""
    mean = np.asarray(delta, dtype=np.float64)
    covariance = np.asarray(cov, dtype=np.float64)
    scale = np.asarray(tau, dtype=np.float64)
    jitter = 1e-12 * max(float(np.max(np.diag(covariance))), 1e-300)
    chol = np.linalg.cholesky(covariance + jitter * np.eye(len(mean)))
    rng = np.random.default_rng(seed)
    paths = rng.standard_normal((simulations, len(mean))) @ chol.T + mean
    log_lambda = msprt_log_lambda(paths, np.diag(covariance)[None, :], (scale**2)[None, :])
    return float(np.mean((log_lambda >= math.log(1.0 / alpha)).any(axis=1)))


def fixed_horizon_power(delta: float, variance: float, *, alpha: float) -> float:
    """Power of the two-sided z test of the difference at a single, planned look."""
    z = float(stats.norm.ppf(1 - alpha / 2))
    shift = abs(delta) / math.sqrt(variance)
    return float(stats.norm.cdf(shift - z) + stats.norm.cdf(-shift - z))


def _num(value: float | np.floating[Any] | None) -> float | None:
    if value is None:
        return None
    number = float(value)
    return None if math.isnan(number) or math.isinf(number) else round(number, 6)


# --- Units and per-unit metrics at each look ------------------------------------------------


@dataclass
class UnitData:
    """Arrays the metrics are computed from (one row per unit, one per playback event)."""

    profiles: list[str]
    first: IntArray  # first exposure, ms
    variant: IntArray  # index into the experiment's variants
    event_unit: IntArray
    event_session: IntArray
    event_time: IntArray
    event_watched: FloatArray
    cancel_unit: IntArray
    cancel_time: IntArray

    @property
    def units(self) -> int:
        return len(self.profiles)


def _strings(frame: pl.DataFrame, column: str) -> npt.NDArray[np.object_]:
    values: npt.NDArray[np.object_] = frame[column].to_numpy().astype(object)
    return values


def _present(values: npt.NDArray[np.object_]) -> npt.NDArray[np.bool_]:
    return np.array([value is not None for value in values], dtype=bool)


def _flags(frame: pl.DataFrame, column: str, default: bool) -> npt.NDArray[np.bool_]:
    raw = frame[column].to_numpy()
    if raw.dtype == np.bool_:
        return raw
    return np.array([default if value is None else bool(value) for value in raw], dtype=bool)


@dataclass
class Population:
    profiles: npt.NDArray[np.object_]
    accounts: npt.NDArray[np.object_]
    variant: IntArray
    first: IntArray
    exclusions: dict[str, int]


def population(
    exposures: pl.DataFrame, key: str, start: int, end: int, names: Sequence[str]
) -> Population:
    """Units after exclusions. Each excluded unit is counted once, in the first matching reason:
    restricted, no analytics consent, unknown variant, more than one variant. Plain numpy over
    the exposure rows: an analysis of a few thousand units stays in milliseconds."""
    keys = _strings(exposures, "experiment_key")
    profiles_all = _strings(exposures, "profile")
    mask = (keys == key) & _present(profiles_all)
    profiles = profiles_all[mask]
    when = exposures["occurred_at"].to_numpy()[mask].astype(np.int64)
    variants = _strings(exposures, "variant")[mask]
    accounts = _strings(exposures, "account")[mask]
    restricted_rows = _flags(exposures, "restricted", False)[mask]
    consent_rows = _flags(exposures, "analytics", False)[mask]
    unique, code = np.unique(profiles.astype(str), return_inverse=True)
    n = len(unique)
    variant_index = {name: position for position, name in enumerate(names)}
    variant_code = np.array([variant_index.get(str(v), -1) for v in variants], dtype=np.int64)
    inside = (when >= start) & (when < end)

    def any_by_unit(rows: npt.NDArray[np.bool_]) -> npt.NDArray[np.bool_]:
        result: npt.NDArray[np.bool_] = np.bincount(code[rows], minlength=n) > 0
        return result

    present = any_by_unit(inside)
    early = any_by_unit(when < start)
    restricted = any_by_unit(restricted_rows) & present
    consent = ~any_by_unit(~consent_rows)
    known = ~any_by_unit(inside & (variant_code < 0))
    pairs = np.unique(code[inside] * (len(names) + 1) + (variant_code[inside] + 1))
    distinct = np.bincount(pairs // (len(names) + 1), minlength=n)
    single = distinct == 1
    no_consent = present & ~restricted & ~consent
    unknown = present & ~restricted & consent & ~known
    multiple = present & ~restricted & consent & known & ~single
    kept = present & ~restricted & consent & known & single
    # First exposure inside the window: its time, variant and account.
    order = np.flatnonzero(inside)
    order = order[np.lexsort((when[order], code[order]))]
    _, first_rows = np.unique(code[order], return_index=True)
    first_of = np.full(n, -1, dtype=np.int64)
    first_of[code[order][first_rows]] = order[first_rows]
    chosen = first_of[kept]
    return Population(
        profiles=unique[kept].astype(object),
        accounts=accounts[chosen],
        variant=variant_code[chosen],
        first=when[chosen],
        exclusions={
            "restricted": int(restricted.sum()),
            "noAnalyticsConsent": int(no_consent.sum()),
            "multipleVariants": int(multiple.sum()),
            "unknownVariant": int(unknown.sum()),
            "beforeStart": int((~present & early).sum()),
            "afterEnd": int((~present & ~early).sum()),
        },
    )


def unit_data(units: Population, outcomes: pl.DataFrame) -> UnitData:
    """The outcome rows (OUTCOME_SCHEMA) of the population's units, as arrays."""
    position = {str(profile): index for index, profile in enumerate(units.profiles)}
    kinds = _strings(outcomes, "type")
    profiles = _strings(outcomes, "profile")
    session_ids = outcomes["playback_id"].to_numpy()
    sessions = np.where(outcomes["playback_id"].is_null().to_numpy(), 0, session_ids).astype(
        np.uint64
    )
    has_session = ~outcomes["playback_id"].is_null().to_numpy()
    when = outcomes["occurred_at"].to_numpy().astype(np.int64)
    watched = np.nan_to_num(outcomes["watched_sec"].to_numpy().astype(np.float64), nan=0.0)
    playback_rows = np.flatnonzero(np.isin(kinds, list(schemas.PLAYBACK_TYPES)) & has_session)
    owner = np.array([position.get(str(p), -1) for p in profiles[playback_rows]], dtype=np.int64)
    playback_rows, owner = playback_rows[owner >= 0], owner[owner >= 0]
    if len(playback_rows):
        _, session = np.unique(sessions[playback_rows], return_inverse=True)
    else:
        session = np.zeros(0, dtype=np.int64)
    by_account: dict[str, list[int]] = {}
    for index, account in enumerate(units.accounts):
        if account is not None:
            by_account.setdefault(str(account), []).append(index)
    cancel_rows = np.flatnonzero(
        (kinds == schemas.BILLING_TRANSITION) & (_strings(outcomes, "state_to") == "canceled")
    )
    accounts = _strings(outcomes, "account")
    cancel_unit: list[int] = []
    cancel_time: list[int] = []
    for row in cancel_rows:
        for index in by_account.get(str(accounts[row]), []):
            cancel_unit.append(index)
            cancel_time.append(int(when[row]))
    return UnitData(
        profiles=[str(p) for p in units.profiles],
        first=units.first,
        variant=units.variant,
        event_unit=owner,
        event_session=np.asarray(session, dtype=np.int64),
        event_time=when[playback_rows],
        event_watched=watched[playback_rows],
        cancel_unit=np.array(cancel_unit, dtype=np.int64),
        cancel_time=np.array(cancel_time, dtype=np.int64),
    )


def look_metrics(data: UnitData, looks: IntArray) -> dict[str, FloatArray]:
    """Every metric for every unit at every look: arrays of shape (looks, units), NaN for a unit
    not exposed yet. Only events that happened before a look count at that look."""
    n = data.units
    in_window = data.event_time >= data.first[data.event_unit]
    unit = data.event_unit[in_window]
    session = data.event_session[in_window]
    when = data.event_time[in_window]
    watched = data.event_watched[in_window]
    sessions = int(session.max()) + 1 if len(session) else 0
    session_unit = np.zeros(sessions, dtype=np.int64)
    session_unit[session] = unit
    session_start = np.full(sessions, np.iinfo(np.int64).max, dtype=np.int64)
    np.minimum.at(session_start, session, when)
    session_day = session_start // DAY_MS
    cancelled_window = data.cancel_time >= data.first[data.cancel_unit]
    cancel_unit = data.cancel_unit[cancelled_window]
    cancel_time = data.cancel_time[cancelled_window]
    out = {name: np.full((len(looks), n), np.nan) for name in METRICS}
    for row, look in enumerate(looks):
        before = when < look
        best = np.full(sessions, -1.0)
        np.maximum.at(best, session[before], watched[before])
        seen = best >= 0
        qualified = best >= QUALIFIED_PLAY_SEC
        plays = np.bincount(session_unit[qualified], minlength=n).astype(np.float64)
        hours = np.bincount(session_unit[seen], weights=best[seen], minlength=n) / 3600.0
        if qualified.any():
            pairs = np.unique(session_unit[qualified] * 1_000_000 + session_day[qualified])
            days = np.bincount(pairs // 1_000_000, minlength=n).astype(np.float64)
        else:
            days = np.zeros(n)
        cancelled = np.zeros(n, dtype=bool)
        cancelled[cancel_unit[cancel_time < look]] = True
        entered = data.first < look
        values = {
            "qualified_plays": plays,
            "watch_hours": hours,
            "any_play": (plays > 0).astype(np.float64),
            "active_days": days,
            "retained": (~cancelled).astype(np.float64),
        }
        for name, value in values.items():
            out[name][row] = np.where(entered, value, np.nan)
    return out


def daily_looks(start_ms: int, end_ms: int) -> IntArray:
    """Look instants: every 24 h after the start, and the analysis end."""
    if end_ms <= start_ms:
        return np.zeros(0, dtype=np.int64)
    marks = list(range(start_ms + DAY_MS, end_ms, DAY_MS))
    marks.append(end_ms)
    return np.array(marks, dtype=np.int64)


# --- The analysis -----------------------------------------------------------------------------


@dataclass(frozen=True)
class _Moments:
    n: int
    mean: float
    var: float


def _moments(values: FloatArray, mask: npt.NDArray[np.bool_]) -> _Moments:
    selected = values[mask & ~np.isnan(values)]
    n = len(selected)
    if n == 0:
        return _Moments(0, float("nan"), float("nan"))
    var = float(selected.var(ddof=1)) if n > 1 else float("nan")
    return _Moments(n, float(selected.mean()), var)


def _srm(observed: dict[str, int], weights: dict[str, float], threshold: float) -> dict[str, Any]:
    total = sum(observed.values())
    expected = {name: total * weight for name, weight in weights.items()}
    if total == 0:
        return {
            "chi2": None,
            "pValue": None,
            "threshold": threshold,
            "flagged": False,
            "observed": observed,
            "expected": expected,
        }
    result = stats.chisquare(
        [observed[name] for name in weights], [expected[name] for name in weights]
    )
    p_value = float(result.pvalue)
    return {
        "chi2": _num(float(result.statistic)),
        "pValue": _num(p_value),
        "threshold": threshold,
        "flagged": bool(p_value < threshold),
        "observed": observed,
        "expected": {name: round(value, 3) for name, value in expected.items()},
    }


def analyse_frames(
    exposures: pl.DataFrame,
    outcomes: pl.DataFrame,
    experiment: dict[str, Any],
    *,
    as_of_ms: int,
) -> dict[str, Any]:
    """Analyse one experiment from exposure rows (EXPOSURE_SCHEMA; `restricted` and `analytics`
    describe the unit, not just the row) and outcome rows (OUTCOME_SCHEMA)."""
    names = [variant["name"] for variant in experiment["variants"]]
    total_weight = sum(float(variant["weight"]) for variant in experiment["variants"])
    weights = {
        variant["name"]: float(variant["weight"]) / total_weight
        for variant in experiment["variants"]
    }
    control = str(experiment.get("control", names[0]))
    if control not in names or len(set(names)) != len(names):
        raise PreRegistrationError(
            f"{experiment['key']}: control {control!r} must be one of distinct variants {names}"
        )
    primary = str(experiment["primaryMetric"])
    if primary not in METRICS:
        raise PreRegistrationError(
            f"{experiment['key']}: primary metric {primary!r} is not one of {METRICS}"
        )
    secondary = [m for m in experiment.get("secondaryMetrics", METRICS) if m != primary]
    unknown_metrics = [m for m in secondary if m not in METRICS]
    if unknown_metrics:
        raise PreRegistrationError(f"{experiment['key']}: unknown metrics {unknown_metrics}")
    registered = parse_iso_ms(experiment["registeredAt"])
    start = parse_iso_ms(experiment["startsAt"])
    ends = parse_iso_ms(experiment["endsAt"]) if experiment.get("endsAt") else None
    if registered > start:
        raise PreRegistrationError(
            f"{experiment['key']}: registered at {experiment['registeredAt']}, "
            f"after it started at {experiment['startsAt']}"
        )
    keyed = exposures.filter(pl.col("experiment_key") == experiment["key"])
    if keyed.height and int(keyed["occurred_at"].to_numpy().min()) < registered:
        raise PreRegistrationError(
            f"{experiment['key']}: exposures were logged before the experiment was registered"
        )
    alpha = float(experiment["alpha"])
    mde = float(experiment["minimumDetectableEffect"])
    threshold = float(experiment.get("srmThreshold", DEFAULT_SRM_THRESHOLD))
    end = min(as_of_ms, ends) if ends is not None else as_of_ms
    units = population(exposures, str(experiment["key"]), start, end, names)
    exclusions = units.exclusions
    data = unit_data(units, outcomes)
    looks = daily_looks(start, end)
    metrics = [primary, *secondary]
    values = (
        look_metrics(data, looks)
        if len(looks)
        else {name: np.zeros((0, data.units)) for name in METRICS}
    )
    treatments = [name for name in names if name != control]
    comparison_alpha = alpha / max(len(treatments), 1)
    control_index = names.index(control)
    observed = {name: int((data.variant == position).sum()) for position, name in enumerate(names)}
    srm = _srm(observed, weights, threshold)

    report_metrics: dict[str, Any] = {}
    look_rows: list[dict[str, Any]] = [
        {
            "at": iso_ms(int(look)),
            "units": {
                name: int(((data.variant == position) & (data.first < look)).sum())
                for position, name in enumerate(names)
            },
            "comparisons": [],
        }
        for look in looks
    ]
    significant: list[str] = []
    for metric in metrics:
        series = values[metric]
        final = series[-1] if len(looks) else np.zeros(data.units)
        summaries = {}
        for position, name in enumerate(names):
            moments = _moments(final, data.variant == position)
            half = Z95 * math.sqrt(moments.var / moments.n) if moments.n > 1 else float("nan")
            summaries[name] = {
                "units": moments.n,
                "mean": _num(moments.mean),
                "sd": _num(math.sqrt(moments.var)) if moments.n > 1 else None,
                "ci95": [_num(moments.mean - half), _num(moments.mean + half)],
            }
        comparisons = []
        for treatment in treatments:
            position = names.index(treatment)
            best_log_lambda = 0.0
            low, high = -math.inf, math.inf
            tau = float("nan")
            difference = float("nan")
            variance = float("nan")
            for row in range(len(looks)):
                a = _moments(series[row], data.variant == control_index)
                b = _moments(series[row], data.variant == position)
                if a.n < 2 or b.n < 2:
                    continue
                variance = a.var / a.n + b.var / b.n
                difference = b.mean - a.mean
                tau = mde * abs(a.mean)
                if variance > 0 and tau > 0:
                    log_lambda = float(
                        msprt_log_lambda(
                            np.array(difference), np.array(variance), np.array(tau * tau)
                        )
                    )
                    best_log_lambda = max(best_log_lambda, log_lambda)
                    # The estimand of a cumulative metric grows with the window, so the sequence is
                    # reported at the latest look rather than intersected across looks.
                    half = msprt_half_width(variance, tau * tau, comparison_alpha)
                    low, high = difference - half, difference + half
                if metric == primary:
                    naive = (
                        2 * stats.norm.sf(abs(difference) / math.sqrt(variance))
                        if variance > 0
                        else 1.0
                    )
                    look_rows[row]["comparisons"].append(
                        {
                            "variant": treatment,
                            "difference": _num(difference),
                            "alwaysValidP": float(min(1.0, math.exp(-best_log_lambda))),
                            "naiveP": float(naive),
                        }
                    )
            p_value = float(min(1.0, math.exp(-best_log_lambda)))
            a_final = _moments(final, data.variant == control_index)
            b_final = _moments(final, data.variant == position)
            if a_final.n > 1 and b_final.n > 1 and a_final.mean != 0:
                se_a, se_b = a_final.var / a_final.n, b_final.var / b_final.n
                lift = b_final.mean / a_final.mean - 1.0
                lift_se = math.sqrt(
                    se_b / a_final.mean**2 + b_final.mean**2 * se_a / a_final.mean**4
                )
                welch_se = math.sqrt(se_a + se_b)
                fixed_p = (
                    float(2 * stats.norm.sf(abs(difference) / welch_se)) if welch_se > 0 else 1.0
                )
            else:
                lift, lift_se, welch_se, fixed_p = (
                    float("nan"),
                    float("nan"),
                    float("nan"),
                    float("nan"),
                )
            reached = ends is not None and end >= ends
            is_significant = bool(p_value < comparison_alpha)
            if metric == primary and is_significant:
                significant.append(treatment)
            comparisons.append(
                {
                    "variant": treatment,
                    "difference": _num(difference),
                    "ci95": [_num(difference - Z95 * welch_se), _num(difference + Z95 * welch_se)],
                    "relativeLift": _num(lift),
                    "relativeLiftCi95": [_num(lift - Z95 * lift_se), _num(lift + Z95 * lift_se)],
                    "sequential": {
                        "method": "msprt-normal-mixture",
                        "tau": _num(tau),
                        "alpha": comparison_alpha,
                        "alwaysValidP": p_value,
                        "confidenceSequence": [_num(low), _num(high)],
                        "significant": is_significant,
                    },
                    "fixedHorizon": {
                        "test": "welch-normal",
                        "pValue": _num(fixed_p),
                        "valid": reached,
                        "note": (
                            "valid: the analysis reached the pre-registered horizon"
                            if reached
                            else "not valid for decisions: the registered horizon is not reached"
                            if ends is not None
                            else "not valid for decisions: no horizon was pre-registered"
                        ),
                    },
                }
            )
        report_metrics[metric] = {
            "primary": metric == primary,
            "variants": summaries,
            "comparisons": comparisons,
        }

    decision: dict[str, Any]
    if data.units == 0:
        decision = {"status": "no-units", "metric": primary, "basis": "no eligible exposed units"}
    elif srm["flagged"]:
        decision = {
            "status": "invalid-sample-ratio-mismatch",
            "metric": primary,
            "basis": f"sample-ratio mismatch p = {srm['pValue']} < {threshold}: "
            "the split is broken, no effect is trusted",
        }
    elif significant:
        decision = {
            "status": "significant",
            "metric": primary,
            "basis": f"mSPRT always-valid p < {comparison_alpha:g} on the pre-registered primary",
            "significantVariants": significant,
        }
    else:
        decision = {
            "status": "not-significant",
            "metric": primary,
            "basis": f"mSPRT always-valid p >= {comparison_alpha:g} at every look so far",
        }
    return {
        "key": experiment["key"],
        "unit": "profile",
        "control": control,
        "variants": [{"name": name, "weight": round(weights[name], 6)} for name in names],
        "registeredAt": experiment["registeredAt"],
        "startsAt": experiment["startsAt"],
        "endsAt": experiment.get("endsAt"),
        "analysisEnd": iso_ms(end),
        "primaryMetric": primary,
        "alpha": alpha,
        "minimumDetectableEffect": mde,
        "units": observed,
        "exclusions": exclusions,
        "srm": srm,
        "metrics": report_metrics,
        "looks": look_rows,
        "decision": decision,
        "methods": {
            "unit": "profile; first experiment.exposure inside [startsAt, analysis end)",
            "window": "per unit, events in [first exposure, look); a session counts at a look "
            "with the watching credited before it",
            "sequential": "mSPRT, normal mixture N(0, tau^2), tau = MDE x control mean at "
            "each look; always-valid p = running min of 1/Lambda over daily looks; confidence "
            "sequence at the latest look (not intersected: per-unit metrics accumulate over the "
            "window, so the estimand moves)",
            "multipleVariants": "each treatment against the control at alpha / treatments",
            "fixedHorizon": "Welch (normal approximation); valid only at the registered horizon",
            "srm": f"chi-square goodness of fit to the design weights, flagged below {threshold:g}",
            "exclusions": "restricted (any restricted event), no analytics consent (latest "
            "stamp), unknown variant, "
            "more than one variant",
        },
    }


# --- Reading the lake -------------------------------------------------------------------------


_STATE_SCHEMA: Final = {
    "profile": pl.String,
    "account": pl.String,
    "latest_received": pl.Int64,
    "any_restricted": pl.Boolean,
}
_CONSENT_SCHEMA: Final = {
    "account": pl.String,
    "latest_received": pl.Int64,
    "latest_analytics": pl.Boolean,
}
_ENVELOPE: Final = {
    "eid_hi": pl.UInt64,
    "eid_lo": pl.UInt64,
    "received_at": pl.Int64,
    "profile": pl.String,
}
_SLIM_EXPOSURES: Final = {
    **_ENVELOPE,
    "account": pl.String,
    "experiment_key": pl.String,
    "variant": pl.String,
    "occurred_at": pl.Int64,
}
_SLIM_PLAYBACK: Final = {
    **_ENVELOPE,
    "type": pl.String,
    "occurred_at": pl.Int64,
    "playback_id": pl.UInt64,
    "watched_sec": pl.Float64,
}
_SLIM_BILLING: Final = {
    **_ENVELOPE,
    "account": pl.String,
    "type": pl.String,
    "occurred_at": pl.Int64,
    "state_to": pl.String,
}


def _slim(frame: pl.DataFrame, as_of_ms: int | None) -> dict[str, pl.DataFrame]:
    """Runs in the reader processes: keep what the analysis needs."""
    if as_of_ms is not None:
        frame = frame.filter(pl.col("received_at") < as_of_ms)
    state = (
        frame.filter(pl.col("profile").is_not_null())
        .sort("received_at")
        .group_by("profile")
        .agg(
            pl.col("account").last(),
            pl.col("received_at").max().alias("latest_received"),
            pl.col("restricted").fill_null(False).any().alias("any_restricted"),
        )
    )
    # Consent is the account's: the latest stamp on any of its events, consent.change included
    # (a withdrawal is honoured even when the member never comes back).
    consent = (
        frame.filter(pl.col("account").is_not_null())
        .sort("received_at")
        .group_by("account")
        .agg(
            pl.col("received_at").max().alias("latest_received"),
            pl.col("consent_analytics").last().alias("latest_analytics"),
        )
    )
    # Compact types where the events arrive (exact 64-bit event keys, hashed playback session
    # ids, no account on playback rows), so the full-size lake fits in memory comfortably.
    frame = frame.with_columns(*event_key_columns())
    exposures = frame.filter(
        (pl.col("type") == schemas.EXPOSURE) & (pl.col("unit_type") == "profile")
    ).select(list(_SLIM_EXPOSURES))
    playback = (
        frame.filter(
            pl.col("type").is_in(list(schemas.PLAYBACK_TYPES)) & pl.col("profile").is_not_null()
        )
        .with_columns(pl.col("playback_id").hash())
        .select(list(_SLIM_PLAYBACK))
    )
    billing = frame.filter(pl.col("type") == schemas.BILLING_TRANSITION).select(list(_SLIM_BILLING))
    return {
        "state": state,
        "consent": consent,
        "exposures": exposures,
        "playback": playback,
        "billing": billing,
    }


def _dedup(frame: pl.DataFrame) -> pl.DataFrame:
    return frame.sort(["received_at", "eid_hi", "eid_lo"]).unique(
        subset=["eid_hi", "eid_lo"], keep="first", maintain_order=True
    )


def run_analysis(
    location: str,
    definitions: dict[str, Any],
    *,
    as_of_ms: int | None = None,
    workers: int = 1,
    log: Callable[[str], object] = print,
) -> dict[str, Any]:
    """Analyse every experiment in `definitions` from the lake at `location`.

    `as_of_ms` is the knowledge cutoff (events received before it); by default, everything in
    the lake. Raises `PreRegistrationError` for an experiment that cannot be analysed as
    registered, and `schemas.SchemaError` for invalid definitions."""
    schemas.validate("experiment-definitions", definitions)
    started = time.perf_counter()
    until = None if as_of_ms is None else as_of_ms + HOUR_MS
    results, read_stats, hours = read_events(
        location,
        until_ms=until,
        workers=workers,
        transform=functools.partial(_slim, as_of_ms=as_of_ms),
    )
    parts: dict[str, list[pl.DataFrame]] = {
        "state": [],
        "consent": [],
        "exposures": [],
        "playback": [],
        "billing": [],
    }
    for result in results:
        for name, frame in result.items():
            parts[name].append(frame)
    empty = {
        "state": pl.DataFrame(schema=_STATE_SCHEMA),
        "consent": pl.DataFrame(schema=_CONSENT_SCHEMA),
        "exposures": pl.DataFrame(schema=_SLIM_EXPOSURES),
        "playback": pl.DataFrame(schema=_SLIM_PLAYBACK),
        "billing": pl.DataFrame(schema=_SLIM_BILLING),
    }
    frames = {
        name: pl.concat(items, how="vertical") if items else empty[name]
        for name, items in parts.items()
    }
    consent = (
        frames["consent"]
        .sort("latest_received")
        .group_by("account")
        .agg(pl.col("latest_analytics").last().fill_null(False).alias("analytics"))
    )
    state = (
        frames["state"]
        .sort("latest_received")
        .group_by("profile")
        .agg(
            pl.col("account").last(),
            pl.col("latest_received").max(),
            pl.col("any_restricted").any().alias("restricted"),
        )
        .join(consent, on="account", how="left")
        .with_columns(pl.col("analytics").fill_null(False))
    )
    exposures = (
        _dedup(frames["exposures"])
        .join(state.select("profile", "restricted", "analytics"), on="profile", how="left")
        .select(list(EXPOSURE_SCHEMA))
    )
    outcomes = pl.concat(
        [
            _dedup(frames["playback"]).with_columns(
                pl.lit(None, dtype=pl.String).alias("account"),
                pl.lit(None, dtype=pl.String).alias("state_to"),
            ),
            _dedup(frames["billing"]).with_columns(
                pl.lit(None, dtype=pl.UInt64).alias("playback_id"),
                pl.lit(None, dtype=pl.Float64).alias("watched_sec"),
            ),
        ],
        how="diagonal",
    ).select(list(OUTCOME_SCHEMA))
    if as_of_ms is None:
        candidates = [
            int(
                frame["received_at" if "received_at" in frame.columns else "latest_received"]
                .to_numpy()
                .max()
            )
            for frame in (state, frames["billing"], frames["exposures"])
            if frame.height
        ]
        as_of_ms = (max(candidates) + 1) if candidates else int(time.time() * 1000)
    experiments = [
        analyse_frames(exposures, outcomes, experiment, as_of_ms=as_of_ms)
        for experiment in definitions["experiments"]
    ]
    for experiment in experiments:
        log(
            f"experiment {experiment['key']}: {experiment['units']} units, "
            f"decision {experiment['decision']['status']}"
        )
    report = {
        "format": "webflix.experiment-report",
        "formatVersion": 1,
        "generatedAt": iso_ms(int(time.time() * 1000)),
        "asOf": iso_ms(as_of_ms),
        "code": code_version(),
        "read": {
            **read_stats.to_dict(),
            "hours": hours,
            "seconds": round(time.perf_counter() - started, 2),
        },
        "experiments": experiments,
    }
    schemas.validate("experiment-report", report)
    return report
