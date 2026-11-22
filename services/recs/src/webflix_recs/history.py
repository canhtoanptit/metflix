"""What the platform knew about every eligible profile at a knowledge cutoff, as dense arrays.

`History.build(dataset, catalog, as_of_ms)` rebuilds the state at any cutoff up to the dataset's
own `as_of` from the dataset tables, using only rows *received* before the cutoff. Training,
evaluation and scoring all go through it, so they agree on what a profile had watched.

Implicit feedback strength (blueprint §7.1: watch fraction, completion, rating and list actions,
with time decay), per profile and title:

    watch   = movie:  0.3 + 1.2 * watched fraction + 0.5 * completed   (needs >= 30 s watched)
              series: min(3, 0.3 + 0.25 * episodes started + 0.15 * episodes completed)
    list    = +0.8 while the title is in My List
    rating  = love +2, like +1; a dislike sets the strength to 0 and marks a negative
    decay   = max(0.2, 0.5 ^ (days since the last interaction / 60))
    strength = decay * (watch + list + rating)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import numpy.typing as npt
import polars as pl

from webflix_recs import schemas as ev
from webflix_recs.catalog import Catalog
from webflix_recs.dataset import QUALIFIED_PLAY_SEC, DatasetResult
from webflix_recs.ids import DAY_MS

HALF_LIFE_DAYS = 60.0
DECAY_FLOOR = 0.2
COMPLETION_RATIO = 0.95
REPETITION_DAYS = 14

Array = npt.NDArray[Any]


class LeakError(RuntimeError):
    """A stage was asked to use data from at or after its knowledge cutoff."""


@dataclass
class History:
    as_of_ms: int
    catalog: Catalog
    profiles: list[str]
    index: dict[str, int]
    strength: npt.NDArray[np.float32]  # P x T
    negative: npt.NDArray[np.bool_]  # disliked
    watched: npt.NDArray[np.bool_]  # a qualified play (>= 30 s)
    started: npt.NDArray[np.bool_]  # anything played (samples included)
    finished: npt.NDArray[np.bool_]  # movie completed / series finale completed
    in_list: npt.NDArray[np.bool_]
    opened: npt.NDArray[np.float32]  # title opens
    last_time: npt.NDArray[np.int64]  # ms of the last interaction, 0 if none
    repetition: npt.NDArray[
        np.float32
    ]  # impressions without a play, last 14 days, sampling-corrected
    first_seen: npt.NDArray[np.int64]
    plays: npt.NDArray[np.float32]  # qualified plays per profile
    series_share: npt.NDArray[np.float32]
    title_plays_7d: npt.NDArray[np.float32]  # T, qualified plays by eligible profiles
    title_plays_28d: npt.NDArray[np.float32]
    title_profiles: npt.NDArray[np.float32]  # T, distinct profiles with a qualified play (all time)
    max_received_ms: int | None
    tables: dict[str, pl.DataFrame]

    @property
    def shape(self) -> tuple[int, int]:
        rows, columns = self.strength.shape
        return rows, columns

    @property
    def available(self) -> npt.NDArray[np.bool_]:
        return self.catalog.available_mask(self.as_of_ms)

    def tenure_days(self) -> npt.NDArray[np.float64]:
        return np.maximum(0.0, (self.as_of_ms - self.first_seen) / DAY_MS)

    def rows(self, keys: list[str]) -> npt.NDArray[np.int64]:
        return np.array([self.index[key] for key in keys], dtype=np.int64)

    @classmethod
    def build(
        cls,
        dataset: DatasetResult,
        catalog: Catalog,
        as_of_ms: int,
        *,
        profiles: list[str] | None = None,
        allow_future: bool = False,
    ) -> History:
        """State at `as_of_ms` from the dataset rows received before it.

        Refuses (`LeakError`) a cutoff after the dataset's own: the dataset cannot know what was
        received later, so pretending it does would silently truncate. `allow_future` exists
        only so the leak test can build a deliberately leaky history.
        """
        if as_of_ms > dataset.manifest["asOfMs"] and not allow_future:
            raise LeakError(
                f"history at {as_of_ms} requested from dataset {dataset.dataset_id}, "
                f"known only until {dataset.manifest['asOfMs']}"
            )
        known = pl.col("received_at") < as_of_ms
        playback = dataset.tables["playback"].filter(known)
        actions = dataset.tables["actions"].filter(known)
        impressions = (
            dataset.tables["impressions"].filter(known) if "impressions" in dataset.tables else None
        )
        profile_table = dataset.tables["profiles"]
        if profiles is None:
            seen = pl.concat(
                [playback.select("profile"), actions.select("profile")], how="vertical"
            ).unique()
            profiles = sorted(
                set(seen["profile"].to_list()) & set(profile_table["profile"].to_list())
            )
        index = {key: row for row, key in enumerate(profiles)}
        p, t = len(profiles), len(catalog)
        title_index = catalog.index
        profile_map = pl.DataFrame({"profile": profiles, "p": np.arange(p, dtype=np.int64)})
        title_map = pl.DataFrame({"title_id": catalog.ids, "t": np.arange(t, dtype=np.int64)})
        del title_index

        def located(frame: pl.DataFrame) -> pl.DataFrame:
            return frame.join(profile_map, on="profile", how="inner").join(
                title_map, on="title_id", how="inner"
            )

        strength = np.zeros((p, t), dtype=np.float32)
        watched = np.zeros((p, t), dtype=bool)
        started = np.zeros((p, t), dtype=bool)
        finished = np.zeros((p, t), dtype=bool)
        in_list = np.zeros((p, t), dtype=bool)
        negative = np.zeros((p, t), dtype=bool)
        opened = np.zeros((p, t), dtype=np.float32)
        last_time = np.zeros((p, t), dtype=np.int64)
        repetition = np.zeros((p, t), dtype=np.float32)

        # --- playback: per playback session, then per profile and title ----------------------
        sessions = (
            located(playback)
            .group_by(["p", "t", "playback_id"])
            .agg(
                pl.col("episode_id").first(),
                pl.col("watched_sec").max().alias("watched"),
                (pl.col("position_sec") / pl.col("duration_sec")).max().alias("fraction"),
                (
                    (pl.col("type") == ev.PLAYBACK_COMPLETE)
                    | (pl.col("position_sec") >= COMPLETION_RATIO * pl.col("duration_sec"))
                )
                .any()
                .alias("complete"),
                pl.col("event_time").max().alias("last"),
                pl.col("event_time").min().alias("first"),
            )
        )
        finales = pl.DataFrame(
            {
                "t": [title.index for title in catalog.titles if title.is_series],
                "finale": [title.episodes[-1].id for title in catalog.titles if title.is_series],
            },
            schema={"t": pl.Int64, "finale": pl.String},
        )
        per_title = sessions.group_by(["p", "t"]).agg(
            (pl.col("watched") >= QUALIFIED_PLAY_SEC).sum().alias("plays"),
            pl.col("watched").sum().alias("watched_sec"),
            pl.col("fraction").max().alias("fraction"),
            pl.col("complete").any().alias("completed"),
            pl.col("episode_id")
            .filter((pl.col("watched") >= QUALIFIED_PLAY_SEC) | pl.col("complete"))
            .n_unique()
            .alias("episodes_started"),
            pl.col("episode_id").filter(pl.col("complete")).n_unique().alias("episodes_completed"),
            pl.col("last").max(),
            pl.col("first").min(),
        )
        pi = per_title["p"].to_numpy()
        ti = per_title["t"].to_numpy()
        plays = per_title["plays"].to_numpy()
        fraction = np.clip(per_title["fraction"].fill_null(0.0).to_numpy(), 0.0, 1.0)
        completed = per_title["completed"].to_numpy()
        ep_started = per_title["episodes_started"].to_numpy()
        ep_completed = per_title["episodes_completed"].to_numpy()
        last = per_title["last"].to_numpy()
        series = catalog.is_series[ti]
        qualified = plays > 0
        watched[pi, ti] = qualified
        started[pi, ti] = True
        watch_strength = np.where(
            series,
            np.minimum(3.0, 0.3 + 0.25 * ep_started + 0.15 * ep_completed),
            0.3 + 1.2 * fraction + 0.5 * completed,
        )
        watch_strength = np.where(qualified | completed, watch_strength, 0.0)
        strength[pi, ti] += watch_strength.astype(np.float32)
        # Finished: a completed movie, or a series whose last episode was completed.
        finished[pi, ti] = completed & ~series
        series_done = (
            sessions.filter(pl.col("complete"))
            .join(finales, on="t", how="inner")
            .filter(pl.col("episode_id") == pl.col("finale"))
            .select("p", "t")
            .unique()
        )
        finished[series_done["p"].to_numpy(), series_done["t"].to_numpy()] = True
        last_time[pi, ti] = np.maximum(last_time[pi, ti], last)

        # --- actions: final list and rating state, opens ---------------------------------------
        acts = located(actions).sort("event_time")
        lists = (
            acts.filter(pl.col("type").is_in([ev.LIST_ADD, ev.LIST_REMOVE]))
            .group_by(["p", "t"])
            .agg(pl.col("type").last().alias("last_type"), pl.col("event_time").last().alias("at"))
        )
        listed = lists.filter(pl.col("last_type") == ev.LIST_ADD)
        lp, lt = listed["p"].to_numpy(), listed["t"].to_numpy()
        in_list[lp, lt] = True
        strength[lp, lt] += 0.8
        last_time[lp, lt] = np.maximum(last_time[lp, lt], listed["at"].to_numpy())
        ratings = (
            acts.filter(pl.col("type").is_in([ev.RATING_SET, ev.RATING_CLEAR]))
            .group_by(["p", "t"])
            .agg(
                pl.col("type").last().alias("last_type"),
                pl.col("value").last().alias("value"),
                pl.col("event_time").last().alias("at"),
            )
            .filter(pl.col("last_type") == ev.RATING_SET)
        )
        for value, bonus in (("love", 2.0), ("like", 1.0)):
            chosen = ratings.filter(pl.col("value") == value)
            rp, rt = chosen["p"].to_numpy(), chosen["t"].to_numpy()
            strength[rp, rt] += bonus
            last_time[rp, rt] = np.maximum(last_time[rp, rt], chosen["at"].to_numpy())
        disliked = ratings.filter(pl.col("value") == "dislike")
        negative[disliked["p"].to_numpy(), disliked["t"].to_numpy()] = True
        opens = (
            acts.filter(pl.col("type") == ev.TITLE_OPEN)
            .group_by(["p", "t"])
            .agg(pl.len().alias("n"))
        )
        opened[opens["p"].to_numpy(), opens["t"].to_numpy()] = opens["n"].to_numpy()

        age_days = np.maximum(0, as_of_ms - last_time) / DAY_MS
        decay = np.maximum(DECAY_FLOOR, 0.5 ** (age_days / HALF_LIFE_DAYS)).astype(np.float32)
        strength = np.where(negative, 0.0, strength * decay).astype(np.float32)

        if impressions is not None and impressions.height:
            recent = (
                located(
                    impressions.filter(
                        (pl.col("event_time") >= as_of_ms - REPETITION_DAYS * DAY_MS)
                        & ~pl.col("started")
                    )
                )
                .group_by(["p", "t"])
                .agg((1.0 / pl.col("sample_rate")).sum().alias("n"))
            )
            repetition[recent["p"].to_numpy(), recent["t"].to_numpy()] = recent["n"].to_numpy()

        info = profile_table.join(profile_map, on="profile", how="inner").sort("p")
        first_seen = np.full(p, as_of_ms, dtype=np.int64)
        first = (
            located(playback).group_by("p").agg(pl.col("event_time").min())
            if playback.height
            else None
        )
        if first is not None:
            first_seen[first["p"].to_numpy()] = first["event_time"].to_numpy()
        acts_first = acts.group_by("p").agg(pl.col("event_time").min())
        if acts_first.height:
            rows = acts_first["p"].to_numpy()
            first_seen[rows] = np.minimum(first_seen[rows], acts_first["event_time"].to_numpy())
        del info
        profile_plays = watched.sum(axis=1).astype(np.float32)
        series_share = np.where(
            profile_plays > 0,
            (watched & catalog.is_series[None, :]).sum(axis=1) / np.maximum(profile_plays, 1),
            0.5,
        ).astype(np.float32)

        # --- title popularity among eligible profiles ------------------------------------------
        qualified_sessions = sessions.filter(pl.col("watched") >= QUALIFIED_PLAY_SEC)
        title_plays_7d = np.zeros(t, dtype=np.float32)
        title_plays_28d = np.zeros(t, dtype=np.float32)
        for days, target in ((7, title_plays_7d), (28, title_plays_28d)):
            counts = (
                qualified_sessions.filter(pl.col("first") >= as_of_ms - days * DAY_MS)
                .group_by("t")
                .agg(pl.len().alias("n"))
            )
            target[counts["t"].to_numpy()] = counts["n"].to_numpy()
        title_profiles = watched.sum(axis=0).astype(np.float32)
        max_received: int | None = None
        for frame in (playback, actions):
            if frame.height:
                received = int(frame["received_at"].to_numpy().max())
                max_received = received if max_received is None else max(max_received, received)
        if (
            max_received is not None and max_received >= as_of_ms and not allow_future
        ):  # pragma: no cover
            raise LeakError("history read a row received at or after its cutoff")
        return cls(
            as_of_ms=as_of_ms,
            catalog=catalog,
            profiles=profiles,
            index=index,
            strength=strength,
            negative=negative,
            watched=watched,
            started=started,
            finished=finished,
            in_list=in_list,
            opened=opened,
            last_time=last_time,
            repetition=repetition,
            first_seen=first_seen,
            plays=profile_plays,
            series_share=series_share,
            title_plays_7d=title_plays_7d,
            title_plays_28d=title_plays_28d,
            title_profiles=title_profiles,
            max_received_ms=max_received,
            tables={"playback": playback, "actions": actions},
        )


def targets(
    dataset: DatasetResult,
    catalog: Catalog,
    start_ms: int,
    end_ms: int,
    profiles: list[str],
    *,
    search_only: bool = False,
) -> dict[str, dict[int, float]]:
    """What each profile went on to watch in [start, end): title index -> graded gain.

    Gain 1 for a qualified play (>= 30 s), 2 if an item of it was completed; a title counts once
    per profile. With `search_only`, only plays the member reached through search (a search
    click on the title in the 30 minutes before the play started): titles they sought out,
    whatever the rows happened to show them.
    """
    playback = dataset.tables["playback"].filter(
        (pl.col("event_time") >= start_ms) & (pl.col("event_time") < end_ms)
    )
    wanted = pl.DataFrame({"profile": profiles})
    sessions = (
        playback.join(wanted, on="profile", how="semi")
        .group_by(["profile", "title_id", "playback_id"])
        .agg(
            pl.col("watched_sec").max().alias("watched"),
            (pl.col("type") == ev.PLAYBACK_COMPLETE).any().alias("complete"),
            pl.col("event_time").min().alias("start"),
        )
    )
    if search_only:
        clicks = (
            dataset.tables["actions"]
            .filter(
                (pl.col("type") == ev.SEARCH_CLICK)
                & (pl.col("event_time") >= start_ms - 30 * 60_000)
            )
            .select("profile", "title_id", pl.col("event_time").alias("click"))
            .sort("click")
        )
        sessions = (
            sessions.sort("start")
            .join_asof(
                clicks,
                left_on="start",
                right_on="click",
                by=["profile", "title_id"],
                strategy="backward",
                tolerance=30 * 60_000,
                check_sortedness=False,
            )
            .filter(pl.col("click").is_not_null())
        )
    grouped = (
        sessions.group_by(["profile", "title_id"])
        .agg(
            (pl.col("watched") >= QUALIFIED_PLAY_SEC).any().alias("qualified"),
            pl.col("complete").any().alias("complete"),
        )
        .filter(pl.col("qualified"))
    )
    out: dict[str, dict[int, float]] = {}
    index = catalog.index
    for profile, title, complete in grouped.select("profile", "title_id", "complete").iter_rows():
        if title in index:
            out.setdefault(profile, {})[index[title]] = 2.0 if complete else 1.0
    return out
