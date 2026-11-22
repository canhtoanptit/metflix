import { SHOWCASE_MATURITY_CEILING, SHOWCASE_SIZE, type Showcase } from "@webflix/contracts";
import * as z from "zod";
import { maturityRank } from "../domain/maturity.ts";
import { createJsonCache, type JsonCache, type KeyValueCache } from "../ports/cache.ts";
import type { Clock } from "../ports/clock.ts";
import { type Logger, serializeError } from "../ports/logger.ts";
import { addDays, fnvHex, utcDay } from "../recommendations/hash.ts";
import type { CatalogRepository, StatsRepository } from "../repositories/ports.ts";
import type { CatalogSnapshotData } from "../repositories/records.ts";
import { CatalogSnapshot } from "./snapshot.ts";

/**
 * Two-level cache for shared, non-personal data (blueprint: "cached where it is safe"):
 * process/isolate memory for a short time, then the `KeyValueCache` port (Valkey, Workers KV),
 * then the database. Only data that tolerates staleness lives here: the catalog (changes on
 * re-seed) and popularity counters (minutes-old is fine). Per-profile state never does:
 * My List and ratings must be read-after-write.
 */
export class TwoLevel<T, D> {
  private value: { key: string; data: T; expiresAt: number } | undefined;
  private readonly shared: JsonCache<D>;
  private readonly options: {
    key: () => string;
    load: () => Promise<D>;
    build: (data: D) => T;
    clock: Clock;
    logger: Logger;
    memoryTtlMs: number;
    maxSharedBytes: number;
  };

  constructor(
    cache: KeyValueCache,
    options: {
      prefix: string;
      schema: z.ZodType<D>;
      sharedTtlSec: number;
      key: () => string;
      load: () => Promise<D>;
      build: (data: D) => T;
      clock: Clock;
      logger: Logger;
      memoryTtlMs: number;
      maxSharedBytes?: number;
    },
  ) {
    this.shared = createJsonCache(cache, {
      schema: options.schema,
      prefix: options.prefix,
      ttlSec: options.sharedTtlSec,
    });
    this.options = { maxSharedBytes: 900_000, ...options };
  }

  get(): Promise<T> {
    const now = this.options.clock.now();
    // The key is part of the memo: popularity keys roll over at UTC midnight.
    if (this.value && this.value.key === this.options.key() && this.value.expiresAt > now) {
      return Promise.resolve(this.value.data);
    }
    // Only settled values are shared. On Workers a promise created by one request must not be
    // awaited by another (a cancelled request can leave its waiters hanging), so concurrent
    // first requests each load; the shared level makes that one KV read each.
    return this.refresh();
  }

  async invalidate(): Promise<void> {
    this.value = undefined;
    await this.shared.delete(this.options.key()).catch((error: unknown) => {
      this.options.logger.warn("cache.invalidate_failed", { error: serializeError(error) });
    });
  }

  private async refresh(): Promise<T> {
    const key = this.options.key();
    let data = await this.shared.get(key).catch((error: unknown) => {
      // The cache is an optimisation: an outage must not take browse down.
      this.options.logger.warn("cache.read_failed", { key, error: serializeError(error) });
      return null;
    });
    if (data === null) {
      data = await this.options.load();
      const size = JSON.stringify(data).length;
      if (size <= this.options.maxSharedBytes) {
        await this.shared.set(key, data).catch((error: unknown) => {
          this.options.logger.warn("cache.write_failed", { key, error: serializeError(error) });
        });
      } else {
        this.options.logger.warn("cache.value_too_large", { key, bytes: size });
      }
    }
    const built = this.options.build(data);
    this.value = {
      key,
      data: built,
      expiresAt: this.options.clock.now() + this.options.memoryTtlMs,
    };
    return built;
  }
}

// Shapes are produced by this code and only lightly checked when read back: a deploy that
// changes them bumps the key prefix instead.
const SnapshotEnvelope = z.custom<CatalogSnapshotData>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string" &&
    Array.isArray((value as { titles?: unknown }).titles) &&
    Array.isArray((value as { packagedAssets?: unknown }).packagedAssets),
);

