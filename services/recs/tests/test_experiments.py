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


# --- The product's definitions, device units, results for the importer -----------------------


def _product_definition(**overrides: Any) -> dict[str, Any]:
    """An `ExperimentDefinition` as `GET /api/admin/v1/experiments` answers it."""
    design = SyntheticDesign(key="recs-e2e", units=300, days=7, entry_days=3.0, effect=0.1)
    definition: dict[str, Any] = {
        "key": design.key,
        "name": "Learned vs rules",
        "description": None,
        "unit": "profile",
        "layer": "recs",
        "allocation": {"start": 0, "end": 10_000},
        "targeting": {"percentage": 100, "plans": [], "countries": [], "audience": "all"},
        "variants": [{"name": "control", "weight": 1}, {"name": "treatment", "weight": 1}],
        "control": "control",
        "primaryMetric": "qualified_plays",
        "secondaryMetrics": ["watch_hours"],
        "alpha": 0.05,
        "power": None,
        "minimumDetectableEffect": 0.1,
        # Staff set the start in the past, then pressed start: registered after `startsAt`.
        "startsAt": "2026-08-25T00:00:00.000Z",
        "endsAt": "2026-09-08T00:00:00.000Z",
        "srmThreshold": None,
        "status": "running",
        "salt": "0123456789abcdef",
        "registeredAt": design.start,
        "createdAt": "2026-08-20T00:00:00.000Z",
        "updatedAt": "2026-08-20T00:00:00.000Z",
    }
    definition.update(overrides)
    return definition


def _lake(tmp_path: Path) -> tuple[str, SyntheticDesign]:
    design = SyntheticDesign(key="recs-e2e", units=300, days=7, entry_days=3.0, effect=0.1)
    experiment = generate(design, 9)
    store = tmp_path / "store"
    write_lake(LocalStorage(store), to_events(experiment, 9))
    return str(store), design


def test_the_products_definitions_are_analysed_as_the_product_assigns(tmp_path: Path) -> None:
    from webflix_recs.experiments.definitions import normalise_definitions

    location, design = _lake(tmp_path)
    answer = {
        "items": [
            _product_definition(),
            _product_definition(key="draft-one", status="draft", registeredAt=None),
            _product_definition(key="old-one", status="archived"),
        ]
    }
    normalised, skipped = normalise_definitions(answer)
    (mapped,) = normalised["experiments"]
    # Nothing is assigned before registration: the window starts there.
    assert mapped["startsAt"] == mapped["registeredAt"] == design.start
    assert mapped["layer"] == "recs" and mapped["unit"] == "profile"
    assert "power" not in mapped and "srmThreshold" not in mapped
    assert {s["key"] for s in skipped} == {"draft-one", "old-one"}
    report = run_analysis(location, answer, as_of_ms=design.end_ms, log=lambda _: None)
    schemas.validate("experiment-report", report)
    (analysed,) = report["experiments"]
    assert analysed["unit"] == "profile" and analysed["layer"] == "recs"
    assert sum(analysed["units"].values()) == 300
    assert analysed["diagnostics"]["layerOverlapUnits"] == 0
    assert analysed["diagnostics"]["exposureEvents"] > 300
    assert [s["key"] for s in report["definitionsSkipped"]] == ["draft-one", "old-one"]


def test_units_in_two_experiments_of_one_layer_are_reported(tmp_path: Path) -> None:
    location, design = _lake(tmp_path)
    storage = LocalStorage(location)
    # A second experiment in the same layer, overlapping in time, sharing 25 units: an
    # allocation the product refuses for running experiments, so it signals a bug.
    events = [
        e
        for e in to_events(generate(replace(design, units=25), 9), 9)
        if e["type"] == schemas.EXPOSURE
    ]
    for event in events:
        event["payload"]["experimentKey"] = "recs-other"
    write_lake(storage, events, seed=1)
    answer = {"items": [_product_definition(), _product_definition(key="recs-other")]}
    report = run_analysis(location, answer, as_of_ms=design.end_ms, log=lambda _: None)
    overlap = {e["key"]: e["diagnostics"]["layerOverlapUnits"] for e in report["experiments"]}
    assert overlap == {"recs-e2e": 25, "recs-other": 25}


