import {
  type EventContext,
  EXPERIMENT_BUCKETS,
  type ExperimentAssignments,
  type ExperimentDefinition,
  type ExperimentList,
  type ExperimentResults,
  type JsonValue,
  type PlanId,
} from "@webflix/contracts";
import { hexEncode, randomBytes } from "../../encoding.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import {
  type AssignmentContext,
  assignVariants,
  type ExperimentUnit,
  type LazyAssignmentContext,
  overlappingAllocations,
  resolveAssignmentContext,
} from "../../ports/experiments.ts";
import { serializeError } from "../../ports/logger.ts";
import { DAY_MS } from "../../recommendations/hash.ts";
import type { ProfileRecord } from "../../repositories/records.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { standingOf } from "../../services/privileges.ts";
import { type AreaModule, type AreaSeams, NO_JOBS } from "../module.ts";
import { auditRecord, type StaffAction } from "./audit.ts";
import type { StoredExperiment } from "./repository.ts";

/** What staff design (the contract's `CreateExperimentBody` without its `reason`). */
export type ExperimentDesign = Omit<
  ExperimentDefinition,
  "status" | "salt" | "registeredAt" | "createdAt" | "updatedAt"
>;

/** A treatment a member actually experienced (milestone 2 §8.1: exposure, not assignment). */
export interface ExposureInput {
  experimentKey: string;
  variant: string;
  unit: ExperimentUnit;
  accountId: string | null;
  profileId: string | null;
  deviceId?: string | null;
  context?: Partial<EventContext>;
}

/** What `GET /session` knows about the caller (the identity area hands it over). */
export interface SessionAssignmentInput {
  /** The active profile, if any: the unit after sign-in. */
  profile: ProfileRecord | null;
  /** The anonymous device id (`GET /session?deviceId=`): the unit before sign-in. */
  deviceId: string | null;
  plan: PlanId | null;
  /** When the account was created (epoch ms), null signed out. */
  joinedAt: number | null;
  country?: string | null;
}

/** Exposures remembered per process before the shared marker is consulted. */
const EXPOSURE_MEMORY = 10_000;
/** How long a unit's exposure to one variant is remembered: logged once per unit and variant. */
const EXPOSURE_MARKER_TTL_SEC = 30 * 24 * 60 * 60;

/**
 * The experiments area (milestone 2 §8.1): definitions (through `deps.experiments`, cached by
 * the database adapter; staff edits through `repos.experiments` with their audit rows),
 * deterministic assignment (`assignVariants`: SHA-256 buckets, explicit allocations per layer),
 * exposure logging through `seams.emitServerEvent` once per unit and variant, and the analysis
 * results the admin console reads. Restricted profiles are never assigned.
 */
export interface ExperimentsService extends AreaModule {
  /** A unit's assignments; member facts are loaded only when an experiment targets them. */
  assignments(
    unit: ExperimentUnit,
    context: AssignmentContext | LazyAssignmentContext,
  ): Promise<ExperimentAssignments>;
  /** The caller's assignments for `GET /session`: the active profile's, else the device's. */
  sessionAssignments(input: SessionAssignmentInput): Promise<ExperimentAssignments>;
  /** Logs `experiment.exposure` once per unit and variant. Never throws. */
  logExposure(exposure: ExposureInput): Promise<void>;
  /** Drop cached definitions in this process and the shared cache (a staff change does it). */
  invalidateDefinitions(): Promise<void>;

  // --- Staff routes (handlers, role checks and audit context are the admin area's) ----------
  listExperiments(): Promise<ExperimentList>;
  getExperiment(key: string): Promise<ExperimentDefinition>;
  createExperiment(design: ExperimentDesign, staff: StaffAction): Promise<ExperimentDefinition>;
  updateExperiment(
    key: string,
    changes: Partial<Omit<ExperimentDesign, "key">>,
    staff: StaffAction,
  ): Promise<ExperimentDefinition>;
  setExperimentStatus(
    key: string,
    status: ExperimentDefinition["status"],
    staff: StaffAction,
  ): Promise<ExperimentDefinition>;
  getExperimentResults(key: string): Promise<ExperimentResults>;
  /** Stores an analysis report (the analysis job's import). */
  saveExperimentResults(key: string, report: JsonValue, computedAt: number): Promise<void>;
}

/** Status changes staff may make; anything else is `experiment_conflict`. */
const TRANSITIONS: Record<ExperimentDefinition["status"], ExperimentDefinition["status"][]> = {
  draft: ["running", "archived"],
  running: ["paused", "completed"],
  paused: ["running", "completed"],
  completed: ["archived"],
  archived: [],
};

