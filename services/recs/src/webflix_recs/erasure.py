"""`erase`: removing erased members from everything this pipeline stores (blueprint §6.3).

When a member deletes their account, the product records the pseudonymous keys of the account
(and its profiles) and lists them for the operator (`GET /api/admin/v1/system/privacy/erasures`).
This job takes those keys, rewrites what holds them, verifies that nothing is left, and only
then says which keys to confirm (`POST …/erasures/confirm`). A key matches an event when it is
the event's `subject.account` or `subject.profile`; an account's profile keys are discovered
from the lake and the datasets (events carry both), so they go too.

What holds subject keys in the store, and what is done to each:

* `events/…/*.ndjson.gz` (the lake writer's objects): rewritten in place without the subject's
  lines, under the same key (a compaction manifest that covers it still does); deleted when
  nothing is left.
* `events/…/part-*.parquet` (compacted hours): a new file without the subject's rows, the
  manifest flipped to it, the old file deleted (lake.flip). Parquet files no manifest names
  (left by an interrupted rewrite) are deleted.
* `events-quarantine/…`: in place like raw objects; a line that is not even JSON goes if it
  contains a key.
* `recs-work/datasets/{id}/*.parquet`: rows of the subject's account and profiles removed; the
  manifest's row counts updated.
* `recs/v={run}/profiles/*.parquet`: the subject's profiles' rows removed; the manifest's file
  entries and counts recomputed; `recs/current.json` re-pointed at the new manifest digest when
  it names that run.
* `privacy/export-events/{requestId}/`: an export of the subject's events written by
  `export-events` is deleted whole (the product deletes its own export documents).

Nothing else in the store holds a subject key: runs keep item factors only, evaluations and
experiment reports are aggregates (a test checks).

Crash safety. Keys and discovered profile keys are written to the plan
(`recs-work/erasure/plan.json`) before anything is rewritten, and every rewrite only removes
what matches, so running the job again after a failure anywhere simply finds less to do. An
artefact version being rewritten is marked in the plan first; a rerun recomputes its manifest
from the files even if the shard rewrite finished and the manifest write did not. Nothing is
confirmed unless a full verification pass finds no occurrence anywhere: a failed or interrupted
run leaves the keys pending in the product, and the next run takes them again. Confirmed keys
stay in the plan for a watch period (30 days by default), during which every run also removes
any late arrival of theirs (a retried batch replayed from a dead letter); then they are
forgotten.

Compaction and erasure hold the lake lease (lease.py) and never overlap.
"""

from __future__ import annotations

import gzip
import io
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Any

import orjson
import polars as pl

from webflix_recs.ids import DAY_MS, iso_ms, parse_iso_ms
from webflix_recs.lake import (
    COMPACTION_MANIFEST,
    EVENTS_PREFIX,
    QUARANTINE_PREFIX,
    HourObjects,
    compacted_frame,
    covered_sources,
    flip,
    list_hours,
    manifest_document,
    parquet_key,
    read_manifest,
    relist_hour,
    write_compacted,
)
from webflix_recs.parallel import parallel_map
from webflix_recs.storage import Storage, get_json, open_storage, put_json

PLAN_KEY = "recs-work/erasure/plan.json"
DATASET_PREFIX = "recs-work/datasets/"
RECS_PREFIX = "recs/"
POINTER_KEY = "recs/current.json"
DEFAULT_WATCH_DAYS = 30
_SUBJECT_SCHEMA = {"subject": pl.Struct({"account": pl.String, "profile": pl.String})}


class ErasureIncomplete(RuntimeError):
    """Verification found what should have gone (CLI exit code 5); nothing is confirmed."""

    def __init__(self, remaining: dict[str, int]) -> None:
        super().__init__(
            "erasure incomplete, nothing confirmed: "
            + ", ".join(f"{area} {n}" for area, n in sorted(remaining.items()) if n)
        )
        self.remaining = remaining


# --- The plan -----------------------------------------------------------------------------------


def load_plan(storage: Storage) -> dict[str, Any]:
    plan = get_json(storage, PLAN_KEY)
    if not isinstance(plan, dict) or plan.get("format") != "webflix.erasure-plan":
        plan = {"format": "webflix.erasure-plan", "formatVersion": 1, "subjects": {}}
    plan.setdefault("subjects", {})
    plan.setdefault("versionsInProgress", [])
    return plan


