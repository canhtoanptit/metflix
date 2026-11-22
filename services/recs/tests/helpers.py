"""Test helpers: a small synthetic catalogue (hermetic unit tests) and event builders."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np

from webflix_recs.catalog import Catalog
from webflix_recs.ids import DAY_MS, iso_ms

GENRES = [
    "drama",
    "comedy",
    "thriller",
    "sci-fi",
    "kids-family",
    "animation",
    "documentary",
    "horror",
]
MOODS = ["Dark", "Witty", "Tense", "Heartfelt", "Epic", "Quirky"]
ANCHOR_MS = 1_790_000_000_000 - 1_790_000_000_000 % DAY_MS


def synthetic_catalog_document(
    titles: int = 40, seed: int = 1, anchor_ms: int = ANCHOR_MS
) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    levels = ["ALL", "7+", "13+", "16+", "18+"]
    genres = [
        {"id": f"g-{name}", "slug": name, "name": name.title(), "position": i}
        for i, name in enumerate(GENRES)
    ]
    people = [{"id": f"p-{i}", "name": f"Person {i}"} for i in range(30)]
    items = []
    for i in range(titles):
        series = bool(i % 3 == 0)
        kids = i % 7 == 0
        genre_ids = (
            ["g-kids-family", "g-animation"]
            if kids
            else [f"g-{GENRES[int(rng.integers(0, 4))]}", f"g-{GENRES[int(rng.integers(0, 8))]}"]
        )
        genre_ids = list(dict.fromkeys(genre_ids))
        episodes = (
            [
                {
                    "id": f"t-{i}-e{j + 1}",
                    "seasonNumber": 1,
                    "number": j + 1,
                    "seq": j + 1,
                    "runtimeSec": 1800,
                }
                for j in range(4)
            ]
            if series
            else []
        )
        items.append(
            {
                "id": f"t-{i}",
                "type": "series" if series else "movie",
                "name": f"Title {i}",
                "tagline": None,
                "synopsis": (
                    f"A story about {GENRES[i % len(GENRES)]} and "
                    f"{MOODS[i % len(MOODS)].lower()} people number {i}."
                ),
                "releaseYear": 2010 + i % 15,
                "maturity": "ALL" if kids else levels[2 + i % 3],
                "genreIds": genre_ids,
                "moods": [MOODS[i % len(MOODS)], MOODS[(i + 2) % len(MOODS)]],
                "isOriginal": i % 4 == 0,
                "addedAt": iso_ms(anchor_ms - int(1 + (i * 37) % 300) * DAY_MS),
                "popularity": float(30 + (i * 13) % 65),
                "runtimeSec": None if series else 5400,
                "episodes": episodes,
                "credits": [
                    {"personId": f"p-{(i * 3) % 30}", "role": "director", "position": 0},
                    {"personId": f"p-{(i * 5 + 1) % 30}", "role": "cast", "position": 0},
                    {"personId": f"p-{(i * 7 + 2) % 30}", "role": "cast", "position": 1},
                ],
            }
        )
    content = {
        "seedVersion": 1,
        "anchor": iso_ms(anchor_ms),
        "maturityLevels": levels,
        "genres": genres,
        "people": people,
        "titles": items,
    }
    version = hashlib.sha256(
        json.dumps(content, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()[:16]
    return {
        "format": "webflix.catalog-snapshot",
        "formatVersion": 1,
        "catalogVersion": version,
        **content,
    }


def synthetic_catalog(titles: int = 40, seed: int = 1, anchor_ms: int = ANCHOR_MS) -> Catalog:
    return Catalog.from_document(synthetic_catalog_document(titles, seed, anchor_ms))


_COUNTER = [0]


def make_event(
    kind: str,
    occurred_ms: int,
    *,
    received_ms: int | None = None,
    profile: str | None = "P" * 22,
    account: str = "A" * 22,
    title: str = "t-1",
    restricted: bool = False,
    personalisation: bool = True,
    analytics: bool = True,
    device: str = "dev-1",
    event_id: str | None = None,
    row_rank: int | None = None,
    rank: int | None = None,
    **payload: Any,
) -> dict[str, Any]:
    """A valid envelope (validated) for tests. Client types get a device and sequence."""
    from webflix_recs import schemas
    from webflix_recs.ids import uuid7

    _COUNTER[0] += 1
    server = kind in schemas.SERVER_TYPES
    body: dict[str, Any]
    if kind.startswith("playback."):
        body = {
            "playbackSessionId": payload.pop("playback", f"pb-{title}"),
            "titleId": title,
            "episodeId": None,
            "positionSec": payload.pop("position", 600.0),
            "durationSec": payload.pop("duration", 5400.0),
            "watchedSec": payload.pop("watched", 600.0),
        }
        if kind == "playback.abandon":
            body["reason"] = "closed"
    elif kind == "impression":
        body = {"titleId": title, "sampleRate": 1.0}
    elif kind == "rating.set":
        body = {"titleId": title, "value": payload.pop("value", "like")}
    elif kind == "consent.change":
        body = {"purpose": "personalisation", "granted": personalisation, "source": "settings"}
    elif kind in {"experiment.exposure", "billing.transition", "auth.signin", "auth.signup"}:
        body = {}
    else:
        body = {"titleId": title}
    body.update(payload)
    event = {
        "eventId": event_id or uuid7(occurred_ms, _COUNTER[0] * 7919 + 13),
        "type": kind,
        "version": 1,
        "source": "server" if server else "client",
        "occurredAt": iso_ms(occurred_ms),
        "receivedAt": iso_ms(received_ms if received_ms is not None else occurred_ms + 200),
        "deviceId": None if server else device,
        "sessionSeq": None if server else _COUNTER[0],
        "app": {"platform": "server" if server else "web", "version": "2.0.0"},
        "context": {
            "surface": "home" if kind in {"impression", "title.open"} else None,
            "rowId": "home:trending" if kind in {"impression", "title.open"} else None,
            "rowRank": row_rank if row_rank is not None else (3 if kind == "impression" else None),
            "rank": rank if rank is not None else (2 if kind == "impression" else None),
            "experiments": {},
            "policy": {"id": "test", "explore": False} if kind == "impression" else None,
        },
        "subject": {
            "account": account,
            "profile": profile,
            "plan": "standard",
            "country": "GB",
            "restricted": restricted,
            "consent": {"analytics": analytics, "personalisation": personalisation},
        },
        "payload": body,
    }
    schemas.validate_event(event)
    return event


def write_lake(storage: Any, events: list[dict[str, Any]], name: str = "batch") -> None:
    """One gzip NDJSON object per receipt hour, as the ingestion consumer would write."""
    import gzip
    from collections import defaultdict

    import orjson

    from webflix_recs.ids import parse_iso_ms, partition_prefix

    hours: dict[str, list[bytes]] = defaultdict(list)
    for event in events:
        hours[partition_prefix(parse_iso_ms(event["receivedAt"]))].append(orjson.dumps(event))
    for prefix, lines in hours.items():
        storage.put(f"{prefix}{name}.ndjson.gz", gzip.compress(b"\n".join(lines) + b"\n"))


def put_catalog(storage: Any, document: dict[str, Any]) -> None:
    from webflix_recs.storage import put_json

    body = json.dumps(document).encode() + b"\n"
    key = f"catalog/v={document['catalogVersion']}/snapshot.json"
    storage.put(key, body)
    put_json(
        storage,
        "catalog/current.json",
        {
            "format": "webflix.catalog-pointer",
            "formatVersion": 1,
            "catalogVersion": document["catalogVersion"],
            "key": key,
            "sha256": hashlib.sha256(body).hexdigest(),
            "anchor": document["anchor"],
        },
    )


def write_version(
    storage: Any, run: str, profiles: dict[str, list[str]], *, publish: bool = True
) -> dict[str, Any]:
    """A small artefact version that `artefacts.validate_version` accepts (neighbours and one
    profiles shard), optionally pointed at by `recs/current.json`."""
    import orjson

    from webflix_recs import artefacts
    from webflix_recs.provenance import sha256
    from webflix_recs.storage import get_json, put_json

    prefix = f"recs/v={run}/"
    neighbours = artefacts._frame(
        "neighbours",
        {"title_id": ["t-1"], "rank": [1], "neighbour_id": ["t-2"], "score": [0.5], "support": [3]},
    )
    files = []
    body = artefacts._parquet(neighbours)
    storage.put(prefix + "neighbours/part-00000.parquet", body)
    files.append(
        artefacts._file_entry(
            "neighbours/part-00000.parquet", "neighbours", neighbours, body, "title_id"
        )
    )
    keys = sorted(profiles, key=lambda k: k.encode())
    payloads = [
        orjson.dumps(
            {
                "v": 1,
                "profile": key,
                "run": run,
                "generatedAt": "2026-10-01T00:00:00.000Z",
                "expiresAt": "2026-10-04T00:00:00.000Z",
                "rows": [
                    {
                        "type": "personal",
                        "param": None,
                        "items": [[t, 0.9 - i / 100] for i, t in enumerate(profiles[key])],
                    }
                ],
            }
        ).decode()
        for key in keys
    ]
    frame = artefacts._frame(
        "profiles",
        {
            "profile_key": keys,
            "payload": payloads,
            "items": [len(profiles[k]) for k in keys],
            "bytes": [len(p.encode()) for p in payloads],
        },
    )
    body = artefacts._parquet(frame)
    storage.put(prefix + "profiles/part-00000.parquet", body)
    files.append(
        artefacts._file_entry("profiles/part-00000.parquet", "profiles", frame, body, "profile_key")
    )
    manifest = {
        "format": "webflix.recs",
        "formatVersion": 1,
        "formatMinor": 0,
        "run": run,
        "recipeHash": "0123456789abcdef",
        "createdAt": "2026-10-01T00:00:00.000Z",
        "asOf": "2026-10-01T00:00:00.000Z",
        "expiresAt": "2026-10-04T00:00:00.000Z",
        "catalogVersion": "test",
        "code": {},
        "data": {},
        "evaluation": None,
        "counts": {
            "profiles": len(keys),
            "titles": 2,
            "neighbourRows": 1,
            "profileItems": sum(len(v) for v in profiles.values()),
        },
        "rowTypes": list(artefacts.ROW_TYPES),
        "tables": artefacts.TABLES,
        "files": files,
    }
    put_json(storage, prefix + "manifest.json", manifest)
    if publish:
        previous = get_json(storage, artefacts.POINTER_KEY)
        put_json(
            storage,
            artefacts.POINTER_KEY,
            {
                "format": "webflix.recs-pointer",
                "formatVersion": 1,
                "run": run,
                "manifest": prefix + "manifest.json",
                "manifestSha256": sha256(storage.get(prefix + "manifest.json") or b""),
                "publishedAt": "2026-10-01T01:00:00.000Z",
                "previous": previous["run"] if previous else None,
                "gate": None,
            },
        )
    return manifest
