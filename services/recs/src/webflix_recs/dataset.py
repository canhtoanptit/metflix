"""`build-dataset`: the event lake -> the interaction tables the models train on.

Rules, in order (each one counted in the dataset manifest):

1. Knowledge time. Only events *received* before `as_of` are read: that is what the platform
   knew at that instant, so a backtest at `as_of` cannot see the future, late arrivals
   included.
2. Validation. Every event is validated against the event schema; invalid ones are counted and
   skipped (lake.py).
3. Deduplication by `eventId` (delivery is at least once), keeping the earliest receipt.
4. Event time. Server events keep `occurredAt`. Client clocks are corrected per device by the
   median offset between `occurredAt` and `receivedAt` over that device's events (a skewed
   device clock shifts every event of the device; an offline device delays some sessions,
   which the median ignores), then clamped to receipt. Client events more than 7 days older
   than their receipt are dropped as stale.
5. Eligibility. Every event flagged `restricted` is dropped. A profile whose *latest* event is
   restricted (now a kids or capped profile), or whose account's latest consent stamp (on any
   event of the account, `consent.change` included) lacks `personalisation`, is dropped
   entirely, history included. Signed-out events and events at the profile gate (no profile)
   are dropped.
6. Tables (Parquet, `recs-work/datasets/{id}/`): `playback`, `actions`, `impressions` (with
   play labels), `profiles`, `accounts`; every row keeps `received_at` so later stages can
   rebuild any earlier knowledge cutoff from one dataset.
"""

from __future__ import annotations

import functools
import io
import time
from dataclasses import dataclass
from typing import Any

import polars as pl

from webflix_recs import schemas as ev
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.lake import read_events
from webflix_recs.storage import Storage, get_json, put_json

DATASET_PREFIX = "recs-work/datasets/"
STALE_AFTER_MS = 7 * DAY_MS
SKEW_THRESHOLD_MS = 120_000
SKEW_WINDOW_MS = 12 * 3_600_000
#: An impression is labelled opened/played when that card is opened (and the title played)
#: within this window.
LABEL_WINDOW_MS = 30 * 60_000
#: Impressions of one module closer than this belong to the same showing of the row.
SHOWING_GAP_MS = 30_000
#: A play counts once this much was watched (shorter plays are samples, as in the engine).
QUALIFIED_PLAY_SEC = 30.0

TABLES = ("playback", "actions", "impressions", "profiles", "accounts")
_COMMON = ["eid_hi", "eid_lo", "received_at", "occurred_at", "profile"]
_PLAYBACK = pl.Enum(sorted(ev.PLAYBACK_TYPES))
_ACTIONS = pl.Enum(sorted(ev.ACTION_TYPES))
_ROW_KINDS = pl.Enum(list(ev.ROW_KINDS))


def event_key_columns() -> list[pl.Expr]:
    """`eventId` (a UUID) as two unsigned 64-bit integers: exact, and 16 bytes instead of 36
    characters per row, which is what keeps the full-size dataset build in a few gigabytes."""
    hexed = pl.col("event_id").str.replace_all("-", "", literal=True)
    return [
        hexed.str.slice(0, 16).str.to_integer(base=16, dtype=pl.UInt64).alias("eid_hi"),
        hexed.str.slice(16, 16).str.to_integer(base=16, dtype=pl.UInt64).alias("eid_lo"),
    ]


def event_key(event_id: str) -> tuple[int, int]:
    hexed = event_id.replace("-", "")
    return int(hexed[:16], 16), int(hexed[16:], 16)


