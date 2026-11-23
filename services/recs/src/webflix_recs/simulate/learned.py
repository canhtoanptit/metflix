"""A scored run, as the simulated platform serves it to the treatment arm of a `served=learned`
experiment (config.ExperimentSpec): its neighbours and each profile's lists, read from the
version `score` wrote (`recs/v={run}/`), by title index.

The lists are the run's, generated as of its cutoff; the simulated platform does not score
again during the experiment (the product scores daily and serves rules once a run's lists have
expired). What a stale run still adapts is what the engine adapts with it: the session boost of
neighbours of titles watched since the lists were made, and the rules (finished, started,
disliked titles leave every row).
"""

from __future__ import annotations

import io
from typing import Any

import orjson
import polars as pl

from webflix_recs.catalog import Catalog
from webflix_recs.ids import parse_iso_ms
from webflix_recs.simulate.policy import LearnedProfile
from webflix_recs.storage import get_json, open_storage


class LearnedRun:
    def __init__(self, store: str, run: str, catalog: Catalog) -> None:
        storage = open_storage(store)
        prefix = f"recs/v={run}/"
        manifest: dict[str, Any] | None = get_json(storage, prefix + "manifest.json")
        if manifest is None:
            raise ValueError(f"{prefix}manifest.json is missing: score the run first")
        self.run = run
        self.generated_ms = parse_iso_ms(manifest["asOf"])
        index = catalog.index
        self.neighbours: dict[int, list[tuple[int, float]]] = {}
        self._payloads: dict[str, str] = {}
        for entry in manifest["files"]:
            body = storage.get(prefix + entry["path"]) or b""
            frame = pl.read_parquet(io.BytesIO(body))
            if entry["table"] == "neighbours":
                for title, neighbour, score in frame.select(
                    "title_id", "neighbour_id", "score"
                ).iter_rows():
                    if title in index and neighbour in index:
                        self.neighbours.setdefault(index[title], []).append(
                            (index[neighbour], float(score))
                        )
            elif entry["table"] == "profiles":
                self._payloads.update(
                    zip(frame["profile_key"].to_list(), frame["payload"].to_list(), strict=True)
                )
        self._index = index
        self._cache: dict[str, LearnedProfile] = {}

    def profile(self, key: str) -> LearnedProfile:
        """The profile's lists (empty when the run did not score it: neighbours only)."""
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        learned = LearnedProfile(generated_ms=self.generated_ms)
        payload = self._payloads.get(key)
        if payload is not None:
            index = self._index
            for row in orjson.loads(payload)["rows"]:
                items = [index[title] for title, _ in row["items"] if title in index]
                if row["type"] == "personal":
                    scores = [float(score) for title, score in row["items"] if title in index]
                    learned.personal = dict(zip(items, scores, strict=True))
                    learned.percentile = {
                        title: 1.0 - rank / max(1, len(items)) for rank, title in enumerate(items)
                    }
                elif row["type"] == "top-picks":
                    learned.top_picks = items
                elif row["type"] == "billboard":
                    learned.billboard = items
                elif row["type"] == "because-you-watched" and row["param"] in index:
                    learned.because[index[row["param"]]] = items
        self._cache[key] = learned
        return learned
