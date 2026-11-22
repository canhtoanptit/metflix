"""Experiment definitions, from wherever they come, in the form the analysis reads.

Three sources are accepted, all normalised to `schemas/experiment-definitions.schema.json`:

* the pipeline's own document (`webflix.experiment-definitions`, version 1), which the
  simulator writes to `experiments/definitions.json`;
* the product's staff API answer `GET /api/admin/v1/experiments` (`{items: [...]}`, each an
  `ExperimentDefinition` of packages/contracts/src/experiments.ts), or a bare list of them.

Mapping a product definition: drafts (never started: no `registeredAt`) and archived experiments
are skipped and listed; `unit` (`profile` or `device`), `layer`, `control`, the metrics, `alpha`,
`power`, `minimumDetectableEffect`, `srmThreshold` and `endsAt` are taken as they are. The
analysis window starts at `max(startsAt, registeredAt)`: the product assigns nobody before an
experiment is started (registration), so a `startsAt` set in the past before pressing start is
not a late registration, and nothing before registration counts.
"""

from __future__ import annotations

from typing import Any

from webflix_recs import schemas
from webflix_recs.ids import iso_ms, parse_iso_ms

PIPELINE_FORMAT = "webflix.experiment-definitions"


def _from_product(item: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    key = str(item.get("key"))
    if item.get("status") == "draft" or not item.get("registeredAt"):
        return None, "draft: never started, nothing to analyse"
    if item.get("status") == "archived":
        return None, "archived"
    if not item.get("startsAt"):
        return None, "no startsAt"
    registered = parse_iso_ms(str(item["registeredAt"]))
    starts = max(parse_iso_ms(str(item["startsAt"])), registered)
    definition: dict[str, Any] = {
        "key": key,
        "variants": [
            {"name": str(variant["name"]), "weight": float(variant["weight"])}
            for variant in item.get("variants", [])
        ],
        "control": str(item.get("control") or item["variants"][0]["name"]),
        "unit": str(item.get("unit", "profile")),
        "primaryMetric": str(item["primaryMetric"]),
        "secondaryMetrics": [str(metric) for metric in item.get("secondaryMetrics", [])],
        "alpha": float(item["alpha"]),
        "minimumDetectableEffect": float(item["minimumDetectableEffect"]),
        "registeredAt": iso_ms(registered),
        "startsAt": iso_ms(starts),
        "endsAt": iso_ms(parse_iso_ms(str(item["endsAt"]))) if item.get("endsAt") else None,
        "analysis": {"method": "msprt", "looks": "daily"},
    }
    if item.get("layer"):
        definition["layer"] = str(item["layer"])
    if item.get("status"):
        definition["status"] = str(item["status"])
    if isinstance(item.get("description"), str):
        definition["description"] = item["description"]
    if item.get("power") is not None:
        definition["power"] = float(item["power"])
    if item.get("srmThreshold") is not None:
        definition["srmThreshold"] = float(item["srmThreshold"])
    return definition, None


def normalise_definitions(document: Any) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Any accepted source -> (pipeline-format definitions, skipped `{key, reason}`)."""
    if isinstance(document, dict) and document.get("format") == PIPELINE_FORMAT:
        schemas.validate("experiment-definitions", document)
        return document, []
    if isinstance(document, dict) and isinstance(document.get("items"), list):
        items = document["items"]
    elif isinstance(document, list):
        items = document
    else:
        raise ValueError(
            "experiment definitions: expected the pipeline's document, the staff API's "
            "`GET /experiments` answer ({items: [...]}) or a list of definitions"
        )
    experiments: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        definition, reason = _from_product(item)
        if definition is None:
            skipped.append({"key": str(item.get("key")), "reason": reason or "skipped"})
        else:
            experiments.append(definition)
    normalised = {"format": PIPELINE_FORMAT, "formatVersion": 1, "experiments": experiments}
    schemas.validate("experiment-definitions", normalised)
    return normalised, skipped
