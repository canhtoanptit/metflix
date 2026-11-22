"""Producing the milestone 1 rule engine's rankings for the evaluated profiles.

The harness writes each profile's library signals as of the cutoff (what the engine reads from
the database: My List, ratings, progress records) and the playback views behind Trending and
Top 10, then runs `scripts/rule-engine-rankings.ts`, which calls the real `Personalization`
class from @webflix/core. No part of the engine is reimplemented here.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Any

import orjson
import polars as pl

from webflix_recs import schemas as ev
from webflix_recs.catalog import Catalog
from webflix_recs.history import History
from webflix_recs.ids import DAY_MS, iso_ms, utc_day

SCRIPTS = Path(__file__).resolve().parents[3] / "scripts"
COMPLETION_RATIO = 0.95
VIEW_SEC = 60.0


class RuleEngineUnavailable(RuntimeError):
    pass


def engine_input(history: History, catalog: Catalog, profiles: list[str], path: Path) -> None:
    as_of = history.as_of_ms
    playback = history.tables["playback"]
    actions = history.tables["actions"]
    wanted = pl.DataFrame({"profile": profiles})
    # Views: a profile credited with >= 60 s of a title on a UTC day (the engine's definition),
    # over the 14 days before the cutoff.
    recent = playback.filter(pl.col("event_time") >= as_of - 14 * DAY_MS)
    sessions = (
        recent.group_by(["profile", "title_id", "playback_id"])
        .agg(
            pl.col("watched_sec").max().alias("watched"), pl.col("event_time").min().alias("start")
        )
        .with_columns((pl.col("start") // DAY_MS * DAY_MS).alias("day_ms"))
    )
    views = (
        sessions.group_by(["profile", "title_id", "day_ms"])
        .agg(pl.col("watched").sum())
        .filter(pl.col("watched") >= VIEW_SEC)
        .group_by(["day_ms", "title_id"])
        .agg(pl.len().alias("views"))
        .sort(["day_ms", "title_id"])
    )
    header = {
        "format": "webflix.rule-engine-input",
        "formatVersion": 1,
        "asOf": iso_ms(as_of),
        "catalogAnchor": catalog.raw["anchor"],
        "catalogVersion": catalog.version,
        "titles": [{"id": t["id"], "addedAt": t["addedAt"]} for t in catalog.raw["titles"]],
        "views": [
            {"day": utc_day(day), "titleId": title, "views": int(n)}
            for day, title, n in views.iter_rows()
        ],
        "limit": len(catalog),
    }
    mine = actions.join(wanted, on="profile", how="semi").sort("event_time")
    lists = (
        mine.filter(pl.col("type").is_in([ev.LIST_ADD, ev.LIST_REMOVE]))
        .group_by(["profile", "title_id"])
        .agg(pl.col("type").last(), pl.col("event_time").last())
        .filter(pl.col("type") == ev.LIST_ADD)
    )
    ratings = (
        mine.filter(pl.col("type").is_in([ev.RATING_SET, ev.RATING_CLEAR]))
        .group_by(["profile", "title_id"])
        .agg(pl.col("type").last(), pl.col("value").last(), pl.col("event_time").last())
        .filter(pl.col("type") == ev.RATING_SET)
    )
    items = (
        playback.join(wanted, on="profile", how="semi")
        .with_columns(pl.coalesce("episode_id", "title_id").alias("item_id"))
        .sort("event_time")
        .group_by(["profile", "item_id"])
        .agg(
            pl.col("title_id").last(),
            pl.col("episode_id").last(),
            pl.col("position_sec").last(),
            pl.col("duration_sec").last(),
            (pl.col("type").last() == ev.PLAYBACK_COMPLETE).alias("completed"),
            pl.col("event_time").last().alias("updated_at"),
        )
    )
    by_profile: dict[str, dict[str, list[dict[str, Any]]]] = {
        p: {"myList": [], "ratings": [], "progress": []} for p in profiles
    }
    for profile, title, _, at in lists.iter_rows():
        by_profile[profile]["myList"].append({"titleId": title, "addedAt": int(at)})
    for profile, title, _, value, at in ratings.iter_rows():
        by_profile[profile]["ratings"].append(
            {"titleId": title, "value": value, "ratedAt": int(at)}
        )
    for profile, item, title, episode, position, duration, completed, at in items.iter_rows():
        by_profile[profile]["progress"].append(
            {
                "itemId": item,
                "titleId": title,
                "episodeId": episode,
                "positionSec": float(position),
                "durationSec": float(duration),
                "completed": bool(completed or position >= COMPLETION_RATIO * duration),
                "updatedAt": int(at),
            }
        )
    with path.open("wb") as handle:
        handle.write(orjson.dumps(header) + b"\n")
        for profile in profiles:
            # Every evaluated profile is unrestricted, hence the default ceiling.
            line = {"profileKey": profile, "maturityCeiling": "18+", **by_profile[profile]}
            handle.write(orjson.dumps(line) + b"\n")


def run_rule_engine(
    history: History, catalog: Catalog, profiles: list[str], work: Path
) -> dict[str, Path]:
    node = shutil.which("node")
    script = SCRIPTS / "rule-engine-rankings.ts"
    if node is None or not script.exists():
        raise RuleEngineUnavailable(
            "Node.js and services/recs/scripts/rule-engine-rankings.ts are needed to rank with the "
            "rule engine; pass its rankings with --external rule-engine=<file> instead"
        )
    work.mkdir(parents=True, exist_ok=True)
    source = work / "engine-input.ndjson"
    engine_input(history, catalog, profiles, source)
    completed = subprocess.run(
        [node, str(script), "--input", str(source), "--out-dir", str(work)],
        capture_output=True,
        text=True,
        check=False,
        timeout=3600,
    )
    if completed.returncode != 0:
        raise RuleEngineUnavailable(f"rule engine failed: {completed.stderr.strip()[-2000:]}")
    return {
        "rule-engine": work / "rule-engine.ndjson",
        "rule-engine-home": work / "rule-engine-home.ndjson",
    }
