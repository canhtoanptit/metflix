"""The publish gate: a run is published only if the decision that belongs to it passed, at every
rolling cutoff, as the evaluations stand when it is published (gate.py)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from helpers import write_version
from webflix_recs import artefacts, cli, gate
from webflix_recs.evaluation import metrics as m
from webflix_recs.evaluation.harness import gate_verdict
from webflix_recs.ids import DAY_MS, iso_ms, parse_iso_ms
from webflix_recs.storage import LocalStorage, get_json, put_json
from webflix_recs.train import run_id_for

RECIPE = "0123456789abcdef"  # write_version's recipe
AS_OF = parse_iso_ms("2026-10-01T00:00:00.000Z")  # write_version's asOf
RUN = run_id_for(AS_OF, RECIPE)


def _evaluation(cutoff_ms: int, difference: list[float], passed: bool) -> dict[str, Any]:
    return {
        "format": "webflix.recs-evaluation",
        "run": run_id_for(cutoff_ms, RECIPE),
        "recipeHash": RECIPE,
        "cutoff": iso_ms(cutoff_ms),
        "profiles": 245,
        "gate": {
            "metric": "utility@10",
            "candidate": "learned",
            "baseline": "rule-engine",
            "difference": difference,
            "passed": passed,
        },
    }


def _store_evaluation(storage: LocalStorage, report: dict[str, Any]) -> None:
    put_json(storage, gate.evaluation_key(RECIPE, report["run"]), report)


def _scored(storage: LocalStorage, count: int) -> dict[str, Any]:
    """A complete, valid version of RUN whose manifest carries the decision scoring records."""
    manifest = write_version(storage, RUN, {"p" * 22: ["t-1"]}, publish=False)
    decision = gate.decide(storage, run=RUN, recipe=RECIPE, as_of_ms=AS_OF, count=count)
    manifest["evaluation"] = gate.manifest_evaluation(decision)
    put_json(storage, f"recs/v={RUN}/manifest.json", manifest)
    return decision


def _publish(store: Path) -> int:
    try:
        cli.main(["--store", str(store), "publish", "--run", RUN])
    except SystemExit as stop:
        return int(stop.code or 0)
    return 0


@pytest.mark.parametrize("count", [1, 3])
def test_an_earlier_pass_never_carries_a_later_failure(tmp_path: Path, count: int) -> None:
    """The reviewer's runs/gate-demo: the run's own backtest (T - 7 d) failed, -0.164; a passing
    evaluation of the same recipe a week older was planted. Publish succeeded on the older pass
    before the gate was tied to the run; it must be refused."""
    storage = LocalStorage(tmp_path)
    _store_evaluation(
        storage, _evaluation(AS_OF - 7 * DAY_MS, [-0.16446, -0.21717, -0.11634], False)
    )
    _store_evaluation(storage, _evaluation(AS_OF - 14 * DAY_MS, [0.01, 0.002, 0.02], True))
    decision = _scored(storage, count)
    assert decision["passed"] is False
    assert decision["cutoffs"][0]["cutoff"] == iso_ms(AS_OF - 7 * DAY_MS)
    assert decision["cutoffs"][0]["passed"] is False
    with pytest.raises(artefacts.PublishRefused, match="did not all beat the rule engine"):
        artefacts.publish(storage, RUN, log=lambda _: None)
    assert _publish(tmp_path) == cli.EXIT_PUBLISH_REFUSED
    assert get_json(storage, artefacts.POINTER_KEY) is None


def test_every_rolling_cutoff_must_pass(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    for weeks, passed in ((1, True), (2, True), (3, False)):
        difference = [0.02, 0.01, 0.03] if passed else [0.008, -0.001, 0.016]
        _store_evaluation(storage, _evaluation(AS_OF - 7 * weeks * DAY_MS, difference, passed))
    decision = _scored(storage, 3)
    assert [entry["passed"] for entry in decision["cutoffs"]] == [True, True, False]
    assert _publish(tmp_path) == cli.EXIT_PUBLISH_REFUSED
    # Two cutoffs required: both passed, so the run is published.
    _scored(storage, 2)
    assert _publish(tmp_path) == 0
    pointer = get_json(storage, artefacts.POINTER_KEY) or {}
    assert pointer["run"] == RUN and pointer["gate"]["passed"] is True
    assert [entry["cutoff"] for entry in pointer["gate"]["cutoffs"]] == [
        iso_ms(AS_OF - 7 * DAY_MS),
        iso_ms(AS_OF - 14 * DAY_MS),
    ]


def test_a_missing_cutoff_fails_the_gate(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    _store_evaluation(storage, _evaluation(AS_OF - 7 * DAY_MS, [0.02, 0.01, 0.03], True))
    decision = _scored(storage, 2)
    assert decision["passed"] is False
    assert decision["cutoffs"][1]["reason"] == "no evaluation of this backtest"
    assert _publish(tmp_path) == cli.EXIT_PUBLISH_REFUSED


def test_an_evaluation_that_fails_later_makes_the_run_unpublishable(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    _store_evaluation(storage, _evaluation(AS_OF - 7 * DAY_MS, [0.02, 0.01, 0.03], True))
    assert _scored(storage, 1)["passed"] is True
    # The backtest is evaluated again (after an erasure, say) and no longer passes.
    _store_evaluation(storage, _evaluation(AS_OF - 7 * DAY_MS, [0.005, -0.002, 0.012], False))
    with pytest.raises(artefacts.PublishRefused, match="does not pass now"):
        artefacts.publish(storage, RUN, log=lambda _: None)


def test_a_run_without_its_own_decision_is_refused(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    _store_evaluation(storage, _evaluation(AS_OF - 7 * DAY_MS, [0.02, 0.01, 0.03], True))
    write_version(storage, RUN, {"p" * 22: ["t-1"]}, publish=False)  # evaluation: None
    with pytest.raises(artefacts.PublishRefused, match="no gate decision of its own"):
        artefacts.publish(storage, RUN, log=lambda _: None)
    # Another run's passing decision does not stand in for this one's.
    other = run_id_for(AS_OF - DAY_MS, RECIPE)
    decision = gate.decide(storage, run=other, recipe=RECIPE, as_of_ms=AS_OF, count=1)
    manifest = get_json(storage, f"recs/v={RUN}/manifest.json") or {}
    manifest["evaluation"] = gate.manifest_evaluation(decision)
    put_json(storage, f"recs/v={RUN}/manifest.json", manifest)
    with pytest.raises(artefacts.PublishRefused, match="belongs to another run"):
        artefacts.publish(storage, RUN, log=lambda _: None)


def test_a_positive_mean_within_noise_fails() -> None:
    """The verdict is on the interval's lower bound, never the point estimate."""
    assert gate_verdict(m.Interval(0.05, -0.01, 0.11))[0] is False
    assert gate_verdict(m.Interval(0.05, 0.0, 0.1))[0] is False
    assert gate_verdict(m.Interval(0.05, 0.001, 0.1))[0] is True
    # And from a real bootstrap: a small positive mean on noisy paired differences.
    rng = np.random.default_rng(3)
    differences = rng.normal(0.0, 1.0, 400)
    differences += 0.02 - differences.mean()
    interval = m.Bootstrap(400, 500, 7).interval(differences)
    assert interval.mean > 0 > interval.low
    assert gate_verdict(interval)[0] is False


def test_the_number_of_cutoffs_comes_from_the_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(gate.GATE_CUTOFFS_VARIABLE, raising=False)
    assert gate.gate_cutoffs_setting() == 3
    monkeypatch.setenv(gate.GATE_CUTOFFS_VARIABLE, "2")
    assert gate.gate_cutoffs_setting() == 2 and gate.gate_cutoffs_setting(5) == 5
    monkeypatch.setenv(gate.GATE_CUTOFFS_VARIABLE, "0")
    with pytest.raises(gate.GateConfigError):
        gate.gate_cutoffs_setting()
    assert gate.cutoffs_for(AS_OF, 2) == [AS_OF - 7 * DAY_MS, AS_OF - 14 * DAY_MS]
