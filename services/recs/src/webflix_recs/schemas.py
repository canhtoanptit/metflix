"""The one place that knows the event schema and the other document formats.

`packages/contracts` owns the event schema: `schemas/event.schema.json` is generated from its zod
definitions (`packages/contracts/src/events.ts`, `pnpm --filter @webflix/contracts generate`; a
contracts test fails while the file is stale) and must never be edited here. The other JSON
Schema files under `services/recs/schemas/` are this pipeline's own document formats. Every other
module reaches all of them through this module only: the event types, the validators and the
columnar projection the lake reader uses. The event vocabulary below (types, sources, row kinds,
version) is read from the generated schema, so a contract change reaches the pipeline without a
code change here unless a field the projection reads is renamed.
"""

from __future__ import annotations

import functools
import json
from importlib import resources
from pathlib import Path
from typing import Any, Final

import jsonschema_rs
import polars as pl

# --- Locating and compiling schemas -------------------------------------------------------------

_DOCUMENT_SCHEMAS: Final = {
    "event": "event.schema.json",
    "catalog-snapshot": "catalog-snapshot.schema.json",
    "recs-manifest": "recs-manifest.schema.json",
    "recs-pointer": "recs-pointer.schema.json",
    "recs-profile-lists": "recs-profile-lists.schema.json",
    "rankings-header": "rankings-header.schema.json",
    "rankings-line": "rankings-line.schema.json",
    "experiment-definitions": "experiment-definitions.schema.json",
    "experiment-report": "experiment-report.schema.json",
    "experiment-result": "experiment-result.schema.json",
    "experiment-results-pointer": "experiment-results-pointer.schema.json",
    "events-compaction": "events-compaction.schema.json",
    "export-events-requests": "export-events-requests.schema.json",
    "export-events-manifest": "export-events-manifest.schema.json",
    "export-events-results": "export-events-results.schema.json",
}


class SchemaError(ValueError):
    """A document does not match its schema. `errors` holds the first few messages."""

    def __init__(self, name: str, errors: list[str]) -> None:
        super().__init__(f"{name}: " + "; ".join(errors))
        self.name = name
        self.errors = errors


def schema_dir() -> Path:
    """The schema files: packaged next to the code in a wheel, or the repository's directory."""
    packaged = resources.files("webflix_recs").joinpath("_schemas")
    if packaged.is_dir():
        return Path(str(packaged))
    return Path(__file__).resolve().parents[2] / "schemas"


@functools.cache
def load_schema(name: str) -> dict[str, Any]:
    path = schema_dir() / _DOCUMENT_SCHEMAS[name]
    with path.open(encoding="utf-8") as handle:
        schema: dict[str, Any] = json.load(handle)
    return schema


@functools.cache
def _validator(name: str) -> Any:
    return jsonschema_rs.validator_for(load_schema(name))


def is_valid(name: str, document: object) -> bool:
    return bool(_validator(name).is_valid(document))


def validate(name: str, document: object, *, max_errors: int = 5) -> None:
    """Raise `SchemaError` unless `document` matches the named schema."""
    validator = _validator(name)
    if validator.is_valid(document):
        return
    errors: list[str] = []
    for error in validator.iter_errors(document):
        path = "/".join(str(part) for part in error.instance_path)
        errors.append(f"{path or '<root>'}: {error.message}")
        if len(errors) >= max_errors:
            break
    raise SchemaError(name, errors)


def is_valid_event(event: object) -> bool:
    return bool(_validator("event").is_valid(event))


def validate_event(event: object) -> None:
    validate("event", event)


def event_errors(event: object, *, max_errors: int = 3) -> list[str]:
    try:
        validate("event", event, max_errors=max_errors)
    except SchemaError as error:
        return error.errors
    return []


# --- Event vocabulary (read from the schema, so the schema stays the single source) ----------


def _event_enum() -> tuple[str, ...]:
    return tuple(load_schema("event")["$defs"]["eventType"]["enum"])


EVENT_TYPES: Final[tuple[str, ...]] = _event_enum()
EVENT_VERSION: Final[int] = int(load_schema("event")["properties"]["version"]["const"])

SERVER_TYPES: Final[frozenset[str]] = frozenset(
    name
    for name, rule in load_schema("event")["$defs"]["dispatch"].items()
    if rule["then"]["properties"]["source"]["const"] == "server"
)
CLIENT_TYPES: Final[frozenset[str]] = frozenset(EVENT_TYPES) - SERVER_TYPES