export interface CatalogCacheOptions {
  repository: CatalogRepository;
  cache: KeyValueCache;
  clock: Clock;
  logger: Logger;
  /** Default 30 s. */
  memoryTtlMs?: number;
  /** Default 300 s. */
  sharedTtlSec?: number;
}

export class CatalogCache {
  private readonly levels: TwoLevel<CatalogSnapshot, CatalogSnapshotData>;

  constructor(options: CatalogCacheOptions) {
    this.levels = new TwoLevel(options.cache, {
      // v2: the snapshot carries `packagedAssets` (video quality).
      prefix: "webflix:v2:",
      schema: SnapshotEnvelope,
      sharedTtlSec: options.sharedTtlSec ?? 300,
      key: () => "catalog-snapshot",
      load: () => options.repository.loadSnapshot(),
      build: (data) => new CatalogSnapshot(data),
      clock: options.clock,
      logger: options.logger,
      memoryTtlMs: options.memoryTtlMs ?? 30_000,
    });
  }

  get(): Promise<CatalogSnapshot> {
    return this.levels.get();
  }

  invalidate(): Promise<void> {
    return this.levels.invalidate();
  }
}

// --- Popularity ---------------------------------------------------------------------------------

/** Trending decays by this factor per day of age. */
const TRENDING_DAILY_DECAY = 0.8;
const TRENDING_WINDOW_DAYS = 7;

export interface PopularityData {
  day: string;
  /** [titleId, recency-weighted views over the last week]. */
  trending: [string, number][];
  /** [titleId, views today + yesterday] (what "Top 10 Today" ranks). */
  recent: [string, number][];
}

/** Views-derived popularity, computed from `title_stats` (seed baseline + real playback). */
export class Popularity {
  readonly day: string;
  private readonly trendScores = new Map<string, number>();
  private readonly recentViews = new Map<string, number>();
  /** Titles by recent views, best first. */
  readonly ranked: readonly string[];

  constructor(data: PopularityData) {
    this.day = data.day;
    const max = Math.max(0, ...data.trending.map(([, score]) => score));
    for (const [id, score] of data.trending) this.trendScores.set(id, max > 0 ? score / max : 0);
    for (const [id, views] of data.recent) this.recentViews.set(id, views);
    this.ranked = data.recent
      .filter(([, views]) => views > 0)
      .sort(
        ([a, va], [b, vb]) =>
          vb - va ||
          (this.trendScores.get(b) ?? 0) - (this.trendScores.get(a) ?? 0) ||
          a.localeCompare(b),
      )
      .map(([id]) => id);
  }

  /** 0..1, relative to the most trending title. */
  trend(titleId: string): number {
    return this.trendScores.get(titleId) ?? 0;
  }

  recent(titleId: string): number {
    return this.recentViews.get(titleId) ?? 0;
  }

  static empty(day: string): Popularity {
    return new Popularity({ day, trending: [], recent: [] });
  }
}

export function computePopularity(
  day: string,
  rows: readonly { day: string; titleId: string; views: number }[],
): PopularityData {
  const trending = new Map<string, number>();
  const recent = new Map<string, number>();
  const yesterday = addDays(day, -1);
  for (const row of rows) {
    const age = Math.round((Date.parse(day) - Date.parse(row.day)) / 86_400_000);
    if (age < 0 || age >= TRENDING_WINDOW_DAYS) continue;
    trending.set(
      row.titleId,
      (trending.get(row.titleId) ?? 0) + row.views * TRENDING_DAILY_DECAY ** age,
    );
    if (row.day === day || row.day === yesterday) {
      recent.set(row.titleId, (recent.get(row.titleId) ?? 0) + row.views);
    }
  }
  return { day, trending: [...trending], recent: [...recent] };
}

const PopularityEnvelope = z.custom<PopularityData>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { trending?: unknown }).trending) &&
    Array.isArray((value as { recent?: unknown }).recent),
);

