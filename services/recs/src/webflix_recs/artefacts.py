"""`score` and `publish`: versioned recommendation artefacts in the blob store (blueprint §7.1).

Layout (the precise schema is in services/recs/README.md, "Artefacts"):

    recs/v={run}/neighbours/part-00000.parquet   item neighbours, one row per (title, rank)
    recs/v={run}/profiles/part-NNNNN.parquet     one row per profile: its lists as one JSON value
    recs/v={run}/manifest.json                   written last: every file with rows, size, SHA-256
    recs/current.json                            the pointer, flipped last by `publish`
    recs/history/{publishedAt}-{run}.json         every pointer ever published (audit, rollback)

Atomicity: `score` writes the files of a new version, then its manifest; a version without a
manifest is incomplete and nobody points at it. `publish` checks the gate decision that belongs
to the run (gate.py) against the evaluations as they are then, validates the whole version
against the manifest and the schemas, and only then replaces the pointer with one atomic object
write. A reader that follows the pointer therefore always finds a complete,
validated version, before, during and after a publish.
"""

from __future__ import annotations

import hashlib
import io
import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import orjson
import polars as pl

from webflix_recs import schemas
from webflix_recs.catalog import Catalog
from webflix_recs.dataset import DatasetResult
from webflix_recs.history import History
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.provenance import sha256
from webflix_recs.recommend import Recommender
from webflix_recs.storage import Storage, get_json, put_json
from webflix_recs.train import Models

RECS_PREFIX = "recs/"
POINTER_KEY = "recs/current.json"
EVALUATIONS_PREFIX = "recs-work/evaluations/"
FORMAT_VERSION = 1
FORMAT_MINOR = 0
PROFILES_PER_SHARD = 25_000
NEIGHBOURS = 40
ACTIVE_WITHIN_DAYS = 60
VALID_FOR_DAYS = 3
ROW_TYPES = ("personal", "top-picks", "billboard", "because-you-watched")

TABLES: dict[str, dict[str, Any]] = {
    "neighbours": {
        "columns": [
            {
                "name": "title_id",
                "type": "string",
                "nullable": False,
                "description": "Source title id.",
            },
            {
                "name": "rank",
                "type": "int32",
                "nullable": False,
                "description": "1-based, contiguous per title.",
            },
            {
                "name": "neighbour_id",
                "type": "string",
                "nullable": False,
                "description": "Similar title id.",
            },
            {
                "name": "score",
                "type": "float32",
                "nullable": False,
                "description": "Similarity 0..1, non-increasing with rank.",
            },
            {
                "name": "support",
                "type": "int32",
                "nullable": False,
                "description": "Profiles that watched both (0: content only).",
            },
        ],
        "orderBy": ["title_id", "rank"],
        "primaryKey": ["title_id", "rank"],
    },
    "profiles": {
        "columns": [
            {
                "name": "profile_key",
                "type": "string",
                "nullable": False,
                "description": "Pseudonymous profile key.",
            },
            {
                "name": "payload",
                "type": "string",
                "nullable": False,
                "description": "JSON, schemas/recs-profile-lists.schema.json.",
            },
            {
                "name": "items",
                "type": "int32",
                "nullable": False,
                "description": "Items over all rows of the payload.",
            },
            {
                "name": "bytes",
                "type": "int32",
                "nullable": False,
                "description": "UTF-8 length of payload.",
            },
        ],
        "orderBy": ["profile_key"],
        "primaryKey": ["profile_key"],
    },
}
_POLARS_TYPES = {"string": pl.String, "int32": pl.Int32, "float32": pl.Float32}


class PublishRefused(RuntimeError):
    pass


def _parquet(frame: pl.DataFrame) -> bytes:
    buffer = io.BytesIO()
    # Snappy and plain types (UTF-8 strings, INT32, FLOAT): readable by every Parquet reader,
    # including small pure-JavaScript ones an importer can use (hyparquet).
    frame.write_parquet(buffer, compression="snappy", statistics=True, row_group_size=10_000)
    return buffer.getvalue()


def _frame(table: str, data: dict[str, Any]) -> pl.DataFrame:
    schema = {column["name"]: _POLARS_TYPES[column["type"]] for column in TABLES[table]["columns"]}
    return pl.DataFrame(data, schema=schema)