def save_plan(storage: Storage, plan: dict[str, Any], now_ms: int) -> None:
    plan["updatedAt"] = iso_ms(now_ms)
    put_json(storage, PLAN_KEY, plan)


def _active(plan: dict[str, Any]) -> frozenset[str]:
    return frozenset(plan["subjects"])


def subjects_to_exclude(storage: Storage, pending: Iterable[str] = ()) -> frozenset[str]:
    """Every subject key a dataset or a scoring run must leave out when it starts: what the
    product lists as pending erasure (an erased account and its profiles, a profile newly
    restricted), and what this job's plan still holds (pending, or confirmed and watched)."""
    return frozenset(pending) | frozenset(load_plan(storage)["subjects"])


def unconfirmed(plan: dict[str, Any]) -> list[str]:
    """Keys to confirm: the ones the product gave and the profile keys discovered for them, not
    confirmed yet. The product records an erasure key for the account and for each of its
    profiles but lists only the account's; confirming the discovered profile keys as well (their
    events are gone too, and verified) keeps its profile records from staying pending forever."""
    return sorted(
        key
        for key, entry in plan["subjects"].items()
        if entry.get("kind") in {"subject", "profile"} and entry.get("confirmedAt") is None
    )


def mark_confirmed(storage: Storage, keys: Iterable[str], now_ms: int) -> None:
    """Record that the product confirmed `keys`; their discovered profiles go with them. All
    stay watched until the watch period ends."""
    plan = load_plan(storage)
    confirmed = set(keys)
    for key, entry in plan["subjects"].items():
        if entry.get("confirmedAt") is None and (key in confirmed or entry.get("via") in confirmed):
            entry["confirmedAt"] = iso_ms(now_ms)
    save_plan(storage, plan, now_ms)


# --- Matching -----------------------------------------------------------------------------------


def _line_hit(line: bytes, keys: frozenset[str]) -> tuple[bool, str | None, str | None]:
    """Whether a stored line belongs to an erased subject, with its account and profile."""
    try:
        event = orjson.loads(line)
    except orjson.JSONDecodeError:
        event = None
    subject = event.get("subject") if isinstance(event, dict) else None
    if not isinstance(subject, dict):
        # Not an event we can read: it goes if it mentions a key at all.
        return any(key.encode() in line for key in keys), None, None
    account, profile = subject.get("account"), subject.get("profile")
    account = account if isinstance(account, str) else None
    profile = profile if isinstance(profile, str) else None
    return (account in keys or profile in keys), account, profile


def _ndjson_hits(text: bytes, keys: frozenset[str]) -> bool | None:
    """Fast path: does a decompressed NDJSON body hold a key's event? None: read line by line."""
    try:
        frame = pl.read_ndjson(io.BytesIO(text), schema=_SUBJECT_SCHEMA)
    except Exception:  # any malformed line: the exact per-line path decides
        return None
    if frame.height == 0:
        return False
    subject = frame["subject"]
    wanted = list(keys)
    hits = subject.struct.field("account").is_in(wanted) | subject.struct.field("profile").is_in(
        wanted
    )
    return bool(hits.any())


@dataclass
class Counts:
    values: dict[str, int] = field(default_factory=dict)

    def add(self, name: str, amount: int = 1) -> None:
        self.values[name] = self.values.get(name, 0) + amount

    def merge(self, other: Counts) -> None:
        for name, amount in other.values.items():
            self.add(name, amount)


@dataclass
class ObjectOutcome:
    counts: Counts = field(default_factory=Counts)
    pairs: set[tuple[str, str]] = field(default_factory=set)


def _raw_object(
    storage: Storage, key: str, keys: frozenset[str], mode: str, area: str, out: ObjectOutcome
) -> None:
    """One NDJSON object (raw lake or quarantine) in `discover`, `rewrite` or `verify` mode."""
    body = storage.get(key)
    if body is None:
        return
    text = gzip.decompress(body)
    fast = _ndjson_hits(text, keys) if area == "raw" else None
    if fast is False:
        return
    lines = text.split(b"\n")
    kept: list[bytes] = []
    removed = 0
    for line in lines:
        if not line.strip():
            continue
        hit, account, profile = _line_hit(line, keys)
        if hit:
            removed += 1
            if account in keys and profile is not None:
                out.pairs.add((account, profile))
        else:
            kept.append(line)
    if not removed:
        return
    if mode == "verify":
        out.counts.add(f"remaining.{area}", removed)
        return
    if mode != "rewrite":
        return
    if kept:
        storage.put(key, gzip.compress(b"\n".join(kept) + b"\n", mtime=0))
        out.counts.add(f"{area}.objectsRewritten")
    else:
        storage.delete([key])
        out.counts.add(f"{area}.objectsDeleted")
    out.counts.add(f"{area}.linesRemoved", removed)


