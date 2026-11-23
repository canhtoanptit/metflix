"""The publish gate: a scored run is published only if the decision that belongs to it passed.

A production run trained as of T belongs with the backtests of the same recipe (code digest and
parameters) at the rolling cutoffs T − 7 days, T − 14 days, ... (`WEBFLIX_RECS_GATE_CUTOFFS` of
them, or `--gate-cutoffs`), each evaluated on the week after its cutoff. Its decision passes only
if every one of those evaluations exists and passed (the 95% interval of the paired difference
on the gate metric entirely above zero). The decision is written beside the evaluations
(`recs-work/evaluations/{recipe}/decision-{run}.json`) and summarised in the version's manifest
(`evaluation`), and `publish` checks it again against the evaluation reports as they are then:
a pass from another day never stands in for this run's, and an evaluation re-run later that
failed makes the run unpublishable.
"""

from __future__ import annotations

import os
import time
from typing import Any

from webflix_recs.ids import DAY_MS, iso_ms, parse_iso_ms
from webflix_recs.storage import Storage, get_json, put_json

EVALUATIONS_PREFIX = "recs-work/evaluations/"
DECISION_FORMAT = "webflix.recs-gate-decision"
GATE_CUTOFFS_VARIABLE = "WEBFLIX_RECS_GATE_CUTOFFS"
DEFAULT_GATE_CUTOFFS = 3
HORIZON_DAYS = 7


class GateConfigError(ValueError):
    """The number of gate cutoffs is not a positive integer (CLI exit code 2)."""


def gate_cutoffs_setting(value: int | None = None) -> int:
    """`--gate-cutoffs`, else WEBFLIX_RECS_GATE_CUTOFFS, else 3."""
    if value is None:
        text = os.environ.get(GATE_CUTOFFS_VARIABLE, "").strip()
        if not text:
            return DEFAULT_GATE_CUTOFFS
        if not text.isdigit():
            raise GateConfigError(f"{GATE_CUTOFFS_VARIABLE}: a positive integer, got {text!r}")
        value = int(text)
    if value < 1:
        raise GateConfigError(f"gate cutoffs: a positive integer, got {value}")
    return value


def cutoffs_for(as_of_ms: int, count: int) -> list[int]:
    """The backtest cutoffs of a run as of T: T − 7 d, T − 14 d, ... (most recent first)."""
    return [as_of_ms - HORIZON_DAYS * DAY_MS * k for k in range(1, count + 1)]


def evaluation_key(recipe: str, run: str) -> str:
    return f"{EVALUATIONS_PREFIX}{recipe}/{run}.json"


def decision_key(recipe: str, run: str) -> str:
    return f"{EVALUATIONS_PREFIX}{recipe}/decision-{run}.json"


def _entry(storage: Storage, recipe: str, cutoff_ms: int, note: str | None) -> dict[str, Any]:
    from webflix_recs.train import run_id_for  # noqa: PLC0415

    backtest = run_id_for(cutoff_ms, recipe)
    key = evaluation_key(recipe, backtest)
    report = get_json(storage, key)
    entry: dict[str, Any] = {"run": backtest, "cutoff": iso_ms(cutoff_ms), "evaluation": None}
    if not isinstance(report, dict):
        return {**entry, "passed": False, "reason": note or "no evaluation of this backtest"}
    gate = report.get("gate") or {}
    problems = []
    if report.get("recipeHash") != recipe:
        problems.append("another recipe")
    if report.get("cutoff") != iso_ms(cutoff_ms):
        problems.append("another cutoff")
    passed = bool(gate.get("passed")) and not problems
    return {
        **entry,
        "evaluation": key,
        "passed": passed,
        "metric": gate.get("metric"),
        "candidate": gate.get("candidate"),
        "baseline": gate.get("baseline"),
        "difference": gate.get("difference"),
        "profiles": report.get("profiles"),
        "reason": "; ".join(problems) if problems else gate.get("reason"),
    }


def decide(
    storage: Storage,
    *,
    run: str,
    recipe: str,
    as_of_ms: int,
    count: int,
    notes: dict[int, str] | None = None,
) -> dict[str, Any]:
    """The decision for production run `run` (trained as of `as_of_ms`), from the evaluations
    in the store; written to its key and returned. `notes`: why a cutoff has no evaluation
    (nothing to train at it, for one)."""
    entries = [
        _entry(storage, recipe, cutoff, (notes or {}).get(cutoff))
        for cutoff in cutoffs_for(as_of_ms, count)
    ]
    decision = {
        "format": DECISION_FORMAT,
        "formatVersion": 1,
        "run": run,
        "recipeHash": recipe,
        "asOf": iso_ms(as_of_ms),
        "decidedAt": iso_ms(int(time.time() * 1000)),
        "required": count,
        "cutoffs": entries,
        "passed": len(entries) == count and all(entry["passed"] for entry in entries),
    }
    put_json(storage, decision_key(recipe, run), decision)
    return decision


def manifest_evaluation(decision: dict[str, Any]) -> dict[str, Any]:
    """What the version's manifest records (`evaluation`): the decision's key and outcome, and
    the most recent cutoff's figures in the fields the manifest always had."""
    latest = decision["cutoffs"][0] if decision["cutoffs"] else {}
    return {
        "decision": decision_key(decision["recipeHash"], decision["run"]),
        "passed": decision["passed"],
        "run": latest.get("run"),
        "cutoff": latest.get("cutoff"),
        "profiles": latest.get("profiles"),
        "metric": latest.get("metric"),
        "candidate": latest.get("candidate"),
        "baseline": latest.get("baseline"),
        "difference": latest.get("difference"),
        "cutoffs": [
            {
                "cutoff": entry["cutoff"],
                "passed": entry["passed"],
                "difference": entry.get("difference"),
            }
            for entry in decision["cutoffs"]
        ],
    }


def publish_problems(storage: Storage, manifest: dict[str, Any]) -> list[str]:
    """Why this version may not be published (empty: it may). Checked against the evaluation
    reports as they are now."""
    recorded = manifest.get("evaluation")
    run, recipe = manifest.get("run"), manifest.get("recipeHash")
    if not isinstance(recorded, dict) or not isinstance(recorded.get("decision"), str):
        return [f"run {run} carries no gate decision of its own (scored before the gate decided?)"]
    decision = get_json(storage, recorded["decision"])
    if not isinstance(decision, dict) or decision.get("format") != DECISION_FORMAT:
        return [f"the gate decision {recorded['decision']} is missing"]
    problems = []
    if decision.get("run") != run or decision.get("recipeHash") != recipe:
        problems.append("the gate decision belongs to another run or recipe")
    if decision.get("asOf") != manifest.get("asOf"):
        problems.append("the gate decision is for another cutoff")
    entries = decision.get("cutoffs") or []
    if not decision.get("passed") or len(entries) < int(decision.get("required") or 1):
        failed = [e["cutoff"] for e in entries if not e.get("passed")]
        problems.append(
            "the backtests did not all beat the rule engine"
            + (f" (failed at {', '.join(failed)})" if failed else "")
        )
    for entry in entries:
        current = _entry(storage, str(recipe), parse_iso_ms(entry["cutoff"]), None)
        if not current["passed"]:
            problems.append(f"the evaluation at {entry['cutoff']} does not pass now")
        elif current.get("difference") != entry.get("difference"):
            problems.append(f"the evaluation at {entry['cutoff']} changed since the decision")
    return problems