IMPRESSION: Final = "impression"
ROW_VIEW: Final = "row.view"
TITLE_OPEN: Final = "title.open"
SEARCH_QUERY: Final = "search.query"
SEARCH_CLICK: Final = "search.click"
LIST_ADD: Final = "list.add"
LIST_REMOVE: Final = "list.remove"
RATING_SET: Final = "rating.set"
RATING_CLEAR: Final = "rating.clear"
SIGNUP_STEP: Final = "signup.step"
PLAYBACK_START: Final = "playback.start"
PLAYBACK_PROGRESS: Final = "playback.progress"
PLAYBACK_COMPLETE: Final = "playback.complete"
PLAYBACK_ABANDON: Final = "playback.abandon"
BILLING_TRANSITION: Final = "billing.transition"
AUTH_SIGNUP: Final = "auth.signup"
AUTH_SIGNIN: Final = "auth.signin"
EXPOSURE: Final = "experiment.exposure"
CONSENT_CHANGE: Final = "consent.change"

PLAYBACK_TYPES: Final = frozenset(
    {PLAYBACK_START, PLAYBACK_PROGRESS, PLAYBACK_COMPLETE, PLAYBACK_ABANDON}
)
ACTION_TYPES: Final = frozenset(
    {TITLE_OPEN, SEARCH_CLICK, LIST_ADD, LIST_REMOVE, RATING_SET, RATING_CLEAR}
)

ROW_KINDS: Final[tuple[str, ...]] = tuple(
    load_schema("event")["$defs"]["payloads"]["row.view"]["properties"]["rowKind"]["enum"]
)

for _name in (
    IMPRESSION, ROW_VIEW, TITLE_OPEN, SEARCH_QUERY, SEARCH_CLICK, LIST_ADD, LIST_REMOVE,
    RATING_SET, RATING_CLEAR, SIGNUP_STEP, PLAYBACK_START, PLAYBACK_PROGRESS, PLAYBACK_COMPLETE,
    PLAYBACK_ABANDON, BILLING_TRANSITION, AUTH_SIGNUP, AUTH_SIGNIN, EXPOSURE, CONSENT_CHANGE,
):  # fmt: skip
    if _name not in EVENT_TYPES:  # pragma: no cover - guards the constants against schema drift
        raise RuntimeError(f"event type {_name!r} is missing from event.schema.json")

# --- Columnar projection --------------------------------------------------------------------
#
# The subset of every event the pipeline reads, as a Polars schema. Missing fields read as null
# (a payload only carries its own type's fields). Fields not listed here are ignored by the
# reader, which is what lets the schema grow without touching the pipeline.

EVENT_PROJECTION: Final[dict[str, Any]] = {
    "eventId": pl.String,
    "type": pl.String,
    "version": pl.Int64,
    "source": pl.String,
    "occurredAt": pl.String,
    "receivedAt": pl.String,
    "deviceId": pl.String,
    "sessionSeq": pl.Int64,
    "context": pl.Struct(
        {
            "surface": pl.String,
            "rowId": pl.String,
            "rowRank": pl.Int64,
            "rank": pl.Int64,
            "policy": pl.Struct({"id": pl.String, "explore": pl.Boolean}),
        }
    ),
    "subject": pl.Struct(
        {
            "account": pl.String,
            "profile": pl.String,
            "plan": pl.String,
            "country": pl.String,
            "restricted": pl.Boolean,
            "consent": pl.Struct({"analytics": pl.Boolean, "personalisation": pl.Boolean}),
        }
    ),
    "payload": pl.Struct(
        {
            "titleId": pl.String,
            "episodeId": pl.String,
            "playbackSessionId": pl.String,
            "positionSec": pl.Float64,
            "durationSec": pl.Float64,
            "watchedSec": pl.Float64,
            "value": pl.String,
            "sampleRate": pl.Float64,
            "rowKind": pl.String,
            "itemCount": pl.Int64,
            "experimentKey": pl.String,
            "variant": pl.String,
            "unitType": pl.String,
            "from": pl.String,
            "to": pl.String,
            "planId": pl.String,
            "reason": pl.String,
            "resultRank": pl.Int64,
            "purpose": pl.String,
            "granted": pl.Boolean,
            "source": pl.String,
        }
    ),
}

TIMESTAMP_FORMAT: Final = "%Y-%m-%dT%H:%M:%S%.3fZ"


