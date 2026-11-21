import * as z from "zod";
import type { CatalogCache, PopularityCache } from "../catalog/cache.ts";
import {
  createJobProcessor,
  defineJob,
  handleJob,
  type JobBinding,
  type JobProcessor,
} from "../ports/job-queue.ts";
import { addDays, DAY_MS, dayStart, hash01, utcDay } from "../recommendations/hash.ts";
import type { TitleRecord, TitleStatRecord } from "../repositories/records.ts";
import type { ServiceDependencies } from "./context.ts";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Recompute one day's real playback counters (idempotent; safe under redelivery). */
export const statsRollupJob = defineJob("stats.rollup-day", z.object({ day: Day }));
/** Make sure one day has its synthetic baseline (keeps Trending alive without re-seeding). */
export const statsBaselineJob = defineJob("stats.baseline-day", z.object({ day: Day }));
/** Drop old playback sessions (their stats are rolled up already). */
export const playbackCleanupJob = defineJob(
  "playback.cleanup",
  z.object({ olderThanDays: z.number().int().positive() }),
);

/** Delete sessions whose sign-in expired, a bounded batch at a time. */
export const sessionCleanupJob = defineJob("sessions.cleanup", z.object({}));

const PLAYBACK_RETENTION_DAYS = 30;
/** Sessions deleted per job; a full batch publishes the next one, so a backlog drains. */
export const SESSION_CLEANUP_BATCH = 500;

/**
 * Synthetic daily views for a title: popularity-driven, with a launch spike after it was
 * added and deterministic day-to-day noise. Shared by the seeder (14 days of history) and the
 * daily baseline job, so the demo stays "alive" however long the process runs.
 */
export function baselineStat(
  title: Pick<TitleRecord, "id" | "popularity" | "addedAt" | "runtimeSec">,
  day: string,
): TitleStatRecord | null {
  const ageDays = (dayStart(day) - title.addedAt) / DAY_MS;
  if (ageDays < -1) return null;
  const base = (title.popularity / 100) ** 2 * 400 + 5;
  const launch = ageDays < 21 ? 1 + 2.5 * Math.exp(-Math.max(0, ageDays) / 5) : 1;
  const noise = 0.75 + 0.5 * hash01(`${title.id}:${day}`);
  const views = Math.round(base * launch * noise);
  const runtime = title.runtimeSec ?? 45 * 60;
  return {
    day,
    titleId: title.id,
    source: "seed",
    views,
    watchSec: Math.round(views * runtime * 0.6),
    profiles: views,
  };
}

export function baselineStats(
  titles: readonly Pick<TitleRecord, "id" | "popularity" | "addedAt" | "runtimeSec">[],
  days: readonly string[],
): TitleStatRecord[] {
  return days.flatMap((day) =>
    titles.flatMap((title) => {
      const stat = baselineStat(title, day);
      return stat ? [stat] : [];
    }),
  );
}

export interface JobState {
  catalog: CatalogCache;
  popularity: PopularityCache;
}

/** Handlers for every job type, bound to the services' dependencies. */
export function createJobBindings(deps: ServiceDependencies, state: JobState): JobBinding[] {
  const { repos } = deps;
  return [
    handleJob(statsRollupJob, async ({ day }, context) => {
      const from = dayStart(day);
      await repos.stats.rollupPlaybackDay(day, from, from + DAY_MS);
      await state.popularity.invalidate();
      context.logger.info("stats.rolled_up", { day });
    }),
    handleJob(statsBaselineJob, async ({ day }, context) => {
      if (await repos.stats.hasBaseline(day)) return;
      const snapshot = await state.catalog.get();
      await repos.stats.upsertBaseline(baselineStats(snapshot.titles, [day]));
      await state.popularity.invalidate();
      context.logger.info("stats.baseline_written", { day, titles: snapshot.titles.length });
    }),
    handleJob(playbackCleanupJob, async ({ olderThanDays }, context) => {
      const deleted = await repos.playback.deleteStartedBefore(
        deps.clock.now() - olderThanDays * DAY_MS,
      );
      context.logger.info("playback.cleaned_up", { deleted });
    }),
    handleJob(sessionCleanupJob, async (_payload, context) => {
      const deleted = await repos.sessions.deleteExpired(deps.clock.now(), SESSION_CLEANUP_BATCH);
      const more = deleted === SESSION_CLEANUP_BATCH;
      if (more) await deps.jobs.publish(sessionCleanupJob.create({}));
      context.logger.info("sessions.cleaned_up", { deleted, more });
    }),
  ];
}

export function createProcessor(deps: ServiceDependencies, state: JobState): JobProcessor {
  return createJobProcessor({ jobs: createJobBindings(deps, state), logger: deps.logger });
}

/**
 * Periodic work, driven by whatever clock the runtime has: a timer in the Node worker (and
 * in-process in dev), a Cron Trigger on Cloudflare. It only publishes jobs, so it is cheap
 * and safe to run from several replicas at once (every job is idempotent).
 */
export function createScheduler(deps: ServiceDependencies) {
  return {
    async tick(): Promise<void> {
      const today = utcDay(deps.clock.now());
      await deps.jobs.publishBatch([
        statsBaselineJob.create({ day: today }),
        statsRollupJob.create({ day: today }),
        statsRollupJob.create({ day: addDays(today, -1) }),
        playbackCleanupJob.create({ olderThanDays: PLAYBACK_RETENTION_DAYS }),
        sessionCleanupJob.create({}),
      ]);
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
