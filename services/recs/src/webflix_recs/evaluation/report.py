"""Human-readable tables from an evaluation report (for the log and the documentation)."""

from __future__ import annotations

from typing import Any

ORDER = (
    "oracle",
    "learned-home",
    "learned",
    "ranker",
    "ranker-naive",
    "rule-engine",
    "rule-engine-home",
    "cowatch",
    "mf",
    "content",
    "popularity",
    "random",
)
COLUMNS = (
    ("utility@10", "Utility@10"),
    ("regret@10", "Regret@10"),
    ("ndcg@10", "NDCG@10"),
    ("recall@20", "Recall@20"),
    ("map@10", "MAP@10"),
    ("search:ndcg@10", "Search NDCG@10"),
    ("diversity@10", "Diversity@10"),
    ("novelty@10", "Novelty@10"),
)


def _cell(value: list[float] | None, digits: int = 3) -> str:
    if not value:
        return "n/a"
    mean, low, high = value
    return f"{mean:.{digits}f} [{low:.{digits}f}, {high:.{digits}f}]"


def markdown_table(report: dict[str, Any], slice_name: str = "all") -> str:
    results = report["results"]
    systems = [s for s in ORDER if s in results] + sorted(set(results) - set(ORDER))
    columns = [
        (key, label)
        for key, label in COLUMNS
        if any(key in results[s].get(slice_name, {}) for s in systems)
    ]
    header = "| System | " + " | ".join(label for _, label in columns) + " | Coverage@10 |"
    rule = "|" + "---|" * (len(columns) + 2)
    lines = [header, rule]
    for system in systems:
        values = results[system].get(slice_name, {})
        coverage = results[system].get("all", {}).get("coverage@10")
        cells = [
            _cell(values.get(key), 2 if key.startswith("novelty") else 3) for key, _ in columns
        ]
        lines.append(
            f"| {system} | "
            + " | ".join(cells)
            + f" | {coverage if coverage is not None else 'n/a'} |"
        )
    gate = report["gate"]
    lines.append("")
    lines.append(
        f"Gate: {gate['metric']} of {gate['candidate']} minus {gate['baseline']} = "
        f"{_cell(gate.get('difference'), 4)} -> {'PASS' if gate.get('passed') else 'FAIL'}"
    )
    return "\n".join(lines)


def slice_table(
    report: dict[str, Any],
    metric: str,
    systems: tuple[str, ...] = (
        "learned-home",
        "rule-engine-home",
        "learned",
        "rule-engine",
        "oracle",
    ),
) -> str:
    results = report["results"]
    slices = [name for name in report["slices"] if any(name in results.get(s, {}) for s in systems)]
    lines = [
        "| Slice | profiles | " + " | ".join(systems) + " |",
        "|" + "---|" * (len(systems) + 2),
    ]
    for name in slices:
        cells = [_cell(results.get(s, {}).get(name, {}).get(metric)) for s in systems]
        lines.append(f"| {name} | {report['slices'][name]} | " + " | ".join(cells) + " |")
    return "\n".join(lines)