def shard_of(profile_key: str, shards: int) -> int:
    return int.from_bytes(hashlib.sha256(profile_key.encode()).digest()[:8], "big") % shards


@dataclass
class ScoreResult:
    run: str
    manifest: dict[str, Any]


def scoring_profiles(
    dataset: DatasetResult,
    history: History,
    as_of_ms: int,
    excluded: frozenset[str] = frozenset(),
) -> list[str]:
    """Profiles to score: eligible (the dataset already excludes restricted and non-consenting
    ones), seen in the last 60 days, on an account that has not cancelled, and neither the
    profile nor its account pending erasure when scoring starts (`excluded`: an erased account,
    a profile newly restricted; the dataset may be older than the request)."""
    profiles = dataset.tables["profiles"]
    if excluded:
        wanted = list(excluded)
        profiles = profiles.filter(
            ~(pl.col("profile").is_in(wanted) | pl.col("account").is_in(wanted).fill_null(False))
        )
    accounts = dataset.tables["accounts"]
    canceled = (
        set(accounts.filter(pl.col("state") == "canceled")["account"].to_list())
        if accounts.height
        else set()
    )
    recent = profiles.filter(
        (pl.col("last_seen").fill_null(0) >= as_of_ms - ACTIVE_WITHIN_DAYS * DAY_MS)
        & ~pl.col("account").is_in(list(canceled))
    )
    return sorted(set(recent["profile"].to_list()) & set(history.profiles))


def neighbour_rows(
    models: Models, catalog: Catalog, available: np.ndarray[Any, np.dtype[np.bool_]]
) -> dict[str, list[Any]]:
    """The neighbours table's rows: for each title that has arrived, its `NEIGHBOURS` best
    blended (co-watch and content) neighbours among titles that have arrived, score > 0."""
    ids = catalog.ids
    rows: dict[str, list[Any]] = {
        "title_id": [],
        "rank": [],
        "neighbour_id": [],
        "score": [],
        "support": [],
    }
    order = sorted(range(len(ids)), key=lambda i: ids[i].encode())
    for source in order:
        if not available[source]:
            continue
        values = models.blend[source].copy()
        values[source] = -np.inf
        values[~available] = -np.inf
        ranked = np.lexsort((np.arange(len(values)), -values))
        kept = [int(t) for t in ranked[:NEIGHBOURS] if np.isfinite(values[t]) and values[t] > 0]
        for rank, target in enumerate(kept, start=1):
            rows["title_id"].append(ids[source])
            rows["rank"].append(rank)
            rows["neighbour_id"].append(ids[target])
            rows["score"].append(float(min(1.0, values[target])))
            rows["support"].append(int(models.cowatch.support[source, target]))
    return rows


