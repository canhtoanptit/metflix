import {
  EXPERIMENT_BUCKETS,
  type ExperimentAssignments,
  type ExperimentDefinition,
  type PlanId,
} from "@webflix/contracts";
import { utf8Encode } from "../encoding.ts";

/**
 * Port: experiment definitions and deterministic assignment (milestone 2 §3, §8.1). Definitions
 * live in the database (with a KV cache on Cloudflare); assignment is `assignVariants`, one
 * portable function every adapter calls, so a unit gets the same variant in every mode.
 *
 * Contract (`describeExperimentsContract`):
 * - Deterministic: the same unit, experiment and salt always give the same variant.
 * - Only `running` experiments within their dates, for the unit's type (profile, or device
 *   before sign-in), that target the unit (plan, country, new or existing member, percentage).
 * - Mutual exclusion: experiments of one layer own disjoint allocations of the layer's buckets,
 *   so a unit is in at most one experiment per layer.
 * - Variants split by weight; changing the salt reshuffles every unit.
 * - Exposure is logged by the caller when the treatment is experienced, never here.
 */
export interface Experiments {
  /** Every definition (all statuses); adapters may cache for up to a minute. */
  definitions(): Promise<ExperimentDefinition[]>;
  /** Forget cached definitions (after a staff change): optional, for caching adapters. */
  invalidate?(): Promise<void>;
  /** The unit's assignments: experiment key → variant. */
  assign(
    unit: ExperimentUnit,
    context: AssignmentContext,
    now: number,
  ): Promise<ExperimentAssignments>;
}

export interface ExperimentUnit {
  type: "profile" | "device";
  id: string;
}

export interface AssignmentContext {
  plan: PlanId | null;
  /** ISO 3166-1 alpha-2, when known. */
  country: string | null;
  /** A member who joined within the targeting's notion of new (decided by the caller). */
  isNew: boolean;
  /** Restricted profiles (kids, lowered ceiling) are never in experiments (§6.3). */
  restricted: boolean;
}

/**
 * An assignment context whose member facts (plan, new or existing) are loaded only when a
 * running experiment for the unit's type targets them, so the hot paths (browse) pay for the
 * lookup only while such an experiment exists.
 */
export interface LazyAssignmentContext {
  restricted: boolean;
  country: string | null;
  member(): Promise<Pick<AssignmentContext, "plan" | "isNew">>;
}

/** Whether any running experiment for `unit`'s type targets plans or new/existing members. */
export function needsMemberFacts(
  definitions: readonly ExperimentDefinition[],
  unit: ExperimentUnit,
): boolean {
  return definitions.some(
    (definition) =>
      definition.status === "running" &&
      definition.unit === unit.type &&
      (definition.targeting.plans.length > 0 || definition.targeting.audience !== "all"),
  );
}

/** The full context: member facts loaded only when an experiment needs them. */
export async function resolveAssignmentContext(
  definitions: readonly ExperimentDefinition[],
  unit: ExperimentUnit,
  context: AssignmentContext | LazyAssignmentContext,
): Promise<AssignmentContext> {
  if (!("member" in context)) return context;
  const base = { restricted: context.restricted, country: context.country };
  if (context.restricted || !needsMemberFacts(definitions, unit)) {
    return { ...base, plan: null, isNew: false };
  }
  return { ...base, ...(await context.member()) };
}

/** Bucket in [0, buckets) of a string: the first 32 bits of its SHA-256, reduced. */
export async function hashBucket(
  text: string,
  buckets: number = EXPERIMENT_BUCKETS,
): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8Encode(text)));
  const value =
    (((digest[0] ?? 0) << 24) |
      ((digest[1] ?? 0) << 16) |
      ((digest[2] ?? 0) << 8) |
      (digest[3] ?? 0)) >>>
    0;
  return Math.floor((value / 0x1_0000_0000) * buckets);
}

function eligible(
  definition: ExperimentDefinition,
  unit: ExperimentUnit,
  context: AssignmentContext,
  now: number,
): boolean {
  if (definition.status !== "running" || definition.unit !== unit.type || context.restricted) {
    return false;
  }
  if (definition.startsAt !== null && Date.parse(definition.startsAt) > now) return false;
  if (definition.endsAt !== null && Date.parse(definition.endsAt) <= now) return false;
  const { targeting } = definition;
  if (
    targeting.plans.length > 0 &&
    (context.plan === null || !targeting.plans.includes(context.plan))
  ) {
    return false;
  }
  if (
    targeting.countries.length > 0 &&
    (context.country === null || !targeting.countries.includes(context.country))
  ) {
    return false;
  }
  if (targeting.audience === "new" && !context.isNew) return false;
  if (targeting.audience === "existing" && context.isNew) return false;
  return true;
}

/**
 * The one assignment function (portable, deterministic). For each eligible experiment: the
 * unit's bucket in the experiment's layer must fall in its allocation, then within its
 * targeting percentage (hashed with the salt), then a weighted variant (hashed with the salt).
 */
export async function assignVariants(
  definitions: readonly ExperimentDefinition[],
  unit: ExperimentUnit,
  context: AssignmentContext,
  now: number,
): Promise<ExperimentAssignments> {
  const assignments: ExperimentAssignments = {};
  for (const definition of definitions) {
    if (!eligible(definition, unit, context, now)) continue;
    const layerBucket = await hashBucket(`layer:${definition.layer}:${unit.type}:${unit.id}`);
    const { start, end } = definition.allocation;
    if (layerBucket < start || layerBucket >= end) continue;
    const enrolment = await hashBucket(`enrol:${definition.key}:${definition.salt}:${unit.id}`);
    if (enrolment >= definition.targeting.percentage * (EXPERIMENT_BUCKETS / 100)) continue;
    const total = definition.variants.reduce((sum, variant) => sum + variant.weight, 0);
    const point =
      ((await hashBucket(`variant:${definition.key}:${definition.salt}:${unit.id}`)) /
        EXPERIMENT_BUCKETS) *
      total;
    let cumulative = 0;
    for (const variant of definition.variants) {
      cumulative += variant.weight;
      if (point < cumulative) {
        assignments[definition.key] = variant.name;
        break;
      }
    }
  }
  return assignments;
}

/**
 * Running experiments of one layer whose allocations overlap: a configuration the admin API
 * must refuse (`experiment_conflict`). Returns the overlapping key pairs.
 */
export function overlappingAllocations(
  definitions: readonly ExperimentDefinition[],
): [string, string][] {
  const running = definitions.filter((definition) => definition.status === "running");
  const overlaps: [string, string][] = [];
  for (const [index, a] of running.entries()) {
    for (const b of running.slice(index + 1)) {
      if (a.layer !== b.layer) continue;
      if (a.allocation.start < b.allocation.end && b.allocation.start < a.allocation.end) {
        overlaps.push([a.key, b.key]);
      }
    }
  }
  return overlaps;
}