def _slim(frame: pl.DataFrame, as_of_ms: int, titles: tuple[str, ...]) -> dict[str, pl.DataFrame]:
    """Runs in the reader processes: keep what was known at `as_of_ms`, split the flat events
    by use and keep only the needed columns, in compact types."""
    frame = frame.filter(pl.col("received_at") < as_of_ms)
    restricted = pl.col("restricted").fill_null(False)
    state = (
        frame.filter(pl.col("profile").is_not_null())
        .sort("received_at")
        .group_by("profile")
        .agg(
            pl.col("account").last(),
            pl.col("received_at").max().alias("latest_received"),
            restricted.last().alias("latest_restricted"),
            pl.col("plan").last(),
            pl.col("country").last(),
            pl.len().alias("events"),
        )
    )
    # Consent belongs to the account: its latest stamp on any event of the account (including
    # account-level events such as consent.change and billing, which carry no profile).
    consent = (
        frame.filter(pl.col("account").is_not_null())
        .sort("received_at")
        .group_by("account")
        .agg(
            pl.col("received_at").max().alias("latest_received"),
            pl.col("consent_personalisation").last().alias("latest_personalisation"),
        )
    )
    # Clock offsets of client devices: median (occurredAt - receivedAt) per device in this batch,
    # ignoring gaps of 12 hours or more (offline delays, not clock error).
    skew = (
        frame.filter((pl.col("source") == "client") & pl.col("device_id").is_not_null())
        .select(
            pl.col("device_id").hash().alias("device"),
            (pl.col("occurred_at") - pl.col("received_at")).alias("delta"),
        )
        .filter(pl.col("delta").abs() < SKEW_WINDOW_MS)
        .group_by("device")
        .agg(pl.col("delta").median().alias("median"), pl.len().alias("n"))
    )
    keep = frame.filter(pl.col("profile").is_not_null() & ~restricted).with_columns(
        *event_key_columns(),
        pl.col("title_id").cast(pl.Enum(titles), strict=False).alias("title"),
        pl.col("device_id").hash().alias("device"),
    )
    unknown = keep.filter(pl.col("title_id").is_not_null() & pl.col("title").is_null()).height
    keep = keep.filter(pl.col("title_id").is_null() | pl.col("title").is_not_null())
    return {
        "state": state,
        "consent": consent,
        "skew": skew,
        "unknown": pl.DataFrame({"titles": [unknown]}),
        "playback": keep.filter(pl.col("type").is_in(list(ev.PLAYBACK_TYPES))).select(
            *_COMMON,
            pl.col("type").cast(_PLAYBACK),
            "title",
            "episode_id",
            pl.col("playback_id").hash().alias("playback_id"),
            pl.col("position_sec").cast(pl.Float32),
            pl.col("duration_sec").cast(pl.Float32),
            pl.col("watched_sec").cast(pl.Float32),
        ),
        "actions": keep.filter(pl.col("type").is_in(list(ev.ACTION_TYPES))).select(
            *_COMMON,
            "device",
            pl.col("type").cast(_ACTIONS),
            "title",
            "value",
            pl.col("ctx_surface").alias("surface"),
            pl.col("ctx_row_rank").cast(pl.Int16).alias("row_rank"),
            pl.col("ctx_rank").cast(pl.Int16).alias("rank"),
        ),
        "impressions": keep.filter(pl.col("type") == ev.IMPRESSION).select(
            *_COMMON,
            "device",
            "title",
            pl.col("ctx_row_id")
            .str.split(":")
            .list.get(1, null_on_oob=True)
            .cast(_ROW_KINDS, strict=False)
            .alias("row_kind"),
            pl.col("ctx_row_rank").cast(pl.Int16).alias("row_rank"),
            pl.col("ctx_rank").cast(pl.Int16).alias("rank"),
            pl.col("ctx_explore").fill_null(False).alias("explore"),
            pl.col("sample_rate").cast(pl.Float32),
        ),
        "billing": frame.filter(pl.col("type") == ev.BILLING_TRANSITION).select(
            *event_key_columns(), "account", "occurred_at", "received_at", "state_to"
        ),
    }


@dataclass
class DatasetResult:
    dataset_id: str
    manifest: dict[str, Any]
    tables: dict[str, pl.DataFrame]


def _dedup(frame: pl.DataFrame) -> tuple[pl.DataFrame, int]:
    before = frame.height
    out = frame.sort(["received_at", "eid_hi", "eid_lo"]).unique(
        subset=["eid_hi", "eid_lo"], keep="first", maintain_order=True
    )
    return out, before - out.height


def _device_offsets(skew: pl.DataFrame) -> pl.DataFrame:
    """Per device: the count-weighted median of its per-batch medians; kept when the clock is off
    by more than two minutes."""
    return (
        skew.sort(["device", "median"])
        .with_columns(
            pl.col("n").cum_sum().over("device").alias("cumulative"),
            pl.col("n").sum().over("device").alias("total"),
        )
        .filter(pl.col("cumulative") * 2 >= pl.col("total"))
        .group_by("device")
        .agg(pl.col("median").first().cast(pl.Int64).alias("offset_ms"))
        .filter(pl.col("offset_ms").abs() > SKEW_THRESHOLD_MS)
    )