def test_results_are_written_where_the_importer_reads_them(tmp_path: Path) -> None:
    from webflix_recs.experiments.results import (
        RESULTS_POINTER,
        read_results,
        write_results,
    )
    from webflix_recs.storage import get_json

    location, design = _lake(tmp_path)
    storage = LocalStorage(location)
    report = run_analysis(
        location, {"items": [_product_definition()]}, as_of_ms=design.end_ms, log=lambda _: None
    )
    pointer = write_results(storage, report)
    schemas.validate("experiment-results-pointer", pointer)
    assert get_json(storage, RESULTS_POINTER) == pointer
    (document,) = read_results(storage)
    # What saveExperimentResults(key, report, Date.parse(computedAt)) stores, and
    # GET /experiments/:key/results answers.
    assert document["key"] == "recs-e2e"
    assert document["computedAt"] == report["generatedAt"]
    assert document["report"] == report["experiments"][0]
    (entry,) = pointer["results"]
    assert entry["path"] == f"experiments/results/r={pointer['run']}/recs-e2e.json"
    assert entry["decision"] == report["experiments"][0]["decision"]["status"]
    # A later run names its predecessor; a tampered file is refused by a reader.
    later = dict(report, generatedAt="2099-01-01T00:00:00.000Z")
    second = write_results(storage, later)
    assert second["previous"] == pointer["run"]
    storage.put(second["results"][0]["path"], b"{}")
    with pytest.raises(ValueError, match=r"size|SHA-256"):
        read_results(storage)


def test_device_units_take_the_outcomes_of_the_profiles_signed_in_there(tmp_path: Path) -> None:
    from helpers import make_event

    start = SyntheticDesign().start_ms
    events: list[dict[str, Any]] = []
    for i in range(40):
        variant = "control" if i % 2 == 0 else "treatment"
        device, account, profile = f"dev-{i:03d}", f"a{i:021d}", f"p{i:021d}"
        exposure = make_event(
            schemas.EXPOSURE,
            start + i * 60_000,
            account="x" * 22,
            profile=None,
            experimentKey="landing",
            variant=variant,
            unitType="device",
        )
        exposure["deviceId"] = device
        exposure["subject"]["account"] = None  # signed out: the device's own consent stamp
        schemas.validate_event(exposure)
        events.append(exposure)
        # Later the member signs in on that device and browses: the link device -> profile.
        events.append(
            make_event(
                "title.open", start + DAY_MS + i, account=account, profile=profile, device=device
            )
        )
        plays = 1 if variant == "control" else 3
        for n in range(plays):
            events.append(
                make_event(
                    schemas.PLAYBACK_START,
                    start + 2 * DAY_MS + i * 1000 + n,
                    account=account,
                    profile=profile,
                    playback=f"pb-{i}-{n}",
                    watched=0.0,
                )
            )
            events.append(
                make_event(
                    schemas.PLAYBACK_PROGRESS,
                    start + 2 * DAY_MS + i * 1000 + n + 600_000,
                    account=account,
                    profile=profile,
                    playback=f"pb-{i}-{n}",
                    watched=600.0,
                )
            )
    store = tmp_path / "store"
    write_lake(LocalStorage(store), events)
    definitions = {
        "format": "webflix.experiment-definitions",
        "formatVersion": 1,
        "experiments": [
            {
                "key": "landing",
                "variants": [{"name": "control", "weight": 1}, {"name": "treatment", "weight": 1}],
                "unit": "device",
                "primaryMetric": "qualified_plays",
                "alpha": 0.05,
                "minimumDetectableEffect": 0.1,
                "registeredAt": SyntheticDesign().start,
                "startsAt": SyntheticDesign().start,
                "endsAt": None,
            }
        ],
    }
    report = run_analysis(str(store), definitions, as_of_ms=start + 5 * DAY_MS, log=lambda _: None)
    (analysed,) = report["experiments"]
    assert analysed["unit"] == "device"
    assert analysed["units"] == {"control": 20, "treatment": 20}
    means = analysed["metrics"]["qualified_plays"]["variants"]
    assert means["control"]["mean"] == 1.0 and means["treatment"]["mean"] == 3.0
    assert analysed["diagnostics"]["deviceProfileLinks"] == 40
