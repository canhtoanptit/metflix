"""Running the simulator: shards in parallel, events to the lake, truth to its own place."""

from __future__ import annotations

import resource
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

import numpy as np
import orjson
import polars as pl

from webflix_recs.catalog import Catalog
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.parallel import default_workers, parallel_map
from webflix_recs.simulate.behaviour import World
from webflix_recs.simulate.config import SimConfig
from webflix_recs.simulate.emit import Emitter, LakeSink, MemorySink, Sink
from webflix_recs.simulate.policy import Policy, PopularitySeries
from webflix_recs.simulate.world import (
    EXAMINE_POSITION_EXPONENT,
    LATENT_DIM,
    ROW_ATTENTION_DECAY,
    ROW_ATTENTION_FLOOR,
    make_titles,
    people_pool,
)
from webflix_recs.storage import open_storage, put_json

SIMULATOR_VERSION = "1"

TRUTH_PROFILE_SCHEMA: dict[str, Any] = {
    "profile_key": pl.String,
    "account_key": pl.String,
    "account_index": pl.Int64,
    "profile_number": pl.Int64,
    "kind": pl.String,
    "kids": pl.Boolean,
    "restricted": pl.Boolean,
    "ceiling_rank": pl.Int64,
    "created_ms": pl.Int64,
    "joined_ms": pl.Int64,
    "existing": pl.Boolean,
    "churned_ms": pl.Int64,
    "analytics": pl.Boolean,
    "personalisation_initial": pl.Boolean,
    "consent_change_ms": pl.Int64,
    "personalisation_final": pl.Boolean,
    "assignments": pl.String,
    "sessions": pl.Int64,
    "plays": pl.Int64,
    "utility": pl.List(pl.Float32),
}


def _build_world(config: SimConfig, catalog: Catalog, sink: Sink, shard: int) -> World:
    titles = make_titles(catalog, config.seed)
    popularity = PopularitySeries(catalog, config.start_ms, config.days, config.seed)
    policy = Policy(catalog, popularity, config.policy_id)
    learned = None
    if config.learned_store and config.learned_run:
        from webflix_recs.simulate.learned import LearnedRun  # noqa: PLC0415

        learned = LearnedRun(config.learned_store, config.learned_run, catalog)
    emitter = Emitter(
        sink=sink,
        rng=np.random.default_rng([config.seed, 4, shard]),
        app_version=config.app_version,
        duplicate_rate=config.duplicate_rate,
        collect_like_the_product=config.collect_like_the_product,
    )
    return World(
        config, catalog, titles, policy, emitter, people_pool(catalog, titles), learned=learned
    )


def simulate_shard(
    config: SimConfig,
    catalog_document: dict[str, Any],
    shard: int,
    sink: Sink,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Simulate one shard of households day by day. Returns statistics and the shard's truth."""
    catalog = Catalog.from_document(catalog_document, verify_version=False)
    world = _build_world(config, catalog, sink, shard)
    low = shard * config.shard_size
    high = min(config.accounts, low + config.shard_size)
    households = [world.make_household(index) for index in range(low, high)]
    for day in range(config.days):
        for household in households:
            world.simulate_day(household, day)
        # Everything simulated later happens after the next midnight: earlier receipt hours
        # are complete and can be written.
        sink.flush_before(config.start_ms + (day + 1) * DAY_MS)
    sink.close()
    truth = [
        {
            "profile_key": profile.key,
            "account_key": household.key,
            "account_index": household.index,
            "profile_number": profile.truth.number,
            "kind": profile.truth.kind,
            "kids": profile.truth.kids,
            "restricted": profile.truth.restricted,
            "ceiling_rank": profile.truth.ceiling_rank,
            "created_ms": profile.created_ms,
            "joined_ms": household.join_ms,
            "existing": household.existing,
            "churned_ms": household.churned_ms,
            "analytics": household.analytics,
            "personalisation_initial": household.personalisation,
            "consent_change_ms": household.consent_change_ms,
            "personalisation_final": household.personalisation_at(config.end_ms),
            "assignments": orjson.dumps(profile.assignments).decode(),
            "sessions": profile.sessions,
            "plays": profile.plays,
            "utility": profile.utility.astype(np.float32).tolist(),
        }
        for household in households
        for profile in household.profiles
    ]
    stats = asdict(world.stats)
    stats["events"] = dict(world.emit.counts)
    stats["households"] = len(households)
    stats["profiles"] = len(truth)
    return stats, truth


def _shard_job(args: tuple[SimConfig, dict[str, Any], int, str, str]) -> dict[str, Any]:
    config, document, shard, store_location, truth_dir = args
    started = time.perf_counter()
    sink = LakeSink(
        open_storage(store_location), shard=shard, seed=config.seed, layout=config.object_layout
    )
    stats, truth = simulate_shard(config, document, shard, sink)
    frame = pl.DataFrame(truth, schema=TRUTH_PROFILE_SCHEMA)
    target = Path(truth_dir) / "profiles" / f"part-{shard:05d}.parquet"
    target.parent.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(target, compression="zstd")
    stats.update(
        shard=shard,
        objects=sink.objects,
        lines=sink.events,
        bytes=sink.bytes,
        seconds=round(time.perf_counter() - started, 3),
        max_rss_mb=round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20, 1),
    )
    return stats