export interface PopularityCacheOptions {
  repository: StatsRepository;
  cache: KeyValueCache;
  clock: Clock;
  logger: Logger;
  /** Default 60 s. */
  memoryTtlMs?: number;
  /** Default 300 s. */
  sharedTtlSec?: number;
}

export class PopularityCache {
  private readonly levels: TwoLevel<Popularity, PopularityData>;

  constructor(options: PopularityCacheOptions) {
    const today = () => utcDay(options.clock.now());
    this.levels = new TwoLevel(options.cache, {
      prefix: "webflix:v1:",
      schema: PopularityEnvelope,
      sharedTtlSec: options.sharedTtlSec ?? 300,
      key: () => `popularity:${today()}`,
      load: async () => {
        const day = today();
        const rows = await options.repository.dailyViews(addDays(day, -(TRENDING_WINDOW_DAYS - 1)));
        return computePopularity(day, rows);
      },
      build: (data) => new Popularity(data),
      clock: options.clock,
      logger: options.logger,
      memoryTtlMs: options.memoryTtlMs ?? 60_000,
    });
  }

  get(): Promise<Popularity> {
    return this.levels.get();
  }

  invalidate(): Promise<void> {
    return this.levels.invalidate();
  }
}

// --- Showcase -----------------------------------------------------------------------------------

export interface ShowcaseData {
  showcase: Showcase;
  /** Weak validator of `showcase` (changes with the catalog). */
  etag: string;
}

/**
 * The public marketing showcase: the most popular titles rated at most
 * `SHOWCASE_MATURITY_CEILING`, best first (seed popularity, then id: stable for a catalog
 * version), with their artwork. Nothing here depends on a profile.
 */
export function buildShowcase(snapshot: CatalogSnapshot): ShowcaseData {
  const ceiling = maturityRank(SHOWCASE_MATURITY_CEILING);
  const showcase: Showcase = {
    items: snapshot.titles
      .filter((title) => snapshot.maturityRankOf(title.id) <= ceiling)
      .sort((a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id))
      .slice(0, SHOWCASE_SIZE)
      .map((title) => ({
        id: title.id,
        name: title.name,
        type: title.type,
        images: {
          card: title.images.card,
          poster: title.images.poster,
          logo: title.images.logo,
          backdrop: title.images.backdrop,
        },
      })),
  };
  return { showcase, etag: `W/"sc-${fnvHex(JSON.stringify(showcase))}"` };
}

const ShowcaseEnvelope = z.custom<ShowcaseData>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { etag?: unknown }).etag === "string" &&
    typeof (value as { showcase?: unknown }).showcase === "object",
);

export interface ShowcaseCacheOptions {
  catalog: CatalogCache;
  cache: KeyValueCache;
  clock: Clock;
  logger: Logger;
  /** Default 60 s. */
  memoryTtlMs?: number;
  /** Default 300 s, like the catalog snapshot it is derived from. */
  sharedTtlSec?: number;
}

/**
 * The showcase through the same two levels. Signed-out traffic lands on fresh processes and
 * isolates; with the small showcase in the shared cache (Workers KV on Cloudflare) they answer
 * without loading the whole catalog snapshot.
 */
export class ShowcaseCache {
  private readonly levels: TwoLevel<ShowcaseData, ShowcaseData>;

  constructor(options: ShowcaseCacheOptions) {
    this.levels = new TwoLevel(options.cache, {
      prefix: "webflix:v1:",
      schema: ShowcaseEnvelope,
      sharedTtlSec: options.sharedTtlSec ?? 300,
      key: () => "showcase",
      load: async () => buildShowcase(await options.catalog.get()),
      build: (data) => data,
      clock: options.clock,
      logger: options.logger,
      memoryTtlMs: options.memoryTtlMs ?? 60_000,
    });
  }

  get(): Promise<ShowcaseData> {
    return this.levels.get();
  }

  invalidate(): Promise<void> {
    return this.levels.invalidate();
  }
}
