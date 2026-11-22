"""analyse-experiments: calibration under peeking, power, SRM, exclusions, and the lake path.

The calibration tests run hundreds of independent synthetic experiments (staggered entry,
zero-inflated heavy-tailed play counts, samples under 30 s, churn) through `analyse_frames`,
the same function the command runs on the lake.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import TYPE_CHECKING, Any

import numpy as np
import polars as pl
import pytest

from webflix_recs import schemas
from webflix_recs.experiments.analysis import (
    EXPOSURE_SCHEMA,
    OUTCOME_SCHEMA,
    PreRegistrationError,
    analyse_frames,
    daily_looks,
    fixed_horizon_power,
    look_metrics,
    msprt_power,
    population,
    run_analysis,
    unit_data,
)
from webflix_recs.experiments.synthetic import SyntheticDesign, generate, to_events, write_lake
from webflix_recs.ids import DAY_MS, HOUR_MS
from webflix_recs.storage import LocalStorage

if TYPE_CHECKING:
    from pathlib import Path

ALPHA = 0.05


def _primary(report: dict[str, Any]) -> dict[str, Any]:
    comparisons: list[dict[str, Any]] = report["metrics"][report["primaryMetric"]]["comparisons"]
    return comparisons[0]


def _analyse(design: SyntheticDesign, seed: int) -> dict[str, Any]:
    experiment = generate(design, seed)
    return analyse_frames(
        experiment.exposures, experiment.outcomes, design.definition(), as_of_ms=design.end_ms
    )


def planned_power(design: SyntheticDesign, alpha: float) -> tuple[float, float]:
    """mSPRT power (and fixed-horizon power) of `design` at its daily looks, from the
    generator's known structure and a large pilot draw (independent of the tested runs).

    The planted effect multiplies the play rate, so the true difference at look j is
    effect x control mean_j; per-unit covariances across looks come from the pilot; the
    estimator's covariance is cov(i, j) = sum over arms of c_arm(i, j) / n_j for i <= j, with n_j
    the expected units per arm entered by look j.
    """
    pilot = replace(design, units=160_000)
    drawn = generate(pilot, 424_242)
    names = [name for name, _ in design.variants]
    data = unit_data(
        population(drawn.exposures, design.key, design.start_ms, design.end_ms, names),
        drawn.outcomes,
    )
    looks = daily_looks(design.start_ms, design.end_ms)
    values = look_metrics(data, looks)[design.primary_metric]
    entered = data.first[None, :] < looks[:, None]
    count = len(looks)
    control_mean = np.array(
        [values[j, entered[j] & (data.variant == 0)].mean() for j in range(count)]
    )
    delta = design.effect * control_mean
    per_arm = design.units * 0.5 * entered.mean(axis=1)
    cov = np.zeros((count, count))
    for i in range(count):
        for j in range(i, count):
            total = 0.0
            for arm in (0, 1):
                units = entered[i] & (data.variant == arm)
                total += float(np.cov(values[i, units], values[j, units])[0, 1])
            cov[i, j] = cov[j, i] = total / per_arm[j]
    power = msprt_power(
        delta, cov, design.mde * control_mean, alpha=alpha, simulations=20_000, seed=3
    )
    return power, fixed_horizon_power(float(delta[-1]), float(cov[-1, -1]), alpha=alpha)


def test_aa_is_flat_under_daily_peeking_and_naive_peeking_is_not() -> None:
    design = SyntheticDesign(key="recs-aa", units=2000)
    seeds = 300
    sequential = 0
    naive = 0
    for seed in range(seeds):
        report = _analyse(design, seed)
        assert len(report["looks"]) == design.days
        sequential += bool(_primary(report)["sequential"]["significant"])
        naive += any(look["comparisons"][0]["naiveP"] < ALPHA for look in report["looks"])
    margin = 3 * math.sqrt(ALPHA * (1 - ALPHA) / seeds)
    print(
        f"A/A over {seeds} seeds, 14 daily looks: "
        f"mSPRT {sequential / seeds:.3f}, naive {naive / seeds:.3f}"
    )
    assert sequential / seeds <= ALPHA + margin
    # Reading a fixed-horizon test at every look is what the protection exists for.
    assert naive / seeds > ALPHA + margin


def test_planted_effect_is_detected_at_the_computed_power() -> None:
    design = SyntheticDesign(key="recs-lift", units=5000, effect=0.20, mde=0.20)
    power, fixed = planned_power(design, ALPHA)
    assert 0.3 < power < 0.95, power
    seeds = 200
    detected = sum(
        bool(_primary(_analyse(design, 10_000 + seed))["sequential"]["significant"])
        for seed in range(seeds)
    )
    rate = detected / seeds
    tolerance = 3 * math.sqrt(power * (1 - power) / seeds) + 0.03
    print(
        f"planted +20%: detected {rate:.3f}, computed mSPRT power {power:.3f} "
        f"(fixed horizon {fixed:.3f})"
    )
    assert abs(rate - power) <= tolerance


def test_sample_ratio_mismatch_is_flagged_and_invalidates_the_decision() -> None:
    balanced = SyntheticDesign(key="recs-srm", units=12_000, days=7, entry_days=3.0)
    report = _analyse(balanced, 7)
    assert report["srm"]["flagged"] is False
    assert report["decision"]["status"] != "invalid-sample-ratio-mismatch"
    broken = _analyse(replace(balanced, drop_treatment_exposures=0.08), 7)
    assert broken["srm"]["flagged"] is True
    assert broken["srm"]["pValue"] < 0.001
    assert broken["decision"]["status"] == "invalid-sample-ratio-mismatch"


def _definition(**overrides: Any) -> dict[str, Any]:
    definition = SyntheticDesign(key="recs-x", days=7).definition()
    definition.update(overrides)
    return definition


def test_restricted_unconsented_and_double_exposed_units_are_never_counted() -> None:
    design = SyntheticDesign(key="recs-x", days=7)
    start = design.start_ms
    units = {
        "p000000000000000000ok1": ("control", False, True),
        "p000000000000000000ok2": ("treatment", False, True),
        "p00000000000000000kids": ("treatment", True, True),
        "p000000000000000nocons": ("control", False, False),
        "p00000000000000000both": ("control", False, True),
        "p000000000000000unknwn": ("other", False, True),
    }
    rows = [
        (profile, f"a{profile[1:]}", "recs-x", variant, start + HOUR_MS, restricted, analytics)
        for profile, (variant, restricted, analytics) in units.items()
    ]
    rows.append(
        (
            "p00000000000000000both",
            "a00000000000000000both",
            "recs-x",
            "treatment",
            start + 2 * HOUR_MS,
            False,
            True,
        )
    )
    rows.append(
        (
            "p0000000000000000early",
            "a0000000000000000early",
            "recs-x",
            "control",
            start - HOUR_MS,
            False,
            True,
        )
    )
    rows.append(
        (
            "p00000000000000000late",
            "a00000000000000000late",
            "recs-x",
            "control",
            start + 30 * DAY_MS,
            False,
            True,
        )
    )
    exposures = pl.DataFrame(rows, schema=EXPOSURE_SCHEMA, orient="row")
    plays = [
        (
            profile,
            f"a{profile[1:]}",
            schemas.PLAYBACK_ABANDON,
            start + 3 * HOUR_MS,
            index,
            600.0,
            None,
        )
        for index, profile in enumerate(units)
    ]
    outcomes = pl.DataFrame(plays, schema=OUTCOME_SCHEMA, orient="row")
    report = analyse_frames(
        exposures, outcomes, design.definition() | {"key": "recs-x"}, as_of_ms=start + 7 * DAY_MS
    )
    assert report["exclusions"] == {
        "restricted": 1,
        "noAnalyticsConsent": 1,
        "multipleVariants": 1,
        "unknownVariant": 1,
        "beforeStart": 1,
        "afterEnd": 1,
    }
    assert report["units"] == {"control": 1, "treatment": 1}
    plays_metric = report["metrics"]["qualified_plays"]["variants"]
    assert plays_metric["control"]["mean"] == 1.0
    assert plays_metric["treatment"]["mean"] == 1.0


def test_pre_registration_is_enforced() -> None:
    experiment = generate(SyntheticDesign(key="recs-x", units=200, days=7), 1)
    end = SyntheticDesign(days=7).end_ms
    late = _definition(registeredAt="2026-09-02T00:00:00.000Z")
    with pytest.raises(PreRegistrationError, match="after it started"):
        analyse_frames(experiment.exposures, experiment.outcomes, late, as_of_ms=end)
    early_exposure = (
        experiment.exposures.with_columns(pl.col("occurred_at").min().alias("first"))
        .with_columns(
            pl.when(pl.col("occurred_at") == pl.col("first"))
            .then(pl.col("occurred_at") - 5 * DAY_MS)
            .otherwise(pl.col("occurred_at"))
            .alias("occurred_at")
        )
        .drop("first")
    )
    with pytest.raises(PreRegistrationError, match="before the experiment was registered"):
        analyse_frames(early_exposure, experiment.outcomes, _definition(), as_of_ms=end)
    with pytest.raises(PreRegistrationError, match="primary metric"):
        analyse_frames(
            experiment.exposures,
            experiment.outcomes,
            _definition(primaryMetric="revenue"),
            as_of_ms=end,
        )
    bad = {
        "format": "webflix.experiment-definitions",
        "formatVersion": 1,
        "experiments": [_definition(primaryMetric="revenue")],
    }
    with pytest.raises(schemas.SchemaError):
        schemas.validate("experiment-definitions", bad)


def test_fixed_horizon_test_is_labelled_invalid_before_the_horizon() -> None:
    design = SyntheticDesign(key="recs-x", units=600, days=7)
    experiment = generate(design, 2)
    midway = analyse_frames(
        experiment.exposures,
        experiment.outcomes,
        design.definition(),
        as_of_ms=design.start_ms + 3 * DAY_MS,
    )
    assert _primary(midway)["fixedHorizon"]["valid"] is False
    assert len(midway["looks"]) == 3
    done = analyse_frames(
        experiment.exposures, experiment.outcomes, design.definition(), as_of_ms=design.end_ms
    )
    assert _primary(done)["fixedHorizon"]["valid"] is True


def test_power_functions_agree_in_the_simple_case() -> None:
    # One look, known variance: the mSPRT is the fixed-horizon test with a different threshold,
    # and its power is lower; with a huge effect both are ~1, with none both are ~alpha or less.
    assert fixed_horizon_power(0.0, 1.0, alpha=ALPHA) == pytest.approx(ALPHA)
    assert msprt_power([0.0], [[1.0]], [1.0], alpha=ALPHA) < ALPHA
    assert msprt_power([10.0], [[1.0]], [1.0], alpha=ALPHA) == pytest.approx(1.0)
    medium = msprt_power([2.8], [[1.0]], [2.8], alpha=ALPHA)
    assert medium < fixed_horizon_power(2.8, 1.0, alpha=ALPHA)


def test_end_to_end_through_the_lake(tmp_path: Path) -> None:
    design = SyntheticDesign(key="recs-e2e", units=400, days=7, entry_days=3.0, effect=0.1)
    experiment = generate(design, 5)
    events = to_events(experiment, 5)
    profiles = sorted(experiment.variant_of)
    restricted, unconsented = profiles[0], profiles[1]
    for event in events:
        if event["subject"]["profile"] == restricted:
            event["subject"]["restricted"] = True
        if event["subject"]["profile"] == unconsented:
            event["subject"]["consent"]["analytics"] = False
        schemas.validate_event(event)
    # At-least-once delivery: some events arrive twice.
    events.extend(events[: len(events) // 10])
    store = tmp_path / "store"
    assert write_lake(LocalStorage(store), events) > 0
    report = run_analysis(
        str(store), design.definitions(), as_of_ms=design.end_ms + HOUR_MS, log=lambda _: None
    )
    schemas.validate("experiment-report", report)
    (analysed,) = report["experiments"]
    assert analysed["exclusions"]["restricted"] == 1
    assert analysed["exclusions"]["noAnalyticsConsent"] == 1
    # The same experiment analysed from the generator's frames, with those two units excluded
    # the same way, gives identical results: reading, validation and deduplication lose nothing
    # and count nothing twice.
    exposures = experiment.exposures.with_columns(
        (pl.col("profile") == restricted).alias("restricted"),
        (pl.col("profile") != unconsented).alias("analytics"),
    )
    direct = analyse_frames(
        exposures, experiment.outcomes, design.definition(), as_of_ms=design.end_ms
    )
    assert analysed["units"] == direct["units"]
    assert analysed["metrics"] == direct["metrics"]
    assert analysed["srm"] == direct["srm"]
    assert analysed["decision"] == direct["decision"]