def _parquet_hits(body: bytes, keys: frozenset[str]) -> pl.DataFrame:
    frame = pl.read_parquet(io.BytesIO(body), columns=["account", "profile"])
    wanted = list(keys)
    return frame.with_row_index("row").filter(
        pl.col("account").is_in(wanted) | pl.col("profile").is_in(wanted)
    )


def _erase_hour(args: tuple[str, int, frozenset[str], str, int]) -> ObjectOutcome:
    """One hour partition in `discover`, `rewrite` or `verify` mode (process-pool job)."""
    location, hour_ms, keys, mode, now_ms = args
    storage = open_storage(location)
    out = ObjectOutcome()
    hour = relist_hour(storage, hour_ms)
    manifest = read_manifest(storage, hour)
    current, _covered = covered_sources(storage, hour, manifest)
    current_key = current[0].key if current else None
    for info in hour.parquet:
        body = storage.get(info.key)
        if body is None:
            continue
        if info.key != current_key:
            # Not named by the manifest: garbage of an interrupted rewrite (the lease means no
            # compaction is between its write and its flip right now).
            if mode == "rewrite":
                storage.delete([info.key])
                out.counts.add("parquet.orphansDeleted")
            elif mode == "verify" and _parquet_hits(body, keys).height:
                out.counts.add("remaining.parquet", _parquet_hits(body, keys).height)
            continue
        hits = _parquet_hits(body, keys)
        if not hits.height:
            continue
        if mode == "discover":
            for account, profile in hits.select("account", "profile").iter_rows():
                if account in keys and profile is not None:
                    out.pairs.add((account, profile))
            continue
        if mode == "verify":
            out.counts.add("remaining.parquet", hits.height)
            continue
        frame = pl.read_parquet(io.BytesIO(body), columns=["raw"]).with_row_index("row")
        dropped = set(hits["row"].to_list())
        lines = [raw.encode() for row, raw in frame.iter_rows() if row not in dropped]
        rebuilt = compacted_frame(lines)
        new_body = write_compacted(rebuilt, hour_ms)
        assert manifest is not None
        document = manifest_document(
            hour,
            key=parquet_key(hour, new_body),
            body=new_body,
            rows=rebuilt.height,
            sources=list(manifest.get("sources", [])),
            duplicates=int(manifest.get("duplicatesDropped", 0)),
            invalid=int(manifest.get("invalid", 0)),
            erased=int(manifest.get("erased", 0)) + len(dropped),
            compacted_at_ms=parse_iso_ms(str(manifest.get("compactedAt") or iso_ms(now_ms))),
        )
        document["erasedAt"] = iso_ms(now_ms)
        flip(storage, hour, new_body, document)
        out.counts.add("parquet.filesRewritten")
        out.counts.add("parquet.rowsRemoved", len(dropped))
    for info in hour.ndjson:
        _raw_object(storage, info.key, keys, mode, "raw", out)
    return out


def _erase_objects(args: tuple[str, list[str], frozenset[str], str]) -> ObjectOutcome:
    location, object_keys, keys, mode = args
    storage = open_storage(location)
    out = ObjectOutcome()
    for key in object_keys:
        _raw_object(storage, key, keys, mode, "quarantine", out)
    return out


def _map(workers: int, function: Callable[[Any], ObjectOutcome], jobs: list[Any]) -> ObjectOutcome:
    total = ObjectOutcome()
    for outcome in parallel_map(function, jobs, workers=workers):
        total.counts.merge(outcome.counts)
        total.pairs |= outcome.pairs
    return total


def _lake_pass(
    location: str, storage: Storage, keys: frozenset[str], mode: str, workers: int, now_ms: int
) -> ObjectOutcome:
    hours = [hour.hour_ms for hour in list_hours(storage)]
    out = _map(workers, _erase_hour, [(location, hour, keys, mode, now_ms) for hour in hours])
    quarantined = [info.key for info in storage.list(QUARANTINE_PREFIX)]
    batches = [quarantined[i : i + 50] for i in range(0, len(quarantined), 50)]
    rest = _map(workers, _erase_objects, [(location, batch, keys, mode) for batch in batches])
    out.counts.merge(rest.counts)
    out.pairs |= rest.pairs
    return out