def score(
    storage: Storage,
    catalog: Catalog,
    dataset: DatasetResult,
    models: Models,
    run_manifest: dict[str, Any],
    *,
    evaluation: dict[str, Any] | None = None,
    profiles_per_shard: int = PROFILES_PER_SHARD,
    fail_after_shards: int | None = None,
    log: Any = print,
    excluded: frozenset[str] = frozenset(),
) -> ScoreResult:
    """Write a complete artefact version for the run (manifest last)."""
    started = time.perf_counter()
    run = run_manifest["run"]
    as_of = int(run_manifest["data"]["asOfMs"])
    prefix = f"{RECS_PREFIX}v={run}/"
    eligible = dataset.tables["profiles"]["profile"].sort().to_list()
    history = History.build(dataset, catalog, as_of, profiles=eligible)
    profiles = scoring_profiles(dataset, history, as_of, excluded)
    recommender = Recommender(models, history)
    generated = iso_ms(int(time.time() * 1000))
    expires = iso_ms(as_of + VALID_FOR_DAYS * DAY_MS)
    available = catalog.available_mask(as_of)
    files: list[dict[str, Any]] = []

    # Item neighbours: co-watch blended with content, among titles that have arrived.
    neighbours = _frame("neighbours", neighbour_rows(models, catalog, available))
    body = _parquet(neighbours)
    storage.put(prefix + "neighbours/part-00000.parquet", body)
    files.append(
        _file_entry("neighbours/part-00000.parquet", "neighbours", neighbours, body, "title_id")
    )

    # Profile lists, sharded by a hash of the key so each shard is a stable, bounded batch.
    shards = max(1, math.ceil(len(profiles) / profiles_per_shard))
    assignment: dict[int, list[str]] = {shard: [] for shard in range(shards)}
    for profile in profiles:
        assignment[shard_of(profile, shards)].append(profile)
    items_total = 0
    for shard in range(shards):
        if fail_after_shards is not None and shard >= fail_after_shards:
            raise RuntimeError(f"simulated failure while scoring shard {shard}")
        keys = sorted(assignment[shard], key=lambda k: k.encode())
        payloads: list[str] = []
        counts: list[int] = []
        rows_index = history.rows(keys)
        for start in range(0, len(keys), 2000):
            block = recommender.score(rows_index[start : start + 2000], ("ranker",))
            for key, lists in recommender.lists(block):
                document = {
                    "v": FORMAT_VERSION,
                    "profile": key,
                    "run": run,
                    "generatedAt": generated,
                    "expiresAt": expires,
                    "rows": lists,
                }
                payloads.append(orjson.dumps(document).decode())
                counts.append(sum(len(row["items"]) for row in lists))
        frame = _frame(
            "profiles",
            {
                "profile_key": keys,
                "payload": payloads,
                "items": counts,
                "bytes": [len(p.encode()) for p in payloads],
            },
        )
        items_total += sum(counts)
        path = f"profiles/part-{shard:05d}.parquet"
        body = _parquet(frame)
        storage.put(prefix + path, body)
        files.append(_file_entry(path, "profiles", frame, body, "profile_key"))
        log(f"  scored shard {shard + 1}/{shards}: {len(keys)} profiles")
    manifest = {
        "format": "webflix.recs",
        "formatVersion": FORMAT_VERSION,
        "formatMinor": FORMAT_MINOR,
        "run": run,
        "recipeHash": run_manifest["recipeHash"],
        "createdAt": generated,
        "asOf": iso_ms(as_of),
        "expiresAt": expires,
        "catalogVersion": catalog.version,
        "code": run_manifest["code"],
        "data": run_manifest["data"],
        "evaluation": evaluation,
        "counts": {
            "profiles": len(profiles),
            "titles": int(available.sum()),
            "neighbourRows": neighbours.height,
            "profileItems": items_total,
        },
        "rowTypes": list(ROW_TYPES),
        "tables": TABLES,
        "files": files,
    }
    schemas.validate("recs-manifest", manifest)
    put_json(storage, prefix + "manifest.json", manifest)
    log(f"scored {len(profiles)} profiles into {prefix} in {time.perf_counter() - started:.1f}s")
    return ScoreResult(run, manifest)


def _file_entry(
    path: str, table: str, frame: pl.DataFrame, body: bytes, key: str
) -> dict[str, Any]:
    keys = frame[key]
    return {
        "path": path,
        "table": table,
        "rows": frame.height,
        "bytes": len(body),
        "sha256": sha256(body),
        "firstKey": keys[0] if frame.height else None,
        "lastKey": keys[-1] if frame.height else None,
    }


# --- Validation ---------------------------------------------------------------------------------