def run_simulation(
    config: SimConfig,
    catalog: Catalog,
    store_location: str,
    truth_dir: str | Path,
    *,
    workers: int | None = None,
    log: Any = print,
) -> dict[str, Any]:
    """Simulate every shard; write the lake through the store and the truth to `truth_dir`."""
    truth = Path(truth_dir)
    truth.mkdir(parents=True, exist_ok=True)
    workers = max(1, min(workers or default_workers(), config.shards))
    jobs = [
        (config, catalog.raw, shard, store_location, str(truth)) for shard in range(config.shards)
    ]
    started = time.perf_counter()
    results: list[dict[str, Any]] = []
    results = parallel_map(
        _shard_job,
        jobs,
        workers=workers,
        on_result=lambda stats: log(
            f"  shard {stats['shard'] + 1}/{config.shards}: "
            f"{stats['lines']} events in {stats['seconds']}s"
        ),
    )
    elapsed = time.perf_counter() - started
    totals: dict[str, Any] = {"events": {}}
    for stats in results:
        for name, value in stats.items():
            if name == "events":
                for kind, count in value.items():
                    totals["events"][kind] = totals["events"].get(kind, 0) + count
            elif isinstance(value, int | float) and name not in {"shard", "seconds", "max_rss_mb"}:
                totals[name] = totals.get(name, 0) + value
    titles = make_titles(catalog, config.seed)
    pl.DataFrame(
        {
            "title_id": catalog.ids,
            "quality": titles.quality,
            "latent": titles.latent.astype(np.float32).tolist(),
        },
        schema_overrides={"latent": pl.List(pl.Float32)},
    ).write_parquet(truth / "titles.parquet")
    manifest = {
        "format": "webflix.sim-truth",
        "simulatorVersion": SIMULATOR_VERSION,
        "config": config.to_dict(),
        "catalogVersion": catalog.version,
        "start": iso_ms(config.start_ms),
        "end": iso_ms(config.end_ms),
        "latentDim": LATENT_DIM,
        "positionBias": {
            "examine": f"rank^-{EXAMINE_POSITION_EXPONENT}",
            "examineExponent": EXAMINE_POSITION_EXPONENT,
            "rowAttention": f"max({ROW_ATTENTION_FLOOR}, 1 - {ROW_ATTENTION_DECAY} (rowRank - 1))",
            "rowAttentionDecay": ROW_ATTENTION_DECAY,
            "rowAttentionFloor": ROW_ATTENTION_FLOOR,
            "visibleCards": 6,
        },
        "utilityOrder": catalog.ids,
        "totals": totals,
        "seconds": round(elapsed, 2),
        "workers": workers,
        "shardStats": results,
    }
    (truth / "manifest.json").write_bytes(orjson.dumps(manifest, option=orjson.OPT_INDENT_2))
    if config.experiments:
        # What the simulated platform pre-registered (its experiments table, exported like the
        # catalogue). The design only: the planted effect stays in the truth manifest.
        put_json(open_storage(store_location), DEFINITIONS_KEY, experiment_definitions(config))
    return manifest


DEFINITIONS_KEY = "experiments/definitions.json"


def experiment_definitions(config: SimConfig) -> dict[str, Any]:
    return {
        "format": "webflix.experiment-definitions",
        "formatVersion": 1,
        "experiments": [
            {
                "key": spec.key,
                "variants": [{"name": name, "weight": weight} for name, weight in spec.variants],
                "control": spec.variants[0][0],
                "unit": "profile",
                "primaryMetric": "qualified_plays",
                "secondaryMetrics": ["watch_hours", "any_play", "active_days", "retained"],
                "alpha": 0.05,
                "power": 0.8,
                "minimumDetectableEffect": 0.05,
                "registeredAt": iso_ms(config.start_ms + (spec.start_day - 1) * DAY_MS),
                "startsAt": iso_ms(config.start_ms + spec.start_day * DAY_MS),
                "endsAt": iso_ms(config.end_ms),
                "analysis": {"method": "msprt", "looks": "daily"},
                "srmThreshold": 0.001,
            }
            for spec in config.experiments
        ],
    }


def simulate_in_memory(
    config: SimConfig, catalog: Catalog
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Every event of a (small) run, in memory: for tests."""
    events: list[dict[str, Any]] = []
    truth: list[dict[str, Any]] = []
    for shard in range(config.shards):
        sink = MemorySink()
        _, shard_truth = simulate_shard(config, catalog.raw, shard, sink)
        events.extend(sink.events)
        truth.extend(shard_truth)
    return events, truth
