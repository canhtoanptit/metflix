/**
 * Milestone 2 experimentation (docs/BLUEPRINT-M2.md §8.1). Definitions live in the database
 * and are pre-registered: the fields the analysis job needs match
 * services/recs/schemas/experiment-definitions.schema.json, which an export maps onto.
 */
import * as z from "zod";
import { IsoDateTime, JsonValue } from "./common.ts";
import {
  EXPERIMENT_AUDIENCES,
  EXPERIMENT_BUCKETS,
  EXPERIMENT_METRICS,
  EXPERIMENT_STATUSES,
  EXPERIMENT_UNIT_TYPES,
} from "./constants.ts";
import { PlanId } from "./plans.ts";

/** Lowercase, dotted or dashed: `recs.learned-vs-rules`. Also an event `context.experiments` key. */
export const ExperimentKey = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Invalid experiment key")
  .meta({ id: "ExperimentKey" });

export const VariantName = z.string().min(1).max(64);

/** key → variant: what the caller is assigned to (`GET /session`, events' context). */
export const ExperimentAssignments = z
  .record(ExperimentKey, VariantName)
  .meta({ id: "ExperimentAssignments" });
export type ExperimentAssignments = z.output<typeof ExperimentAssignments>;

export const ExperimentVariant = z
  .object({
    name: VariantName,
    /** Design weight; weights need not sum to 1 (they are normalised). */
    weight: z.number().positive(),
  })
  .meta({ id: "ExperimentVariant" });

export const ExperimentTargeting = z
  .object({
    /** Share of eligible units enrolled, 0-100. */
    percentage: z.number().min(0).max(100),
    /** Empty: every plan. */
    plans: z.array(PlanId),
    /** ISO 3166-1 alpha-2; empty: every country. */
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)),
    audience: z.enum(EXPERIMENT_AUDIENCES),
  })
  .meta({ id: "ExperimentTargeting" });

/**
 * Units are hashed into `EXPERIMENT_BUCKETS` buckets per layer; experiments of one layer own
 * disjoint `[start, end)` ranges, so a unit is in at most one experiment per layer.
 */
export const ExperimentAllocation = z
  .object({
    start: z.number().int().min(0).max(EXPERIMENT_BUCKETS),
    end: z.number().int().min(0).max(EXPERIMENT_BUCKETS),
  })
  .meta({ id: "ExperimentAllocation" });

const definitionFields = {
  key: ExperimentKey,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  unit: z.enum(EXPERIMENT_UNIT_TYPES),
  layer: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  allocation: ExperimentAllocation,
  targeting: ExperimentTargeting,
  variants: z.array(ExperimentVariant).min(2),
  /** The control variant's name (default: the first). */
  control: VariantName,
  primaryMetric: z.enum(EXPERIMENT_METRICS),
  secondaryMetrics: z.array(z.enum(EXPERIMENT_METRICS)),
  alpha: z.number().positive().max(0.5),
  power: z.number().positive().lt(1).nullable(),
  /** Relative effect on the primary metric the experiment is sized for. */
  minimumDetectableEffect: z.number().positive(),
  startsAt: IsoDateTime.nullable(),
  endsAt: IsoDateTime.nullable(),
  srmThreshold: z.number().positive().max(0.1).nullable(),
};

export const ExperimentDefinition = z
  .object({
    ...definitionFields,
    status: z.enum(EXPERIMENT_STATUSES),
    /**
     * When `status` takes effect for assignment, at the same instant on every replica and
     * isolate (null: in effect). Definitions are cached per instance, so a start, pause or stop
     * is scheduled a short while ahead (`WEBFLIX_EXPERIMENTS_PROPAGATION_SEC`) instead of
     * reaching instances one by one; until then units are assigned as under `previousStatus`.
     */
    statusChangeAt: IsoDateTime.nullable(),
    /** The status assignment follows until `statusChangeAt` (null: none pending). */
    previousStatus: z.enum(EXPERIMENT_STATUSES).nullable(),
    /** Changing the salt reshuffles every unit: only before an experiment starts. */
    salt: z.string().min(1).max(64),
    /** When it was pre-registered (became `running` the first time). */
    registeredAt: IsoDateTime.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .meta({ id: "ExperimentDefinition" });
export type ExperimentDefinition = z.output<typeof ExperimentDefinition>;

export const ExperimentList = z
  .object({ items: z.array(ExperimentDefinition) })
  .meta({ id: "ExperimentList" });
export type ExperimentList = z.output<typeof ExperimentList>;

/** The analysis job's latest report (services/recs schemas/experiment-report.schema.json). */
export const ExperimentResults = z
  .object({
    key: ExperimentKey,
    computedAt: IsoDateTime.nullable(),
    report: JsonValue.nullable(),
  })
  .meta({ id: "ExperimentResults" });
export type ExperimentResults = z.output<typeof ExperimentResults>;

export const ExperimentKeyParams = z.object({ key: ExperimentKey });

export { definitionFields as experimentDefinitionFields };