def validate_version(storage: Storage, run: str, *, check_payloads: bool = True) -> list[str]:
    """Every problem with a version: manifest schema, file presence, size and hash, Parquet
    columns and types, ordering and key guarantees, and each payload against its schema."""
    prefix = f"{RECS_PREFIX}v={run}/"
    manifest = get_json(storage, prefix + "manifest.json")
    if manifest is None:
        return [f"{prefix}manifest.json is missing: the version is incomplete"]
    problems: list[str] = []
    try:
        schemas.validate("recs-manifest", manifest)
    except schemas.SchemaError as error:
        return [f"manifest: {error}"]
    if manifest["run"] != run:
        problems.append(f"manifest names run {manifest['run']}, not {run}")
    if manifest["formatVersion"] != FORMAT_VERSION:
        problems.append(f"unknown format version {manifest['formatVersion']}")
    seen_profiles: set[str] = set()
    profile_count = 0
    item_count = 0
    for entry in manifest["files"]:
        body = storage.get(prefix + entry["path"])
        where = entry["path"]
        if body is None:
            problems.append(f"{where}: missing")
            continue
        if len(body) != entry["bytes"] or sha256(body) != entry["sha256"]:
            problems.append(f"{where}: size or SHA-256 differs from the manifest")
            continue
        table = manifest["tables"].get(entry["table"])
        if table is None:
            problems.append(f"{where}: unknown table {entry['table']}")
            continue
        frame = pl.read_parquet(io.BytesIO(body))
        expected = {column["name"]: _POLARS_TYPES[column["type"]] for column in table["columns"]}
        actual = dict(frame.schema)
        for name, dtype in expected.items():
            if name not in actual:
                problems.append(f"{where}: column {name} missing")
            elif actual[name] != dtype:
                problems.append(f"{where}: column {name} is {actual[name]}, expected {dtype}")
        if frame.height != entry["rows"]:
            problems.append(f"{where}: {frame.height} rows, manifest says {entry['rows']}")
        problems.extend(
            f"{where}: nulls in {column['name']}"
            for column in table["columns"]
            if not column["nullable"]
            and column["name"] in actual
            and frame[column["name"]].null_count()
        )
        if problems:
            continue
        if entry["table"] == "neighbours":
            problems.extend(_check_neighbours(frame, where))
        elif entry["table"] == "profiles":
            keys = frame["profile_key"].to_list()
            if keys != sorted(keys, key=lambda k: k.encode()):
                problems.append(f"{where}: profile_key not in ascending byte order")
            duplicates = seen_profiles.intersection(keys)
            if duplicates or len(set(keys)) != len(keys):
                problems.append(f"{where}: duplicate profile keys")
            seen_profiles.update(keys)
            profile_count += frame.height
            item_count += int(frame["items"].sum())
            if check_payloads:
                for key, payload, items, size in frame.select(
                    "profile_key", "payload", "items", "bytes"
                ).iter_rows():
                    document = orjson.loads(payload)
                    try:
                        schemas.validate("recs-profile-lists", document)
                    except schemas.SchemaError as error:
                        problems.append(f"{where}: {key}: {error}")
                        break
                    if document["profile"] != key or document["run"] != run:
                        problems.append(f"{where}: {key}: payload names another profile or run")
                    if (
                        sum(len(row["items"]) for row in document["rows"]) != items
                        or len(payload.encode()) != size
                    ):
                        problems.append(
                            f"{where}: {key}: items or bytes column disagrees with the payload"
                        )
                    for row in document["rows"]:
                        scores = [item[1] for item in row["items"]]
                        if any(not math.isfinite(value) for value in scores):
                            problems.append(f"{where}: {key}: non-finite score")
                        if row["type"] in {"personal", "because-you-watched"} and scores != sorted(
                            scores, reverse=True
                        ):
                            problems.append(f"{where}: {key}: {row['type']} not ordered by score")
                        titles = [item[0] for item in row["items"]]
                        if len(set(titles)) != len(titles):
                            problems.append(f"{where}: {key}: duplicate title in {row['type']}")
    counts = manifest["counts"]
    if not problems and (
        profile_count != counts["profiles"] or item_count != counts["profileItems"]
    ):
        problems.append("manifest counts disagree with the files")
    return problems


def _check_neighbours(frame: pl.DataFrame, where: str) -> list[str]:
    problems = []
    keys = list(zip(frame["title_id"].to_list(), frame["rank"].to_list(), strict=True))
    if keys != sorted(keys, key=lambda k: (k[0].encode(), k[1])):
        problems.append(f"{where}: not ordered by (title_id, rank)")
    grouped = frame.group_by("title_id").agg(
        pl.col("rank").min().alias("first"),
        pl.col("rank").max().alias("last"),
        pl.len().alias("n"),
        (pl.col("score").diff().fill_null(0) <= 1e-6).all().alias("monotone"),
        (pl.col("title_id") == pl.col("neighbour_id")).any().alias("self"),
    )
    if grouped.filter((pl.col("first") != 1) | (pl.col("last") != pl.col("n"))).height:
        problems.append(f"{where}: ranks are not contiguous from 1")
    if grouped.filter(~pl.col("monotone")).height:
        problems.append(f"{where}: scores increase with rank")
    if grouped.filter(pl.col("self")).height:
        problems.append(f"{where}: a title is its own neighbour")
    return problems