# --- Datasets and artefacts ---------------------------------------------------------------------


def _datasets(storage: Storage) -> list[str]:
    return sorted(
        info.key[len(DATASET_PREFIX) :].split("/", 1)[0]
        for info in storage.list(DATASET_PREFIX)
        if info.key.endswith("/manifest.json")
    )


KEY_COLUMNS = ("profile", "account", "profile_key")


def _key_mask(frame: pl.DataFrame, keys: frozenset[str]) -> pl.Series | None:
    """Rows whose subject columns hold one of `keys` (None: the table has no such column)."""
    columns = [name for name in KEY_COLUMNS if name in frame.columns]
    if not columns:
        return None
    wanted = list(keys)
    return frame.select(
        pl.any_horizontal(
            [pl.col(name).cast(pl.String).is_in(wanted).fill_null(False) for name in columns]
        ).alias("hit")
    )["hit"]


def discover_from_datasets(storage: Storage, keys: frozenset[str]) -> set[tuple[str, str]]:
    pairs: set[tuple[str, str]] = set()
    for dataset in _datasets(storage):
        body = storage.get(f"{DATASET_PREFIX}{dataset}/profiles.parquet")
        if body is None:
            continue
        frame = pl.read_parquet(io.BytesIO(body), columns=["profile", "account"])
        for profile, account in frame.filter(pl.col("account").is_in(list(keys))).iter_rows():
            pairs.add((str(account), str(profile)))
    return pairs


def _dataset_pass(storage: Storage, keys: frozenset[str], mode: str, now_ms: int) -> Counts:
    counts = Counts()
    for dataset in _datasets(storage):
        prefix = f"{DATASET_PREFIX}{dataset}/"
        manifest = get_json(storage, prefix + "manifest.json") or {}
        removed = 0
        for info in list(storage.list(prefix)):
            if not info.key.endswith(".parquet"):
                continue
            body = storage.get(info.key)
            if body is None:
                continue
            # The subject columns first (cheap); the whole table only when rows must go.
            names = pl.read_parquet_schema(io.BytesIO(body))
            columns = [name for name in KEY_COLUMNS if name in names]
            if not columns:
                continue
            mask = _key_mask(pl.read_parquet(io.BytesIO(body), columns=columns), keys)
            if mask is None or not mask.any():
                continue
            hits = int(mask.sum())
            if mode == "verify":
                counts.add("remaining.datasets", hits)
                continue
            frame = pl.read_parquet(io.BytesIO(body))
            buffer = io.BytesIO()
            frame.filter(~mask).write_parquet(buffer, compression="zstd")
            storage.put(info.key, buffer.getvalue())
            removed += hits
            name = info.key[len(prefix) :].removesuffix(".parquet")
            if isinstance(manifest.get("rows"), dict) and name in manifest["rows"]:
                manifest["rows"][name] = frame.height - hits
            counts.add("datasets.tablesRewritten")
        if removed:
            erasure = manifest.setdefault("erasure", {"rowsRemoved": 0})
            erasure["rowsRemoved"] = int(erasure.get("rowsRemoved", 0)) + removed
            erasure["lastAt"] = iso_ms(now_ms)
            put_json(storage, prefix + "manifest.json", manifest)
            counts.add("datasets.rowsRemoved", removed)
    return counts


def _file_entry(path: str, frame: pl.DataFrame, body: bytes) -> dict[str, Any]:
    from webflix_recs.provenance import sha256  # noqa: PLC0415

    keys = frame["profile_key"]
    return {
        "rows": frame.height,
        "bytes": len(body),
        "sha256": sha256(body),
        "firstKey": keys[0] if frame.height else None,
        "lastKey": keys[-1] if frame.height else None,
        "path": path,
    }


def _versions(storage: Storage) -> dict[str, list[str]]:
    versions: dict[str, list[str]] = {}
    for info in storage.list(f"{RECS_PREFIX}v="):
        run = info.key[len(RECS_PREFIX) + 2 :].split("/", 1)[0]
        versions.setdefault(run, []).append(info.key)
    return versions


