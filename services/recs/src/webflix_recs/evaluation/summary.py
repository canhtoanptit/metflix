"""`python -m webflix_recs.evaluation.summary <reports-dir>`: the Markdown summary of a local run
(the tables in docs/RECOMMENDATIONS-ML.md are copied from it)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import orjson

from webflix_recs.evaluation.report import markdown_table, slice_table
from webflix_recs.simulate.world import (
    EXAMINE_POSITION_EXPONENT,
    ROW_ATTENTION_DECAY,
    ROW_ATTENTION_FLOOR,
)


def _load(path: Path) -> Any:
    return orjson.loads(path.read_bytes()) if path.exists() else None


def _interval(value: list[float] | None, digits: int = 4) -> str:
    if not value:
        return "n/a"
    return f"{value[0]:+.{digits}f} [{value[1]:+.{digits}f}, {value[2]:+.{digits}f}]"


def _fmt(value: float | None, *, percent: bool = False) -> str:
    if value is None:
        return "n/a"
    return f"{value:+.1%}" if percent else f"{value:.4g}"


def steps_table(reports: Path) -> str:
    lines = ["| Step | Wall time (s) | Peak RSS (MB) | What |", "|---|---|---|---|"]
    for path in sorted((reports / "steps").glob("*.json"), key=lambda p: p.stat().st_mtime):
        step = orjson.loads(path.read_bytes())
        what = {
            "simulate": lambda s: (
                f"{s.get('eventLines')} events, {s.get('profiles')} profiles, {s.get('sessions')} sessions"
            ),
            "compact": lambda s: (
                f"{s.get('hours_compacted')} hours, {s.get('events_written')} events, {s.get('duplicates_dropped')} duplicates dropped"
            ),
            "build-dataset": lambda s: f"{s.get('rows')}",
            "train-backtest": lambda s: (
                f"run {s.get('run')}, {s.get('rankerExamples')} ranker examples"
            ),
            "train-production": lambda s: (
                f"run {s.get('run')}, {s.get('rankerExamples')} ranker examples"
            ),
            "evaluate": lambda s: f"{s.get('profiles')} profiles",
            "score": lambda s: f"{s.get('counts')}",
            "publish": lambda s: f"pointer to {s.get('run')}",
            "validate": lambda s: f"valid: {s.get('valid')}",
            "analyse-experiments": lambda s: f"{s.get('experiments')}",
        }.get(path.stem, lambda s: "")(step)
        lines.append(
            f"| {path.stem} | {step.get('wallSeconds')} | {step.get('maxRssMb')} | {what} |"
        )
    return "\n".join(lines)


def main(reports_dir: str) -> None:
    reports = Path(reports_dir)
    evaluation = _load(reports / "evaluation.json")
    experiments = _load(reports / "experiments.json")
    out = ["# Recommendation pipeline: local run summary", ""]
    out += ["## Steps", "", steps_table(reports), ""]
    if evaluation:
        out += [
            f"## Offline evaluation (cutoff {evaluation['cutoff']}, test window to {evaluation['testWindowEnd']})",
            "",
            f"{evaluation['profiles']} evaluated profiles (of {evaluation['eligibleProfiles']} eligible), "
            f"{evaluation['discoveriesPerProfile']} discoveries per profile, "
            f"{evaluation['profilesWithSearchDiscovery']} with a search discovery, "
            f"{evaluation['availableTitles']} titles available ({evaluation['coldStartTitles']} under 14 days old). "
            f"Means with 95% bootstrap intervals ({evaluation['bootstrapReplicates']} resamples over profiles).",
            "",
            markdown_table(evaluation),
            "",
            "### Paired differences against the rule engine",
            "",
            "| System | Utility@10 | NDCG@10 | Search NDCG@10 | Recall@20 |",
            "|---|---|---|---|---|",
        ]
        for system, values in evaluation["differencesVsRuleEngine"].items():
            out.append(
                f"| {system} | {_interval(values.get('utility@10'))} | {_interval(values.get('ndcg@10'))} "
                f"| {_interval(values.get('search:ndcg@10'))} | {_interval(values.get('recall@20'))} |"
            )
        out += [
            "",
            "### Ablations (paired)",
            "",
            "| Change | Utility@10 | NDCG@10 | Search NDCG@10 | Diversity@10 | Novelty@10 |",
            "|---|---|---|---|---|---|",
        ]
        for name, values in evaluation.get("ablations", {}).items():
            out.append(
                f"| {name} | {_interval(values.get('utility@10'))} | {_interval(values.get('ndcg@10'))} "
                f"| {_interval(values.get('search:ndcg@10'))} | {_interval(values.get('diversity@10'))} | {_interval(values.get('novelty@10'), 3)} |"
            )
        out += ["", "### Slices: utility@10", "", slice_table(evaluation, "utility@10"), ""]
        out += [
            "### Slices: NDCG@10 (replay, all discoveries)",
            "",
            slice_table(evaluation, "ndcg@10"),
            "",
        ]
        cold = evaluation.get("coldStartTitleRecall@20", {})
        if cold:
            out += [
                "### Cold-start titles: recall@20 of discoveries of titles under 14 days old",
                "",
            ]
            out += ["| System | Recall@20 |", "|---|---|"]
            out += [
                f"| {system} | {value[0]:.3f} [{value[1]:.3f}, {value[2]:.3f}] |"
                for system, value in cold.items()
            ]
            out.append("")
        propensity = evaluation.get("propensity", {})
        out += [
            "### Position bias",
            "",
            f"Estimated from exploration impressions: gamma = {propensity.get('gamma')} "
            f"(95% interval {propensity.get('gammaInterval95')}); the simulator's truth is "
            f"{EXAMINE_POSITION_EXPONENT}. Row attention estimate {propensity.get('rowAttention')} "
            f"(truth: max({ROW_ATTENTION_FLOOR}, 1 - {ROW_ATTENTION_DECAY} (row - 1)), relative to the first shuffled row).",
            "",
        ]
    if experiments:
        out += ["## Experiments", ""]
        out += [
            "| Experiment | Units per variant | SRM p | Primary metric | Control mean | Difference [95% CI] "
            "| Relative lift | Always-valid p | Decision |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for experiment in experiments["experiments"]:
            primary = experiment["primaryMetric"]
            metric = experiment["metrics"].get(primary, {})
            control = metric.get("variants", {}).get(experiment["control"], {}).get("mean")
            for comparison in metric.get("comparisons", []):
                ci = comparison.get("ci95") or [None, None]
                difference = comparison.get("difference")
                lift = comparison.get("relativeLift")
                out.append(
                    f"| {experiment['key']} | {experiment['units']} | {experiment['srm']['pValue']} "
                    f"| {primary} | {_fmt(control)} | {_fmt(difference)} [{_fmt(ci[0])}, {_fmt(ci[1])}] "
                    f"| {_fmt(lift, percent=True)} | {_fmt(comparison['sequential']['alwaysValidP'])} "
                    f"| {experiment['decision']['status']} |"
                )
        out.append("")
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