# --- Publishing ---------------------------------------------------------------------------------


def publish(storage: Storage, run: str, *, keep: int = 3, log: Any = print) -> dict[str, Any]:
    prefix = f"{RECS_PREFIX}v={run}/"
    manifest = get_json(storage, prefix + "manifest.json")
    if manifest is None:
        raise PublishRefused(
            f"run {run} has no complete artefact version ({prefix}manifest.json missing): "
            "run `score` first"
        )
    from webflix_recs.gate import publish_problems  # noqa: PLC0415

    refusals = publish_problems(storage, manifest)
    if refusals:
        raise PublishRefused(f"the gate refuses run {run}: " + "; ".join(refusals))
    problems = validate_version(storage, run)
    if problems:
        raise PublishRefused(f"version {run} is invalid: " + "; ".join(problems[:10]))
    current = get_json(storage, POINTER_KEY)
    previous = current["run"] if current else None
    body = storage.get(prefix + "manifest.json")
    assert body is not None
    pointer: dict[str, Any] = {
        "format": "webflix.recs-pointer",
        "formatVersion": 1,
        "run": run,
        "manifest": prefix + "manifest.json",
        "manifestSha256": sha256(body),
        "publishedAt": iso_ms(int(time.time() * 1000)),
        "previous": previous if previous != run else (current or {}).get("previous"),
        "gate": manifest["evaluation"],
    }
    schemas.validate("recs-pointer", pointer)
    put_json(
        storage,
        f"{RECS_PREFIX}history/{pointer['publishedAt'].replace(':', '')}-{run}.json",
        pointer,
    )
    # The flip: one atomic object write. Everything it names is already complete and valid.
    put_json(storage, POINTER_KEY, pointer)
    gate = manifest["evaluation"]
    log(
        f"published {run} (previous: {pointer['previous']}); gate {gate.get('metric')} "
        f"differences {[entry.get('difference') for entry in gate.get('cutoffs', [])]}"
    )
    prune(storage, keep=keep, protect={run, pointer["previous"] or ""})
    return pointer


def read_current(storage: Storage) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """What a reader (the importer) does: follow the pointer, verify the manifest's hash."""
    pointer = get_json(storage, POINTER_KEY)
    if pointer is None:
        return None
    schemas.validate("recs-pointer", pointer)
    body = storage.get(pointer["manifest"])
    if body is None or sha256(body) != pointer["manifestSha256"]:
        raise ValueError("the pointer names a manifest that is missing or changed")
    manifest = orjson.loads(body)
    schemas.validate("recs-manifest", manifest)
    return pointer, manifest


def prune(storage: Storage, *, keep: int, protect: set[str]) -> list[str]:
    """Delete complete versions beyond the `keep` newest, never the current or previous one.
    Incomplete versions (no manifest) older than a day are deleted too."""
    versions: dict[str, list[str]] = {}
    for info in storage.list(f"{RECS_PREFIX}v="):
        run = info.key[len(RECS_PREFIX) + 2 :].split("/", 1)[0]
        versions.setdefault(run, []).append(info.key)
    complete = []
    removed = []
    for run, keys in versions.items():
        manifest_key = f"{RECS_PREFIX}v={run}/manifest.json"
        if manifest_key in keys:
            complete.append(((get_json(storage, manifest_key) or {}).get("createdAt", ""), run))
        else:
            newest = max(
                (storage.head(key) for key in keys),
                key=lambda info: info.uploaded_at_ms if info else 0,
            )
            if (
                newest
                and newest.uploaded_at_ms < time.time() * 1000 - DAY_MS
                and run not in protect
            ):
                storage.delete(keys)
                removed.append(run)
    complete.sort(reverse=True)
    for _, run in complete[keep:]:
        if run not in protect:
            storage.delete(versions[run])
            removed.append(run)
    return removed


def store_evaluation(storage: Storage, report: dict[str, Any]) -> str:
    key = f"{EVALUATIONS_PREFIX}{report['recipeHash']}/{report['run']}.json"
    put_json(storage, key, report)
    return key
