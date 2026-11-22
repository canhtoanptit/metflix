"""Experiment results in the store: what the product imports into `saveExperimentResults`.

Layout (services/recs/README.md, "Experiment results"):

    experiments/results/r={run}/{key}.json    one `webflix.experiment-result` per experiment
    experiments/results/r={run}/report.json   the whole `webflix.experiment-report` (audit)
    experiments/results/current.json          the pointer, written last

`run` is the analysis instant, `YYYYMMDD-HHMMSS-mmm` (UTC). A result document is
`{format, formatVersion: 1, key, computedAt, asOf, report}` where `report` is that experiment's
element of the report (schemas/experiment-report.schema.json, `$defs.experiment`): the importer
calls `saveExperimentResults(key, report, Date.parse(computedAt))`, which the staff route
`GET /api/admin/v1/experiments/:key/results` answers as `{key, computedAt, report}`. The pointer
lists every result with its byte count and SHA-256; a run directory the pointer does not name is
incomplete or old and is never read. Older runs are pruned after `keep_days` (the current and
previous runs are always kept).
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

import orjson

from webflix_recs import schemas
from webflix_recs.ids import DAY_MS, iso_ms, parse_iso_ms
from webflix_recs.storage import Storage, get_json, put_json

RESULTS_PREFIX = "experiments/results/"
RESULTS_POINTER = "experiments/results/current.json"
DEFAULT_KEEP_DAYS = 30


def run_id(computed_at: str) -> str:
    """`2026-11-22T06:00:12.345Z` -> `20261122-060012-345`."""
    return (
        f"{computed_at[0:4]}{computed_at[5:7]}{computed_at[8:10]}-"
        f"{computed_at[11:13]}{computed_at[14:16]}{computed_at[17:19]}-{computed_at[20:23]}"
    )


def result_document(report: dict[str, Any], experiment: dict[str, Any]) -> dict[str, Any]:
    return {
        "format": "webflix.experiment-result",
        "formatVersion": 1,
        "key": experiment["key"],
        "computedAt": report["generatedAt"],
        "asOf": report["asOf"],
        "report": experiment,
    }


def write_results(
    storage: Storage, report: dict[str, Any], *, keep_days: int = DEFAULT_KEEP_DAYS
) -> dict[str, Any]:
    """Write one analysis run's results, then flip the pointer to them. Returns the pointer."""
    schemas.validate("experiment-report", report)
    run = run_id(report["generatedAt"])
    prefix = f"{RESULTS_PREFIX}r={run}/"
    entries = []
    for experiment in report["experiments"]:
        document = result_document(report, experiment)
        schemas.validate("experiment-result", document)
        body = orjson.dumps(document, option=orjson.OPT_APPEND_NEWLINE)
        path = f"{prefix}{experiment['key']}.json"
        storage.put(path, body, content_type="application/json")
        entries.append(
            {
                "key": experiment["key"],
                "path": path,
                "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
                "decision": experiment["decision"]["status"],
            }
        )
    put_json(storage, f"{prefix}report.json", report)
    previous = get_json(storage, RESULTS_POINTER)
    pointer = {
        "format": "webflix.experiment-results-pointer",
        "formatVersion": 1,
        "run": run,
        "computedAt": report["generatedAt"],
        "asOf": report["asOf"],
        "report": f"{prefix}report.json",
        "results": entries,
        "skipped": list(report.get("definitionsSkipped", [])),
        "previous": previous.get("run") if isinstance(previous, dict) else None,
    }
    schemas.validate("experiment-results-pointer", pointer)
    put_json(storage, RESULTS_POINTER, pointer)
    prune_results(storage, keep_days=keep_days, protect={run, pointer["previous"] or ""})
    return pointer


def prune_results(storage: Storage, *, keep_days: int, protect: set[str]) -> list[str]:
    cutoff = int(time.time() * 1000) - keep_days * DAY_MS
    runs: dict[str, list[str]] = {}
    for info in storage.list(f"{RESULTS_PREFIX}r="):
        name = info.key[len(RESULTS_PREFIX) + 2 :].split("/", 1)[0]
        runs.setdefault(name, []).append(info.key)
    removed = []
    for name, keys in runs.items():
        if name in protect:
            continue
        stamp = f"{name[0:4]}-{name[4:6]}-{name[6:8]}T{name[9:11]}:{name[11:13]}:{name[13:15]}Z"
        try:
            at = parse_iso_ms(stamp)
        except ValueError:
            continue
        if at < cutoff:
            storage.delete(keys)
            removed.append(name)
    return removed


def read_results(storage: Storage) -> list[dict[str, Any]]:
    """What an importer does: follow the pointer, verify each file, return the documents."""
    pointer = get_json(storage, RESULTS_POINTER)
    if pointer is None:
        return []
    schemas.validate("experiment-results-pointer", pointer)
    documents = []
    for entry in pointer["results"]:
        body = storage.get(entry["path"])
        if body is None or len(body) != entry["bytes"]:
            raise ValueError(f"{entry['path']}: missing or not the size the pointer says")
        if hashlib.sha256(body).hexdigest() != entry["sha256"]:
            raise ValueError(f"{entry['path']}: SHA-256 differs from the pointer")
        document = orjson.loads(body)
        schemas.validate("experiment-result", document)
        documents.append(document)
    return documents


__all__ = ["RESULTS_POINTER", "RESULTS_PREFIX", "iso_ms", "read_results", "write_results"]