def _event_time(frame: pl.DataFrame, offsets: pl.DataFrame | None) -> pl.DataFrame:
    """Server events keep their time; client events are corrected by their device's offset,
    then clamped to their receipt."""
    if offsets is None:
        return frame.with_columns(pl.col("occurred_at").alias("event_time"))
    return (
        frame.join(offsets, on="device", how="left")
        .with_columns(
            (pl.col("occurred_at") - pl.col("offset_ms").fill_null(0)).alias("event_time")
        )
        .with_columns(pl.min_horizontal("event_time", pl.col("received_at")).alias("event_time"))
        .drop("offset_ms", "device")
    )


def build_dataset(
    location: str,
    storage: Storage,
    *,
    dataset_id: str,
    as_of_ms: int,
    workers: int = 1,
    write: bool = True,
    log: Any = print,
) -> DatasetResult:
    from webflix_recs.catalog import load_catalog  # noqa: PLC0415

    started = time.perf_counter()
    titles = tuple(load_catalog(storage).ids)
    results, read_stats, hours = read_events(
        location,
        until_ms=as_of_ms + 3_600_000,
        workers=workers,
        transform=functools.partial(_slim, as_of_ms=as_of_ms, titles=titles),
    )
    names = ("state", "consent", "skew", "unknown", "playback", "actions", "impressions", "billing")
    parts: dict[str, list[pl.DataFrame]] = {name: [] for name in names}
    for result in results:
        for name, frame in result.items():
            parts[name].append(frame)
    del results
    frames = {name: pl.concat(items, how="vertical") for name, items in parts.items() if items}
    del parts
    if "state" not in frames:
        raise ValueError(f"no events received before {iso_ms(as_of_ms)} in {storage.describe()}")
    counts: dict[str, Any] = {
        "read": read_stats.to_dict(),
        "hours": hours,
        "unknownTitlesDropped": int(frames["unknown"]["titles"].sum()),
    }

    # Latest state per profile and consent per account across all batches (rule 5).
    consent = (
        frames["consent"]
        .sort("latest_received")
        .group_by("account")
        .agg(pl.col("latest_personalisation").last())
    )
    state = (
        frames["state"]
        .sort("latest_received")
        .group_by("profile")
        .agg(
            pl.col("account").last(),
            pl.col("latest_restricted").last(),
            pl.col("plan").last(),
            pl.col("country").last(),
            pl.col("events").sum(),
        )
        .join(consent, on="account", how="left")
    )
    eligible = state.filter(
        ~pl.col("latest_restricted") & pl.col("latest_personalisation").fill_null(False)
    )
    counts["profiles"] = {
        "seen": state.height,
        "eligible": eligible.height,
        "excludedRestricted": state.filter(pl.col("latest_restricted")).height,
        "excludedNoConsent": state.filter(
            ~pl.col("latest_restricted") & ~pl.col("latest_personalisation").fill_null(False)
        ).height,
    }
    eligible_keys = eligible.select("profile")

    duplicates: dict[str, int] = {}
    for name in ("playback", "actions", "impressions", "billing"):
        frames[name], duplicates[name] = _dedup(frames[name])
    counts["duplicatesRemoved"] = duplicates

    # Rule 4: per-device clock offsets from client events.
    offsets = _device_offsets(frames["skew"])
    counts["skewedDevicesCorrected"] = offsets.height
    stale: dict[str, int] = {}
    late: dict[str, int] = {}
    excluded: dict[str, int] = {}
    for name in ("playback", "actions", "impressions"):
        frame = _event_time(frames[name], None if name == "playback" else offsets)
        too_old = (pl.col("received_at") - pl.col("event_time")) > STALE_AFTER_MS
        stale[name] = frame.filter(too_old).height
        late[name] = frame.filter(
            ((pl.col("received_at") - pl.col("event_time")) > 3_600_000) & ~too_old
        ).height
        frame = frame.filter(~too_old)
        before = frame.height
        frame = frame.join(eligible_keys, on="profile", how="semi").with_columns(
            pl.col("title").cast(pl.String).alias("title_id")
        )
        excluded[name] = before - frame.height
        frames[name] = frame.drop("title", "occurred_at")
    counts["staleDropped"] = stale
    counts["lateAccepted"] = late
    counts["ineligibleDropped"] = excluded

    playback = (
        frames.pop("playback")
        .select(
            "eid_hi",
            "eid_lo",
            pl.col("type").cast(pl.String),
            "profile",
            "title_id",
            "episode_id",
            "playback_id",
            "event_time",
            "received_at",
            "position_sec",
            "duration_sec",
            "watched_sec",
        )
        .sort(["profile", "event_time", "eid_hi", "eid_lo"])
    )
    actions = (
        frames.pop("actions")
        .select(
            "eid_hi",
            "eid_lo",
            pl.col("type").cast(pl.String),
            "profile",
            "title_id",
            "value",
            "event_time",
            "received_at",
            "surface",
            "row_rank",
            "rank",
        )
        .sort(["profile", "event_time", "eid_hi", "eid_lo"])
    )
    impressions = _label_impressions(frames.pop("impressions"), playback, actions, as_of_ms)
    first_seen = (
        pl.concat(
            [f.select("profile", "event_time") for f in (playback, actions, impressions)],
            how="vertical",
        )
        .group_by("profile")
        .agg(
            pl.col("event_time").min().alias("first_seen"),
            pl.col("event_time").max().alias("last_seen"),
        )
    )
    profiles = (
        eligible.join(first_seen, on="profile", how="left")
        .select("profile", "account", "plan", "country", "events", "first_seen", "last_seen")
        .sort("profile")
    )
    accounts = (
        frames["billing"]
        .sort("received_at")
        .group_by("account")
        .agg(
            pl.col("state_to").last().alias("state"), pl.col("occurred_at").last().alias("state_at")
        )
        .sort("account")
    )
    tables = {
        "playback": playback,
        "actions": actions,
        "impressions": impressions,
        "profiles": profiles,
        "accounts": accounts,
    }
    max_received = max(
        (
            int(t["received_at"].to_numpy().max())
            for t in (playback, actions, impressions)
            if t.height
        ),
        default=None,
    )
    manifest = {
        "format": "webflix.recs-dataset",
        "formatVersion": 1,
        "datasetId": dataset_id,
        "asOf": iso_ms(as_of_ms),
        "asOfMs": as_of_ms,
        "maxReceivedAt": iso_ms(max_received) if max_received is not None else None,
        "maxReceivedAtMs": max_received,
        "rows": {name: frame.height for name, frame in tables.items()},
        "counts": counts,
        "rules": {
            "staleAfterMs": STALE_AFTER_MS,
            "skewThresholdMs": SKEW_THRESHOLD_MS,
            "labelWindowMs": LABEL_WINDOW_MS,
            "qualifiedPlaySec": QUALIFIED_PLAY_SEC,
        },
        "seconds": round(time.perf_counter() - started, 2),
    }
    if max_received is not None and max_received >= as_of_ms:  # pragma: no cover - invariant
        raise AssertionError("dataset contains an event received after its knowledge cutoff")
    if write:
        for name, frame in tables.items():
            buffer = io.BytesIO()
            frame.write_parquet(buffer, compression="zstd")
            storage.put(f"{DATASET_PREFIX}{dataset_id}/{name}.parquet", buffer.getvalue())
        put_json(storage, f"{DATASET_PREFIX}{dataset_id}/manifest.json", manifest)
    log(f"dataset {dataset_id}: {manifest['rows']} in {manifest['seconds']}s")
    return DatasetResult(dataset_id, manifest, tables)


