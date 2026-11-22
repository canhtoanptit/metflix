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
  /** The shared cache (Valkey, Workers KV): one read per location instead of per process. */
  cache?: KeyValueCache;
  /** Per process (default 30 s). */
  memoryTtlMs?: number;
  /** Shared (default 60 s, the port's "up to a minute"). */
  sharedTtlSec?: number;
}

const DefinitionsEnvelope = z.custom<ExperimentDefinition[]>((value) => Array.isArray(value));
const CACHE_KEY = "experiments";

/**
 * `Experiments` over the experiments table (`WEBFLIX_EXPERIMENTS=database`): definitions read
 * through two cache levels (process memory, then the shared cache), because assignment sits on
 * the browse path, which has a budget of two database round trips. A staff change calls
 * `invalidate` (this process at once, the others within the memory TTL: an experiment that is
 * stopped stops assigning within 30 s everywhere). Assignment is `assignVariants`.
 */
export function createRepositoryExperiments(options: RepositoryExperimentsOptions): Experiments {
  const memoryTtlMs = options.memoryTtlMs ?? 30_000;
  const shared = options.cache
    ? createJsonCache(options.cache, {
        schema: DefinitionsEnvelope,
        prefix: "webflix:v1:",
        ttlSec: options.sharedTtlSec ?? 60,
      })
    : null;
  let memo: { definitions: ExperimentDefinition[]; expiresAt: number } | null = null;

  async function load(): Promise<ExperimentDefinition[]> {
    const now = options.clock.now();
    if (memo && memo.expiresAt > now) return memo.definitions;
    let definitions = shared
      ? await shared.get(CACHE_KEY).catch((error: unknown) => {
          options.logger.warn("cache.read_failed", {
            key: CACHE_KEY,
            error: serializeError(error),
          });
          return null;
        })
      : null;
    if (definitions === null) {
      definitions = (await options.repository.listExperiments()).map((stored) => stored.definition);
      await shared?.set(CACHE_KEY, definitions).catch((error: unknown) => {
        options.logger.warn("cache.write_failed", { key: CACHE_KEY, error: serializeError(error) });
      });
    }
    memo = { definitions, expiresAt: options.clock.now() + memoryTtlMs };
    return definitions;
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
