"""The catalogue snapshot (format: schemas/catalog-snapshot.schema.json) as arrays.

Produced by `scripts/export-catalog.ts` from @webflix/catalog and stored at
`catalog/v={version}/snapshot.json` behind the pointer `catalog/current.json`.
"""

from __future__ import annotations

import hashlib
import json
import unicodedata
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt

from webflix_recs import schemas
from webflix_recs.ids import parse_iso_ms
from webflix_recs.storage import Storage, get_json

POINTER_KEY = "catalog/current.json"
# docs/RECOMMENDATIONS.md, "Content features": the milestone 1 engine's weights. Used here for a
# model-independent similarity (diversity metric) and by the simulator's stand-in policy.
_GENRE_WEIGHTS = (1.0, 0.8, 0.6)
_GENRE_WEIGHT_REST = 0.5
_MOOD_WEIGHT = 0.5
_ROLE_WEIGHTS = {"director": 0.6, "creator": 0.6, "writer": 0.3}
_LEAD_CAST_WEIGHT = 0.4
_CAST_WEIGHT = 0.2
_TYPE_WEIGHT = 0.3
_ERA_WEIGHT = 0.15
_ORIGINAL_WEIGHT = 0.1


class CatalogError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Episode:
    id: str
    season_number: int
    number: int
    seq: int
    runtime_sec: int


@dataclass(frozen=True, slots=True)
class Credit:
    person_id: str
    role: str
    position: int


@dataclass(frozen=True, slots=True)
class Title:
    index: int
    id: str
    type: str
    name: str
    tagline: str | None
    synopsis: str
    release_year: int
    maturity: str
    maturity_rank: int
    genre_ids: tuple[str, ...]
    moods: tuple[str, ...]
    is_original: bool
    added_at_ms: int
    popularity: float
    runtime_sec: int | None
    episodes: tuple[Episode, ...]
    credits: tuple[Credit, ...]

    @property
    def is_series(self) -> bool:
        return self.type == "series"

    @property
    def total_runtime_sec(self) -> int:
        if self.runtime_sec is not None:
            return self.runtime_sec
        return sum(episode.runtime_sec for episode in self.episodes)