def _label_impressions(
    impressions: pl.DataFrame, playback: pl.DataFrame, actions: pl.DataFrame, as_of_ms: int
) -> pl.DataFrame:
    """Label each impression from what followed it, attributed to the card itself.

    `opened`: the profile opened the title from this very card: a `title.open` with the same
    module and card position (`context.rowRank`, `context.rank`) within 30 minutes. A play of the
    same title reached another way (another row showing it, search) does not count: crediting
    it to every impression of the title would flatten the position curve.
    `started` / `played`: opened, and the title started (`played`: for at least 30 s) within 30
    minutes after the impression.
    """
    window = LABEL_WINDOW_MS
    opens = (
        actions.filter(
            (pl.col("type") == ev.TITLE_OPEN)
            & pl.col("row_rank").is_not_null()
            & pl.col("rank").is_not_null()
        )
        .select("profile", "title_id", "row_rank", "rank", pl.col("event_time").alias("open_time"))
        .sort("open_time")
    )
    starts = playback.filter(pl.col("type") == ev.PLAYBACK_START).select(
        "profile", "title_id", "playback_id", pl.col("event_time").alias("play_time")
    )
    watched = playback.group_by("playback_id").agg(
        pl.col("watched_sec").max().alias("play_watched_sec")
    )
    starts = starts.join(watched, on="playback_id", how="left").sort("play_time")
    frame = (
        impressions.with_columns(pl.col("row_kind").cast(pl.String))
        .select(
            "eid_hi",
            "eid_lo",
            "profile",
            "title_id",
            "event_time",
            "received_at",
            "row_kind",
            "row_rank",
            "rank",
            "explore",
            "sample_rate",
        )
        # The label of an impression near the cutoff is not known yet: leave those out.
        .filter(pl.col("event_time") < as_of_ms - window)
        .sort("event_time")
    )
    labelled = frame.join_asof(
        opens,
        left_on="event_time",
        right_on="open_time",
        by=["profile", "title_id", "row_rank", "rank"],
        strategy="forward",
        tolerance=window,
        check_sortedness=False,
    ).join_asof(
        starts,
        left_on="event_time",
        right_on="play_time",
        by=["profile", "title_id"],
        strategy="forward",
        tolerance=window,
        check_sortedness=False,
    )
    opened = pl.col("open_time").is_not_null()
    started = opened & pl.col("play_time").is_not_null()
    # Cascade censoring: a member who plays a card leaves the row, so cards to its right in the
    # same showing of the row never had a chance. A showing is one burst of impressions of a
    # module (gaps under 30 s); its cards right of the first one played are marked `censored`
    # and left out of position-bias estimation and ranker training.
    showing = (
        (
            (
                pl.col("event_time")
                .diff()
                .over(["profile", "row_rank"])
                .fill_null(SHOWING_GAP_MS + 1)
            )
            > SHOWING_GAP_MS
        )
        .cum_sum()
        .over(["profile", "row_rank"])
    )
    labelled = labelled.sort(["profile", "row_rank", "event_time"]).with_columns(
        showing.alias("showing"), started.alias("_started")
    )
    first_played = (
        pl.when(pl.col("_started"))
        .then(pl.col("rank"))
        .otherwise(None)
        .min()
        .over(["profile", "row_rank", "showing"])
    )
    labelled = labelled.with_columns(
        (pl.col("rank") > first_played).fill_null(False).alias("censored")
    ).drop("showing", "_started")
    return (
        labelled.with_columns(
            opened.alias("opened"),
            started.alias("started"),
            (started & (pl.col("play_watched_sec").fill_null(0.0) >= QUALIFIED_PLAY_SEC)).alias(
                "played"
            ),
            pl.when(started)
            .then(pl.col("play_watched_sec"))
            .otherwise(0.0)
            .alias("play_watched_sec"),
        )
        .drop("playback_id", "play_time", "open_time")
        .sort(["profile", "event_time", "eid_hi", "eid_lo"])
    )


def load_dataset(
    storage: Storage, dataset_id: str, tables: tuple[str, ...] = TABLES
) -> DatasetResult:
    manifest = get_json(storage, f"{DATASET_PREFIX}{dataset_id}/manifest.json")
    if manifest is None:
        raise FileNotFoundError(f"no dataset {dataset_id} in {storage.describe()}")
    loaded = {}
    for name in tables:
        body = storage.get(f"{DATASET_PREFIX}{dataset_id}/{name}.parquet")
        if body is None:
            raise FileNotFoundError(f"dataset {dataset_id} is missing table {name}")
        loaded[name] = pl.read_parquet(io.BytesIO(body))
    return DatasetResult(dataset_id, manifest, loaded)