def _artefact_pass(
    storage: Storage, keys: frozenset[str], mode: str, plan: dict[str, Any], now_ms: int
) -> Counts:
    from webflix_recs.artefacts import _parquet  # noqa: PLC0415
    from webflix_recs.provenance import sha256  # noqa: PLC0415

    counts = Counts()
    in_progress: list[str] = plan["versionsInProgress"]
    for run, object_keys in sorted(_versions(storage).items()):
        prefix = f"{RECS_PREFIX}v={run}/"
        shards = sorted(
            k for k in object_keys if k.startswith(prefix + "profiles/") and k.endswith(".parquet")
        )
        hit_shards: dict[str, tuple[pl.DataFrame, pl.Series]] = {}
        for key in shards:
            body = storage.get(key)
            if body is None:
                continue
            frame = pl.read_parquet(io.BytesIO(body))
            if "profile_key" not in frame.columns:
                continue
            mask = frame["profile_key"].is_in(list(keys))
            if mask.any():
                hit_shards[key] = (frame, mask)
        if mode == "verify":
            for _frame, mask in hit_shards.values():
                counts.add("remaining.artefacts", int(mask.sum()))
            continue
        if not hit_shards and run not in in_progress:
            continue
        if run not in in_progress:
            in_progress.append(run)
            save_plan(storage, plan, now_ms)
        for key, (frame, mask) in hit_shards.items():
            storage.put(key, _parquet(frame.filter(~mask)))
            counts.add("artefacts.filesRewritten")
            counts.add("artefacts.profilesRemoved", int(mask.sum()))
        manifest_key = prefix + "manifest.json"
        manifest = get_json(storage, manifest_key)
        if isinstance(manifest, dict):
            # Recomputed from the files as they are now, so a rerun after a crash between a
            # shard write and this manifest write repairs the version.
            profiles = 0
            items = 0
            for entry in manifest.get("files", []):
                if entry.get("table") != "profiles":
                    continue
                body = storage.get(prefix + entry["path"])
                if body is None:
                    continue
                frame = pl.read_parquet(io.BytesIO(body))
                entry.update(_file_entry(entry["path"], frame, body))
                profiles += frame.height
                items += int(frame["items"].sum()) if frame.height else 0
            manifest.setdefault("counts", {}).update(profiles=profiles, profileItems=items)
            put_json(storage, manifest_key, manifest)
            pointer = get_json(storage, POINTER_KEY)
            if isinstance(pointer, dict) and pointer.get("run") == run:
                body = storage.get(manifest_key)
                assert body is not None
                if pointer.get("manifestSha256") != sha256(body):
                    pointer["manifestSha256"] = sha256(body)
                    put_json(storage, POINTER_KEY, pointer)
                    counts.add("artefacts.pointerUpdated")
            counts.add("artefacts.versionsUpdated")
        in_progress.remove(run)
        save_plan(storage, plan, now_ms)
    return counts


def _export_pass(storage: Storage, keys: frozenset[str], mode: str) -> Counts:
    """Exports of a subject's events (exports.py): deleted whole; verified absent."""
    from webflix_recs.exports import EXPORT_PREFIX  # noqa: PLC0415

    counts = Counts()
    outputs: dict[str, list[str]] = {}
    for info in storage.list(EXPORT_PREFIX):
        outputs.setdefault(info.key[len(EXPORT_PREFIX) :].split("/", 1)[0], []).append(info.key)
    for object_keys in outputs.values():
        hit = False
        for key in object_keys:
            body = storage.get(key) or b""
            if key.endswith(".gz"):
                body = gzip.decompress(body)
            if any(subject.encode() in body for subject in keys):
                hit = True
                break
        if not hit:
            continue
        if mode == "verify":
            counts.add("remaining.exports")
        elif mode == "rewrite":
            storage.delete(object_keys)
            counts.add("exports.deleted")
    return counts


# --- The operation ------------------------------------------------------------------------------


@dataclass
class EraseOutcome:
    given: list[str]
    active: int
    discovered_profiles: int
    counts: dict[str, int]
    to_confirm: list[str]
    forgotten: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "keysGiven": len(self.given),
            "subjectsActive": self.active,
            "profilesDiscovered": self.discovered_profiles,
            "forgottenAfterWatch": self.forgotten,
            "rewritten": self.counts,
            "verified": True,
            "toConfirm": self.to_confirm,
        }