def flatten_projection(frame: pl.DataFrame) -> pl.DataFrame:
    """Nested projection -> one flat, typed frame with epoch-millisecond times.

    Column names: envelope fields in snake_case, `ctx_*`, `subject_*`, `consent_*`, and payload
    fields without prefix (`title_id`, `position_sec`, ...).
    """

    def ms(column: str) -> pl.Expr:
        return (
            pl.col(column)
            .str.to_datetime(TIMESTAMP_FORMAT, time_zone="UTC", time_unit="ms")
            .dt.epoch("ms")
        )

    context = pl.col("context")
    subject = pl.col("subject")
    payload = pl.col("payload")
    return frame.select(
        pl.col("eventId").alias("event_id"),
        pl.col("type"),
        pl.col("version"),
        pl.col("source"),
        ms("occurredAt").alias("occurred_at"),
        ms("receivedAt").alias("received_at"),
        pl.col("deviceId").alias("device_id"),
        pl.col("sessionSeq").alias("session_seq"),
        context.struct.field("surface").alias("ctx_surface"),
        context.struct.field("rowId").alias("ctx_row_id"),
        context.struct.field("rowRank").alias("ctx_row_rank"),
        context.struct.field("rank").alias("ctx_rank"),
        context.struct.field("policy").struct.field("id").alias("ctx_policy"),
        context.struct.field("policy").struct.field("explore").alias("ctx_explore"),
        subject.struct.field("account").alias("account"),
        subject.struct.field("profile").alias("profile"),
        subject.struct.field("plan").alias("plan"),
        subject.struct.field("country").alias("country"),
        subject.struct.field("restricted").alias("restricted"),
        subject.struct.field("consent").struct.field("analytics").alias("consent_analytics"),
        subject.struct.field("consent")
        .struct.field("personalisation")
        .alias("consent_personalisation"),
        payload.struct.field("titleId").alias("title_id"),
        payload.struct.field("episodeId").alias("episode_id"),
        payload.struct.field("playbackSessionId").alias("playback_id"),
        payload.struct.field("positionSec").alias("position_sec"),
        payload.struct.field("durationSec").alias("duration_sec"),
        payload.struct.field("watchedSec").alias("watched_sec"),
        payload.struct.field("value").alias("value"),
        payload.struct.field("sampleRate").alias("sample_rate"),
        payload.struct.field("rowKind").alias("row_kind"),
        payload.struct.field("itemCount").alias("item_count"),
        payload.struct.field("experimentKey").alias("experiment_key"),
        payload.struct.field("variant").alias("variant"),
        payload.struct.field("unitType").alias("unit_type"),
        payload.struct.field("from").alias("state_from"),
        payload.struct.field("to").alias("state_to"),
        payload.struct.field("planId").alias("plan_id"),
        payload.struct.field("reason").alias("reason"),
        payload.struct.field("resultRank").alias("result_rank"),
        payload.struct.field("purpose").alias("consent_purpose"),
        payload.struct.field("granted").alias("consent_granted"),
        payload.struct.field("source").alias("consent_source"),
    )


FLAT_EVENT_SCHEMA: Final[dict[str, Any]] = {
    "event_id": pl.String,
    "type": pl.String,
    "version": pl.Int64,
    "source": pl.String,
    "occurred_at": pl.Int64,
    "received_at": pl.Int64,
    "device_id": pl.String,
    "session_seq": pl.Int64,
    "ctx_surface": pl.String,
    "ctx_row_id": pl.String,
    "ctx_row_rank": pl.Int64,
    "ctx_rank": pl.Int64,
    "ctx_policy": pl.String,
    "ctx_explore": pl.Boolean,
    "account": pl.String,
    "profile": pl.String,
    "plan": pl.String,
    "country": pl.String,
    "restricted": pl.Boolean,
    "consent_analytics": pl.Boolean,
    "consent_personalisation": pl.Boolean,
    "title_id": pl.String,
    "episode_id": pl.String,
    "playback_id": pl.String,
    "position_sec": pl.Float64,
    "duration_sec": pl.Float64,
    "watched_sec": pl.Float64,
    "value": pl.String,
    "sample_rate": pl.Float64,
    "row_kind": pl.String,
    "item_count": pl.Int64,
    "experiment_key": pl.String,
    "variant": pl.String,
    "unit_type": pl.String,
    "state_from": pl.String,
    "state_to": pl.String,
    "plan_id": pl.String,
    "reason": pl.String,
    "result_rank": pl.Int64,
    "consent_purpose": pl.String,
    "consent_granted": pl.Boolean,
    "consent_source": pl.String,
}
