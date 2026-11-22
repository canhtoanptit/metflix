"""build-dataset: duplicates, late events, clock skew, consent and restricted subjects."""

from __future__ import annotations

import copy
from pathlib import Path

import polars as pl

from helpers import ANCHOR_MS, make_event, put_catalog, synthetic_catalog_document, write_lake
from webflix_recs.dataset import build_dataset, event_key
from webflix_recs.ids import DAY_MS, HOUR_MS, iso_ms
from webflix_recs.storage import LocalStorage

T0 = ANCHOR_MS - 10 * DAY_MS


def _keys(frame: pl.DataFrame) -> list[tuple[int, int]]:
    return list(zip(frame["eid_hi"].to_list(), frame["eid_lo"].to_list(), strict=True))


def _build(path: Path, as_of_ms: int):  # type: ignore[no-untyped-def]
    storage = LocalStorage(path)
    if storage.get("catalog/current.json") is None:
        put_catalog(storage, synthetic_catalog_document(40))
    return build_dataset(
        str(path),
        LocalStorage(path),
        dataset_id="t",
        as_of_ms=as_of_ms,
        write=False,
        log=lambda *_: None,
    )


def test_duplicates_are_removed_and_late_events_count_from_their_receipt(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    play = make_event("playback.start", T0, title="t-1", watched=0.0, position=0.0)
    progress = make_event("playback.progress", T0 + 600_000, title="t-1", watched=600.0)
    # The same event delivered twice: once by a queue redelivery (same receipt), once by a client
    # retry accepted again three hours later (same eventId, later receipt).
    retry = copy.deepcopy(progress)
    retry["receivedAt"] = iso_ms(T0 + 600_000 + 3 * HOUR_MS)
    # An offline device: the list action happened at T0 but arrived 50 hours later.
    late = make_event(
        "list.add", T0 + 60_000, received_ms=T0 + 50 * HOUR_MS, title="t-2", device="offline"
    )
    # Too late to trust: received 8 days after it claims to have happened.
    stale = make_event("rating.set", T0, received_ms=T0 + 8 * DAY_MS, title="t-3", device="ancient")
    write_lake(storage, [play, progress, progress, retry], "a")
    write_lake(storage, [late, stale], "b")

    before = _build(tmp_path, T0 + DAY_MS)
    assert _keys(before.tables["playback"]).count(event_key(progress["eventId"])) == 1
    assert before.manifest["counts"]["duplicatesRemoved"]["playback"] == 2
    assert event_key(late["eventId"]) not in _keys(before.tables["actions"])

    after = _build(tmp_path, T0 + 9 * DAY_MS)
    actions = after.tables["actions"]
    hi, lo = event_key(late["eventId"])
    row = actions.filter((pl.col("eid_hi") == hi) & (pl.col("eid_lo") == lo))
    assert row.height == 1
    assert row["event_time"][0] == T0 + 60_000  # event time, not receipt time
    assert after.manifest["counts"]["lateAccepted"]["actions"] == 1
    assert after.manifest["counts"]["staleDropped"]["actions"] == 1
    assert event_key(stale["eventId"]) not in _keys(actions)


def test_a_skewed_device_clock_is_corrected_from_its_median_offset(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    skew = 3 * HOUR_MS
    events = []
    for i in range(9):
        true_time = T0 + i * 60_000
        event = make_event(
            "impression",
            true_time + skew,
            received_ms=true_time + 500,
            device="fast-clock",
            title=f"t-{i}",
        )
        events.append(event)
    write_lake(storage, events, "a")
    result = _build(tmp_path, T0 + DAY_MS)
    times = result.tables["impressions"].sort("event_time")["event_time"].to_list()
    assert result.manifest["counts"]["skewedDevicesCorrected"] == 1
    assert all(abs(t - (T0 + i * 60_000)) < 2_000 for i, t in enumerate(times))


def test_restricted_and_non_consenting_subjects_never_enter_the_dataset(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    kid = "K" * 22  # always restricted
    capped = "C" * 22  # unrestricted at first, then the ceiling was lowered: drop everything
    grew = "G" * 22  # restricted at first, unrestricted now: keep only unrestricted events
    revoked = "R" * 22  # consent to personalisation withdrawn later: drop everything
    quiet = "Q" * 22  # withdrew consent in settings and never came back: still dropped
    fine = "F" * 22
    events = [
        make_event("playback.start", T0, profile=kid, restricted=True, account="k" * 22),
        make_event("playback.start", T0, profile=capped, account="c" * 22),
        make_event(
            "playback.progress", T0 + DAY_MS, profile=capped, restricted=True, account="c" * 22
        ),
        make_event(
            "playback.start", T0, profile=grew, restricted=True, account="g" * 22, title="t-10"
        ),
        make_event("playback.start", T0 + DAY_MS, profile=grew, account="g" * 22, title="t-11"),
        make_event("playback.start", T0, profile=revoked, account="r" * 22),
        make_event(
            "title.open", T0 + DAY_MS, profile=revoked, account="r" * 22, personalisation=False
        ),
        make_event("playback.start", T0, profile=quiet, account="q" * 22),
        make_event(
            "consent.change", T0 + DAY_MS, profile=None, account="q" * 22, personalisation=False
        ),
        make_event("playback.start", T0, profile=fine, account="f" * 22),
    ]
    write_lake(storage, events, "a")
    result = _build(tmp_path, T0 + 3 * DAY_MS)
    everywhere = set()
    for name in ("playback", "actions", "impressions", "profiles"):
        everywhere |= set(result.tables[name]["profile"].to_list())
    assert everywhere == {grew, fine}
    assert result.tables["playback"].filter(result.tables["playback"]["profile"] == grew)[
        "title_id"
    ].to_list() == ["t-11"]
    counts = result.manifest["counts"]["profiles"]
    assert counts["excludedRestricted"] == 2
    assert counts["excludedNoConsent"] == 2


def test_plays_are_attributed_to_the_card_and_cards_after_a_play_are_censored(
    tmp_path: Path,
) -> None:
    storage = LocalStorage(tmp_path)
    t = T0 + DAY_MS
    shown = [
        make_event("impression", t + 150 * k, title=f"t-{k}", row_rank=4, rank=k)
        for k in (1, 2, 3, 4)
    ]
    # The same title shown in another row and played from search: not this card's play.
    elsewhere = make_event("impression", t + 5_000, title="t-9", row_rank=6, rank=1)
    events = [
        *shown,
        elsewhere,
        make_event("title.open", t + 4_000, title="t-2", row_rank=4, rank=2),
        make_event(
            "playback.start", t + 9_000, title="t-2", watched=0.0, position=0.0, playback="a"
        ),
        make_event("playback.progress", t + 900_000, title="t-2", watched=891.0, playback="a"),
        make_event("title.open", t + 7_000, title="t-9"),  # from search: no row context
        make_event(
            "playback.start", t + 9_500, title="t-9", watched=0.0, position=0.0, playback="b"
        ),
        make_event("playback.progress", t + 600_000, title="t-9", watched=590.0, playback="b"),
    ]
    write_lake(storage, events, "a")
    impressions = _build(tmp_path, T0 + 3 * DAY_MS).tables["impressions"].sort(["row_rank", "rank"])
    row = impressions.filter(pl.col("row_rank") == 4)
    assert row["opened"].to_list() == [False, True, False, False]
    assert row["played"].to_list() == [False, True, False, False]
    assert row["censored"].to_list() == [False, False, True, True]
    other = impressions.filter(pl.col("row_rank") == 6)
    assert other["played"].to_list() == [False]
