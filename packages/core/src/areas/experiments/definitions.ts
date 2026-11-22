import type { ExperimentAssignments, ExperimentDefinition } from "@webflix/contracts";
import * as z from "zod";
import { createJsonCache, type KeyValueCache } from "../../ports/cache.ts";
import type { Clock } from "../../ports/clock.ts";
import {
  type AssignmentContext,
  assignVariants,
  type Experiments,
  type ExperimentUnit,
} from "../../ports/experiments.ts";
import { type Logger, serializeError } from "../../ports/logger.ts";
import type { ExperimentsRepository } from "./repository.ts";

export interface RepositoryExperimentsOptions {
  repository: ExperimentsRepository;
  clock: Clock;
  logger: Logger;
  /** The shared cache (Valkey, Workers KV): one database read per location instead of per process. */
  cache?: KeyValueCache;
}

/**
 * The oldest a copy of the definitions is ever used, counted from when it was read from the
 * database, on every instance and through every cache level (Workers KV may keep a read up to a
 * minute at a location: the age travels with the value, so that does not extend it). A status
 * change is scheduled further ahead than this (`propagationSec`), so every instance has the new
 * definitions before the change takes effect.
 */
export const DEFINITIONS_MAX_AGE_MS = 30_000;
/** A shared copy older than this is not taken (it would leave too little time to use it). */
const SHARED_MAX_AGE_MS = 20_000;
/** The port's minimum; the age stamp, not this, bounds staleness. */
const SHARED_TTL_SEC = 60;

interface Copy {
  /** When it was read from the database (epoch ms, the reading instance's clock). */
  loadedAt: number;
  definitions: ExperimentDefinition[];
}

const CopyEnvelope = z.custom<Copy>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { loadedAt?: unknown }).loadedAt === "number" &&
    Array.isArray((value as { definitions?: unknown }).definitions),
);
const CACHE_KEY = "experiments";

/**
 * `Experiments` over the experiments table (`WEBFLIX_EXPERIMENTS=database`): definitions read
 * through two cache levels (process memory, then the shared cache), because assignment sits on
 * the browse path, which has a budget of two database round trips. Every copy carries when it
 * was read from the database and is used for at most `DEFINITIONS_MAX_AGE_MS` from then, so how
 * stale an instance can be is bounded whatever the caches do. A staff change does not rely on
 * reaching the other instances: it is scheduled (`statusChangeAt`,
 * `WEBFLIX_EXPERIMENTS_PROPAGATION_SEC`) to take effect after every copy has been refreshed, so
 * all instances switch at one instant. `invalidate` refreshes this process at once. Assignment
 * is `assignVariants`.
 */
export function createRepositoryExperiments(options: RepositoryExperimentsOptions): Experiments {
  const shared = options.cache
    ? createJsonCache(options.cache, {
        schema: CopyEnvelope,
        prefix: "webflix:v2:",
        ttlSec: SHARED_TTL_SEC,
      })
    : null;
  let memo: Copy | null = null;

  async function load(): Promise<ExperimentDefinition[]> {
    const now = options.clock.now();
    if (memo && now - memo.loadedAt < DEFINITIONS_MAX_AGE_MS) return memo.definitions;
    let copy = shared
      ? await shared.get(CACHE_KEY).catch((error: unknown) => {
          options.logger.warn("cache.read_failed", {
            key: CACHE_KEY,
            error: serializeError(error),
          });
          return null;
        })
      : null;
    if (copy === null || now - copy.loadedAt >= SHARED_MAX_AGE_MS || copy.loadedAt > now + 5_000) {
      copy = {
        loadedAt: options.clock.now(),
        definitions: (await options.repository.listExperiments()).map(
          (stored) => stored.definition,
        ),
      };
      await shared?.set(CACHE_KEY, copy).catch((error: unknown) => {
        options.logger.warn("cache.write_failed", { key: CACHE_KEY, error: serializeError(error) });
      });
    }
    memo = copy;
    return copy.definitions;
  }

  return {
    async definitions() {
      return structuredClone(await load());
    },
    async assign(
      unit: ExperimentUnit,
      context: AssignmentContext,
      now: number,
    ): Promise<ExperimentAssignments> {
      return assignVariants(await load(), unit, context, now);
    },
    async invalidate() {
      memo = null;
      await shared?.delete(CACHE_KEY).catch((error: unknown) => {
        options.logger.warn("cache.invalidate_failed", { error: serializeError(error) });
      });
    },
  };
}
