"""The provisional event schema and the catalogue snapshot format."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from helpers import synthetic_catalog_document
from webflix_recs import schemas
from webflix_recs.catalog import Catalog, CatalogError

EVENT = json.loads((Path(__file__).parent / "fixtures" / "event.json").read_text())


def mutate(path: list[str], value: Any) -> dict[str, Any]:
    event: dict[str, Any] = copy.deepcopy(EVENT)
    target = event
    for part in path[:-1]:
        target = target[part]
    if value is KeyError:
        del target[path[-1]]
    else:
        target[path[-1]] = value
    return event


def test_a_valid_event_passes() -> None:
    schemas.validate_event(EVENT)


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (["eventId"], "not-a-uuid"),
        (["eventId"], "0199a2b4-6f00-4a1b-8c2d-3e4f5a6b7c8d"),  # a v4, not a v7
        (["type"], "playback.rewind"),
        (["source"], "client"),  # playback events come from the server
        (["occurredAt"], "2026-10-01 05:12:03"),
        (["subject", "restricted"], KeyError),
        (["subject", "consent", "personalisation"], "yes"),
        (["payload", "titleId"], KeyError),
        (["payload", "durationSec"], 0),
        (["payload", "extra"], 1),
        (["context", "rank"], 0),
        (["unexpected"], True),
    ],
)
def test_invalid_events_are_rejected_with_a_reason(path: list[str], value: Any) -> None:
    event = mutate(path, value)
    assert not schemas.is_valid_event(event)
    assert schemas.event_errors(event)


def test_vocabulary_comes_from_the_schema() -> None:
    assert "playback.start" in schemas.SERVER_TYPES
    assert "impression" in schemas.CLIENT_TYPES
    assert set(schemas.EVENT_TYPES) == schemas.SERVER_TYPES | schemas.CLIENT_TYPES


def test_catalogue_snapshot_is_validated_and_its_version_checked() -> None:
    document = synthetic_catalog_document(10)
    catalog = Catalog.from_document(document)
    assert len(catalog) == 10
    tampered = copy.deepcopy(document)
    tampered["titles"][0]["popularity"] = 99
    with pytest.raises(CatalogError, match="does not match its version"):
        Catalog.from_document(tampered)
    broken = copy.deepcopy(document)
    del broken["titles"][0]["genreIds"]
    with pytest.raises(schemas.SchemaError):
        Catalog.from_document(broken)
