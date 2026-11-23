"""An account's consent, as the pipeline derives it from events (dataset eligibility for
`personalisation`, experiment units for `analytics`).

The rule: the latest consent stamp on any event of the account (`subject.consent`, which the
product sets at receipt; `consent.change` events included, so a withdrawal counts even when the
member never comes back), except that a grant recorded by support never counts. Staff may no
longer grant consent for a member, and the product no longer treats an old support grant as the
member's answer; a lake written before that change can still hold `consent.change` events with
`source: support, granted: true`, and the stamps of the events after one may come from it. So an
account whose latest `consent.change` for a purpose is a support grant counts as not consenting
to that purpose, whatever later stamps say, until the member answers again themselves (a later
change from the banner, settings or Global Privacy Control).

Both readers run in worker processes over batches of events; `per_batch` is what a worker
keeps, `resolve` combines the batches.
"""

from __future__ import annotations

import polars as pl

from webflix_recs import schemas


def per_batch(frame: pl.DataFrame, stamp: str, purpose: str) -> pl.DataFrame:
    """One batch's view per account: its latest stamp (`latest`, with `latest_received`) and its
    latest change of `purpose` (`change_received`, `change_support_grant`)."""
    stamps = (
        frame.filter(pl.col("account").is_not_null())
        .sort("received_at")
        .group_by("account")
        .agg(
            pl.col("received_at").max().alias("latest_received"),
            pl.col(stamp).last().alias("latest"),
        )
    )
    changes = (
        frame.filter(
            (pl.col("type") == schemas.CONSENT_CHANGE)
            & (pl.col("consent_purpose") == purpose)
            & pl.col("account").is_not_null()
        )
        .sort("received_at")
        .group_by("account")
        .agg(
            pl.col("received_at").max().alias("change_received"),
            ((pl.col("consent_source") == "support") & pl.col("consent_granted").fill_null(False))
            .last()
            .alias("change_support_grant"),
        )
    )
    return stamps.join(changes, on="account", how="left")


BATCH_SCHEMA = {
    "account": pl.String,
    "latest_received": pl.Int64,
    "latest": pl.Boolean,
    "change_received": pl.Int64,
    "change_support_grant": pl.Boolean,
}


def support_grants(batches: pl.DataFrame) -> pl.DataFrame:
    """`account`: the accounts whose latest change of the purpose, across batches, is a grant
    by support."""
    return (
        batches.filter(pl.col("change_received").is_not_null())
        .sort("change_received")
        .group_by("account")
        .agg(pl.col("change_support_grant").last().alias("support_grant"))
        .filter(pl.col("support_grant").fill_null(False))
        .select("account")
    )


def resolve(batches: pl.DataFrame) -> pl.DataFrame:
    """`account`, `granted`: the latest stamp across batches, false when the latest change of
    the purpose across batches is a support grant (module docstring)."""
    latest = (
        batches.sort("latest_received")
        .group_by("account")
        .agg(pl.col("latest").last().fill_null(False).alias("granted"))
    )
    support = support_grants(batches).with_columns(pl.lit(True).alias("support_grant"))
    return (
        latest.join(support, on="account", how="left")
        .with_columns(
            (pl.col("granted") & ~pl.col("support_grant").fill_null(False)).alias("granted")
        )
        .select("account", "granted")
    )