export function createExperimentsService(
  deps: ServiceDependencies,
  seams: AreaSeams,
): ExperimentsService {
  const { repos, clock, logger } = deps;
  const exposed = new Set<string>();

  async function definitions(): Promise<ExperimentDefinition[]> {
    return deps.experiments.definitions();
  }

  async function assignments(
    unit: ExperimentUnit,
    context: AssignmentContext | LazyAssignmentContext,
  ): Promise<ExperimentAssignments> {
    if (context.restricted) return {};
    const all = await definitions();
    return assignVariants(
      all,
      unit,
      await resolveAssignmentContext(all, unit, context),
      clock.now(),
    );
  }

  async function stored(key: string): Promise<StoredExperiment> {
    const found = await repos.experiments.getExperiment(key);
    if (!found) throw new AppError("not_found", { detail: "No such experiment" });
    return found;
  }

  /** Refuses designs the assignment cannot honour. */
  function validate(definition: ExperimentDefinition): void {
    const problems: string[] = [];
    const { start, end } = definition.allocation;
    if (!(start < end) || start < 0 || end > EXPERIMENT_BUCKETS) {
      problems.push(`allocation must satisfy 0 <= start < end <= ${EXPERIMENT_BUCKETS}`);
    }
    const names = definition.variants.map((variant) => variant.name);
    if (new Set(names).size !== names.length) problems.push("variant names must be unique");
    if (!names.includes(definition.control)) problems.push("control must be one of the variants");
    if (
      definition.startsAt !== null &&
      definition.endsAt !== null &&
      Date.parse(definition.endsAt) <= Date.parse(definition.startsAt)
    ) {
      problems.push("endsAt must be after startsAt");
    }
    if (problems.length > 0) {
      throw new AppError("validation_failed", {
        detail: problems.join("; "),
        issues: problems.map((message) => ({
          location: "body" as const,
          path: "",
          message,
          code: "experiment_design",
        })),
      });
    }
  }

  /** Running experiments of one layer must own disjoint allocations. */
  async function assertNoOverlap(candidate: ExperimentDefinition): Promise<void> {
    if (candidate.status !== "running") return;
    const others = (await repos.experiments.listExperiments())
      .map((entry) => entry.definition)
      .filter((definition) => definition.key !== candidate.key);
    const conflicts = overlappingAllocations([...others, candidate]).filter((pair) =>
      pair.includes(candidate.key),
    );
    if (conflicts.length > 0) {
      throw new AppError("experiment_conflict", {
        detail: `Allocation overlaps running experiment ${conflicts
          .map(([a, b]) => (a === candidate.key ? b : a))
          .join(", ")} in layer ${candidate.layer}`,
      });
    }
  }

  async function save(
    current: StoredExperiment,
    next: ExperimentDefinition,
    staff: StaffAction,
    action: string,
  ): Promise<ExperimentDefinition> {
    const written = await repos.experiments.updateExperiment(
      next,
      current.version,
      auditRecord(
        staff,
        {
          action,
          target: { type: "experiment", id: next.key },
          before: current.definition,
          after: next,
        },
        deps.ids,
        clock.now(),
      ),
    );
    if (!written) {
      throw new AppError("experiment_conflict", {
        detail: "The experiment changed meanwhile: reload it and try again",
      });
    }
    await deps.experiments.invalidate?.();
    return next;
  }

  return {
    ...NO_JOBS,
    assignments,

    async sessionAssignments(input) {
      const unit: ExperimentUnit | null = input.profile
        ? { type: "profile", id: input.profile.id }
        : input.deviceId
          ? { type: "device", id: input.deviceId }
          : null;
      if (!unit) return {};
      const now = clock.now();
      return assignments(unit, {
        restricted: input.profile ? standingOf(input.profile) !== "unrestricted" : false,
        country: input.country ?? null,
        plan: input.plan,
        isNew:
          input.joinedAt !== null &&
          now - input.joinedAt < deps.config.experiments.newMemberDays * DAY_MS,
      });
    },

    async invalidateDefinitions() {
      await deps.experiments.invalidate?.();
    },

    async logExposure(exposure) {
      const marker = `${exposure.experimentKey}:${exposure.variant}:${exposure.unit.type}:${exposure.unit.id}`;
      if (exposed.has(marker)) return;
      try {
        const key = `webflix:v1:exposure:${marker}`;
        if ((await deps.cache.get(key)) === null) {
          await seams.emitServerEvent({
            type: "experiment.exposure",
            payload: {
              experimentKey: exposure.experimentKey,
              variant: exposure.variant,
              unitType: exposure.unit.type,
            },
            accountId: exposure.accountId,
            profileId: exposure.profileId,
            deviceId: exposure.deviceId ?? null,
            context: {
              ...exposure.context,
              experiments: {
                ...exposure.context?.experiments,
                [exposure.experimentKey]: exposure.variant,
              },
            },
          });
          await deps.cache.set(key, "1", { ttlSec: EXPOSURE_MARKER_TTL_SEC });
        }
        if (exposed.size >= EXPOSURE_MEMORY) exposed.clear();
        exposed.add(marker);
      } catch (error) {
        // Losing an exposure must not fail a member's page; the next page logs it.
        logger.warn("experiments.exposure_failed", { marker, error: serializeError(error) });
      }
    },

    async listExperiments() {
      return {
        items: (await repos.experiments.listExperiments()).map((entry) => entry.definition),
      };
    },

    async getExperiment(key) {
      return (await stored(key)).definition;
    },

    async createExperiment(design, staff) {
      const now = toIsoString(clock.now());
      const definition: ExperimentDefinition = {
        key: design.key,
        name: design.name,
        description: design.description,
        unit: design.unit,
        layer: design.layer,
        allocation: { ...design.allocation },
        targeting: structuredClone(design.targeting),
        variants: design.variants.map((variant) => ({ ...variant })),
        control: design.control,
        primaryMetric: design.primaryMetric,
        secondaryMetrics: [...design.secondaryMetrics],
        alpha: design.alpha,
        power: design.power,
        minimumDetectableEffect: design.minimumDetectableEffect,
        startsAt: design.startsAt,
        endsAt: design.endsAt,
        srmThreshold: design.srmThreshold,
        status: "draft",
        salt: hexEncode(randomBytes(8)),
        registeredAt: null,
        createdAt: now,
        updatedAt: now,
      };
      validate(definition);
      const created = await repos.experiments.createExperiment(
        definition,
        auditRecord(
          staff,
          {
            action: "experiment.create",
            target: { type: "experiment", id: definition.key },
            before: null,
            after: definition,
          },
          deps.ids,
          clock.now(),
        ),
      );
      if (!created) {
        throw new AppError("experiment_conflict", {
          detail: `An experiment with key ${definition.key} exists`,
        });
      }
      await deps.experiments.invalidate?.();
      return definition;
    },

    async updateExperiment(key, changes, staff) {
      const current = await stored(key);
      const { status } = current.definition;
      const designFields = Object.keys(changes).filter(
        (field) => changes[field as keyof typeof changes] !== undefined,
      );
      if (status !== "draft") {
        // A started experiment's design is fixed (pre-registration); only its end may move.
        const allowed = status === "running" || status === "paused" ? ["endsAt"] : [];
        const refused = designFields.filter((field) => !allowed.includes(field));
        if (refused.length > 0) {
          throw new AppError("experiment_conflict", {
            detail: `A ${status} experiment's ${refused.join(", ")} cannot change`,
          });
        }
      }
      const defined = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      ) as Partial<ExperimentDefinition>;
      const next: ExperimentDefinition = {
        ...current.definition,
        ...structuredClone(defined),
        key,
        updatedAt: toIsoString(clock.now()),
      };
      validate(next);
      return save(current, next, staff, "experiment.update");
    },

    async setExperimentStatus(key, status, staff) {
      const current = await stored(key);
      const from = current.definition.status;
      if (from === status) return current.definition;
      if (!TRANSITIONS[from].includes(status)) {
        throw new AppError("experiment_conflict", {
          detail: `An experiment cannot go from ${from} to ${status}`,
        });
      }
      const now = toIsoString(clock.now());
      const next: ExperimentDefinition = {
        ...current.definition,
        status,
        updatedAt: now,
        // Starting pre-registers it: the analysis refuses exposures before registration.
        ...(status === "running" && from === "draft"
          ? {
              registeredAt: current.definition.registeredAt ?? now,
              startsAt: current.definition.startsAt ?? now,
            }
          : {}),
      };
      await assertNoOverlap(next);
      return save(current, next, staff, "experiment.status");
    },

    async getExperimentResults(key) {
      await stored(key);
      const latest = await repos.experiments.latestResults(key);
      return {
        key,
        computedAt: latest ? toIsoString(latest.computedAt) : null,
        report: latest?.report ?? null,
      };
    },

    async saveExperimentResults(key, report, computedAt) {
      await stored(key);
      await repos.experiments.saveResults(key, { computedAt, report });
    },
  };
}