def _normalise_text(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(char for char in decomposed if not unicodedata.combining(char)).strip()


@dataclass
class Catalog:
    version: str
    anchor_ms: int
    maturity_levels: tuple[str, ...]
    genres: tuple[dict[str, Any], ...]
    people: dict[str, str]
    titles: tuple[Title, ...]
    raw: dict[str, Any] = field(repr=False)

    @classmethod
    def from_document(cls, document: dict[str, Any], *, verify_version: bool = True) -> Catalog:
        schemas.validate("catalog-snapshot", document)
        if verify_version:
            content = {
                key: document[key]
                for key in ("seedVersion", "anchor", "maturityLevels", "genres", "people", "titles")
            }
            canonical = json.dumps(content, separators=(",", ":"), ensure_ascii=False)
            digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]
            if digest != document["catalogVersion"]:
                raise CatalogError(
                    f"catalog snapshot content does not match its version "
                    f"({document['catalogVersion']} declared, {digest} computed)"
                )
        levels = tuple(document["maturityLevels"])
        rank = {level: index for index, level in enumerate(levels)}
        titles = []
        for index, raw in enumerate(document["titles"]):
            if raw["maturity"] not in rank:
                raise CatalogError(f"title {raw['id']}: unknown maturity {raw['maturity']}")
            titles.append(
                Title(
                    index=index,
                    id=raw["id"],
                    type=raw["type"],
                    name=raw["name"],
                    tagline=raw["tagline"],
                    synopsis=raw["synopsis"],
                    release_year=int(raw["releaseYear"]),
                    maturity=raw["maturity"],
                    maturity_rank=rank[raw["maturity"]],
                    genre_ids=tuple(raw["genreIds"]),
                    moods=tuple(raw["moods"]),
                    is_original=bool(raw["isOriginal"]),
                    added_at_ms=parse_iso_ms(raw["addedAt"]),
                    popularity=float(raw["popularity"]),
                    runtime_sec=raw["runtimeSec"],
                    episodes=tuple(
                        Episode(e["id"], e["seasonNumber"], e["number"], e["seq"], e["runtimeSec"])
                        for e in raw["episodes"]
                    ),
                    credits=tuple(
                        Credit(c["personId"], c["role"], c["position"]) for c in raw["credits"]
                    ),
                )
            )
        ids = [title.id for title in titles]
        if len(set(ids)) != len(ids):
            raise CatalogError("duplicate title ids")
        genre_ids = {genre["id"] for genre in document["genres"]}
        for title in titles:
            unknown = set(title.genre_ids) - genre_ids
            if unknown:
                raise CatalogError(f"title {title.id}: unknown genres {sorted(unknown)}")
            if title.is_series and not title.episodes:
                raise CatalogError(f"series {title.id} has no episodes")
        return cls(
            version=document["catalogVersion"],
            anchor_ms=parse_iso_ms(document["anchor"]),
            maturity_levels=levels,
            genres=tuple(document["genres"]),
            people={person["id"]: person["name"] for person in document["people"]},
            titles=tuple(titles),
            raw=document,
        )

    # --- lookups ----------------------------------------------------------------------------

    @cached_property
    def index(self) -> dict[str, int]:
        return {title.id: title.index for title in self.titles}

    @cached_property
    def genre_index(self) -> dict[str, int]:
        return {genre["id"]: position for position, genre in enumerate(self.genres)}

    @cached_property
    def episode_owner(self) -> dict[str, tuple[int, Episode]]:
        return {
            episode.id: (title.index, episode)
            for title in self.titles
            for episode in title.episodes
        }

    def __len__(self) -> int:
        return len(self.titles)

    @property
    def ids(self) -> list[str]:
        return [title.id for title in self.titles]

    @cached_property
    def added_at(self) -> npt.NDArray[np.int64]:
        return np.array([title.added_at_ms for title in self.titles], dtype=np.int64)

    @cached_property
    def popularity(self) -> npt.NDArray[np.float64]:
        return np.array([title.popularity for title in self.titles], dtype=np.float64)

    @cached_property
    def maturity_rank(self) -> npt.NDArray[np.int64]:
        return np.array([title.maturity_rank for title in self.titles], dtype=np.int64)

    @cached_property
    def is_series(self) -> npt.NDArray[np.bool_]:
        return np.array([title.is_series for title in self.titles], dtype=bool)

    @cached_property
    def is_original(self) -> npt.NDArray[np.bool_]:
        return np.array([title.is_original for title in self.titles], dtype=bool)

    @cached_property
    def genre_matrix(self) -> npt.NDArray[np.float64]:
        """T x G: the engine's genre weights by relevance order (1.0, 0.8, 0.6, then 0.5)."""
        matrix = np.zeros((len(self.titles), len(self.genres)))
        for title in self.titles:
            for order, genre_id in enumerate(title.genre_ids):
                weight = (
                    _GENRE_WEIGHTS[order] if order < len(_GENRE_WEIGHTS) else _GENRE_WEIGHT_REST
                )
                matrix[title.index, self.genre_index[genre_id]] = weight
        return matrix

    @cached_property
    def genre_membership(self) -> npt.NDArray[np.bool_]:
        return self.genre_matrix > 0

    @cached_property
    def mood_vocabulary(self) -> tuple[str, ...]:
        return tuple(sorted({_normalise_text(m) for title in self.titles for m in title.moods}))

    @cached_property
    def mood_matrix(self) -> npt.NDArray[np.float64]:
        index = {mood: position for position, mood in enumerate(self.mood_vocabulary)}
        matrix = np.zeros((len(self.titles), len(index)))
        for title in self.titles:
            for mood in title.moods:
                matrix[title.index, index[_normalise_text(mood)]] = 1.0
        return matrix

    @cached_property
    def engine_features(self) -> npt.NDArray[np.float64]:
        """T x F content features with the milestone 1 engine's weights, L2-normalised rows.

        Mirrors `titleFeatures` in packages/core (a reimplementation used only as a fixed,
        model-independent similarity space: the diversity metric and the simulator's stand-in
        logging policy; the rule-engine baseline itself is the real TypeScript engine).
        """
        return self._engine_features[0]

    @cached_property
    def engine_feature_index(self) -> dict[str, int]:
        """Column of each engine feature (`g:<genreId>`, `m:<mood>`, `p:<personId>`, ...)."""
        return self._engine_features[1]

    @cached_property
    def _engine_features(self) -> tuple[npt.NDArray[np.float64], dict[str, int]]:
        keys: dict[str, int] = {}
        rows: list[dict[int, float]] = []
        for title in self.titles:
            raw: dict[str, float] = {}

            def add(name: str, weight: float, raw: dict[str, float] = raw) -> None:
                raw[name] = max(raw.get(name, 0.0), weight)

            for order, genre_id in enumerate(title.genre_ids):
                add(f"g:{genre_id}", _GENRE_WEIGHTS[order] if order < 3 else _GENRE_WEIGHT_REST)
            for mood in title.moods:
                add(f"m:{_normalise_text(mood)}", _MOOD_WEIGHT)
            for credit in title.credits:
                if credit.role == "cast":
                    weight = _LEAD_CAST_WEIGHT if credit.position < 3 else _CAST_WEIGHT
                else:
                    weight = _ROLE_WEIGHTS[credit.role]
                add(f"p:{credit.person_id}", weight)
            add(f"t:{title.type}", _TYPE_WEIGHT)
            add(f"e:{title.release_year // 10 * 10}", _ERA_WEIGHT)
            if title.is_original:
                add("o:original", _ORIGINAL_WEIGHT)
            row = {}
            for name, weight in raw.items():
                row[keys.setdefault(name, len(keys))] = weight
            rows.append(row)
        matrix = np.zeros((len(self.titles), len(keys)))
        for position, row in enumerate(rows):
            for column, weight in row.items():
                matrix[position, column] = weight
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        return matrix / np.where(norms == 0, 1.0, norms), keys

    @cached_property
    def engine_similarity(self) -> npt.NDArray[np.float64]:
        features = self.engine_features
        similarity: npt.NDArray[np.float64] = features @ features.T
        return similarity

    def available_mask(self, at_ms: int) -> npt.NDArray[np.bool_]:
        """Titles that have arrived by `at_ms`."""
        return self.added_at <= at_ms


def load_catalog(storage: Storage, *, key: str | None = None) -> Catalog:
    """The catalogue the pointer names (or a given snapshot key), verified."""
    if key is None:
        pointer = get_json(storage, POINTER_KEY)
        if pointer is None:
            raise CatalogError(
                f"no catalogue pointer at {POINTER_KEY} in {storage.describe()}: run "
                "`node services/recs/scripts/export-catalog.ts --store <dir>` first"
            )
        key = str(pointer["key"])
        body = storage.get(key)
        if body is None:
            raise CatalogError(f"catalogue pointer names a missing snapshot: {key}")
        if hashlib.sha256(body).hexdigest() != pointer["sha256"]:
            raise CatalogError(f"catalogue snapshot {key} does not match the pointer's sha256")
    else:
        body = storage.get(key)
        if body is None:
            raise CatalogError(f"missing catalogue snapshot: {key}")
    return Catalog.from_document(json.loads(body))


def load_catalog_file(path: str | Path) -> Catalog:
    return Catalog.from_document(json.loads(Path(path).read_text(encoding="utf-8")))