def erase(
    location: str,
    keys: Iterable[str],
    *,
    now_ms: int | None = None,
    watch_days: int = DEFAULT_WATCH_DAYS,
    workers: int = 1,
    take_lease: bool = True,
    log: Callable[[str], object] = print,
) -> EraseOutcome:
    """Erase `keys` (and keys still pending or watched in the plan) from the store, verify,
    and return what to confirm. Raises `ErasureIncomplete` if verification fails."""
    from webflix_recs.lease import lake_lease  # noqa: PLC0415

    now = int(time.time() * 1000) if now_ms is None else now_ms
    storage = open_storage(location)
    given = sorted(set(keys))
    if take_lease:
        with lake_lease(storage, "erase"):
            return erase(
                location, given, now_ms=now, watch_days=watch_days, workers=workers,
                take_lease=False, log=log,
            )  # fmt: skip
    plan = load_plan(storage)
    subjects: dict[str, dict[str, Any]] = plan["subjects"]
    forgotten = [
        key
        for key, entry in subjects.items()
        if entry.get("confirmedAt")
        and parse_iso_ms(entry["confirmedAt"]) + watch_days * DAY_MS <= now
    ]
    for key in forgotten:
        del subjects[key]
    for key in given:
        entry = subjects.setdefault(key, {"kind": "subject", "addedAt": iso_ms(now)})
        entry["kind"] = "subject"
        entry.setdefault("confirmedAt", None)
        if entry["confirmedAt"] is not None:
            entry["confirmedAt"] = None  # listed again by the product: confirm again
    active = _active(plan)
    if not active:
        save_plan(storage, plan, now)
        return EraseOutcome(given, 0, 0, {}, [], len(forgotten))
    log(f"erase: {len(given)} keys given, {len(active)} subjects active; discovering profiles")
    pairs = _lake_pass(location, storage, active, "discover", workers, now).pairs
    pairs |= discover_from_datasets(storage, active)
    discovered = 0
    for account, profile in sorted(pairs):
        if profile not in subjects:
            subjects[profile] = {
                "kind": "profile",
                "via": account,
                "addedAt": iso_ms(now),
                "confirmedAt": subjects.get(account, {}).get("confirmedAt"),
            }
            discovered += 1
    # Persisted before anything is rewritten: a rerun after any failure knows every key.
    save_plan(storage, plan, now)
    active = _active(plan)
    log(f"erase: {discovered} profile keys discovered; rewriting the lake")
    counts = Counts()
    counts.merge(_lake_pass(location, storage, active, "rewrite", workers, now).counts)
    log("erase: rewriting datasets and artefacts")
    counts.merge(_dataset_pass(storage, active, "rewrite", now))
    counts.merge(_artefact_pass(storage, active, "rewrite", plan, now))
    counts.merge(_export_pass(storage, active, "rewrite"))
    log("erase: verifying")
    remaining = Counts()
    remaining.merge(_lake_pass(location, storage, active, "verify", workers, now).counts)
    remaining.merge(_dataset_pass(storage, active, "verify", now))
    remaining.merge(_artefact_pass(storage, active, "verify", plan, now))
    remaining.merge(_export_pass(storage, active, "verify"))
    leftovers = {k.removeprefix("remaining."): v for k, v in remaining.values.items() if v}
    if leftovers:
        raise ErasureIncomplete(leftovers)
    return EraseOutcome(
        given,
        len(active),
        discovered,
        dict(sorted(counts.values.items())),
        unconfirmed(plan),
        len(forgotten),
    )


def parse_keys(text: str) -> list[str]:
    """Keys from a file: the staff API's answer (`{"subjectKeys": [...]}`), a JSON list, or one
    key per line."""
    stripped = text.strip()
    if not stripped:
        return []
    if stripped[0] in "[{":
        document = orjson.loads(stripped)
        values = document.get("subjectKeys", []) if isinstance(document, dict) else document
        return [str(value) for value in values]
    return [line.strip() for line in stripped.splitlines() if line.strip()]


__all__ = [
    "COMPACTION_MANIFEST",
    "EVENTS_PREFIX",
    "PLAN_KEY",
    "EraseOutcome",
    "ErasureIncomplete",
    "HourObjects",
    "erase",
    "load_plan",
    "mark_confirmed",
    "parse_keys",
    "unconfirmed",
]
