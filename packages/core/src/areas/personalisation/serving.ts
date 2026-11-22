import type { ExperimentAssignments, PlanId, RankingPolicy } from "@webflix/contracts";
import * as z from "zod";
import { TwoLevel } from "../../catalog/cache.ts";
import { createJsonCache, type JsonCache } from "../../ports/cache.ts";
import { createSubjectKeys, type SubjectKeys } from "../../ports/event-sink.ts";
import type { LazyAssignmentContext } from "../../ports/experiments.ts";
import { serializeError } from "../../ports/logger.ts";
import type {
  Neighbour,
  ProfileLists,
  RecommendationModel,
  ServingSnapshot,
} from "../../ports/recommendation-store.ts";
import type { EditorialInput } from "../../recommendations/engine.ts";
import { mixed01, utcDay } from "../../recommendations/hash.ts";
import type { ServiceDependencies, Viewer } from "../../services/context.ts";
import { standingOf } from "../../services/privileges.ts";
import type { AreaSeams } from "../module.ts";
import { type EditorialData, isUnavailable } from "./repository.ts";

/**
 * Hybrid serving (milestone 2 §7.2, docs/RECOMMENDATIONS.md "Learned candidates"): for one
 * profile's page, which ranking policy applies and the learned candidates it may use. The
 * engine (recommendations/engine.ts) stays the authority for every rule; this only decides
 * what it is handed:
 *
 * - **Restricted profiles** (kids, lowered ceiling) get the rule engine, always: no learned
 *   data, no experiment.
 * - **Policy**: the experiment `WEBFLIX_RECS_EXPERIMENT` decides when it assigns the profile
 *   (its control variant: the rule engine; any other: learned); otherwise
 *   `WEBFLIX_RECS_DEFAULT_POLICY`. An exposure is logged (both arms) when the treatment can
 *   actually apply, that is when a fresh model is active; never on assignment alone.
 * - **Fallback is cold start, not an error**: no active model, a model past its `expiresAt`, a
 *   store that fails or answers slower than `WEBFLIX_RECS_READ_TIMEOUT_MS`: the rule engine.
 *   No lists for the profile (new, or not in the run): the learned policy without personal
 *   scores (neighbours still drive More Like This, Because You Watched and session re-ranking).
 * - **Exploration**: a deterministic share of sessions (`WEBFLIX_RECS_EXPLORE_SHARE`, by
 *   session and UTC day) gets rows and items in random order, whatever the policy, and says so
 *   in `policy.explore`: without it position bias cannot be estimated from real traffic.
 *
 * Budget: the active model and its neighbours are one cached object (process memory, then the
 * shared cache, then one database read); a profile's lists are one read (Workers KV on
 * Cloudflare; on SQL through a cache, since a run's lists never change once it is active). A
 * warm browse therefore adds no database round trip.
 */
export interface ServingPlan {
  /** Copied into `BrowsePage.policy` and from there into impressions and title-opens. */
  policy: RankingPolicy;
  /** What staff decided (pinned billboards, curated rows, unavailable titles); null: none. */
  editorial: EditorialInput | null;
  /** Null: the rule engine alone. */
  learned: LearnedCandidates | null;
  /** Seed of this page's exploration order; null when the page is not exploring. */
  exploreSeed: string | null;
}

export interface LearnedCandidates {
  run: string;
  /** The active run's neighbours by source title, by rank. */
  neighbours: ReadonlyMap<string, readonly Neighbour[]>;
  /** The profile's fresh lists, or null (none in this run, or expired). */
  lists: ProfileLists | null;
}

/** Facts the experiment targeting may need, loaded only if a running experiment targets them. */
export type MemberFacts = (
  accountId: string,
) => Promise<{ plan: PlanId | null; joinedAt: number | null }>;

/**
 * The ranking policy's label (`BrowsePage.policy.id`, copied into impressions and title-opens;
 * the ranker's position-bias estimate and the experiment analysis read it): `rules` when nothing
 * from a model shaped the page, `neighbours:{run}` when the rule engine was helped by a fresh
 * model's neighbours but the profile has no personal list, `learned:{run}` only when a fresh
 * personal list ranked the page.
 */
export const RULES_POLICY_ID = "rules";
export const neighboursPolicyId = (run: string): string => `neighbours:${run}`;
export const learnedPolicyId = (run: string): string => `learned:${run}`;

/** The label of a page the engine composed under `plan` (what the model actually contributed). */
export function policyFor(
  plan: ServingPlan,
  use: "personal" | "neighbours" | "none",
): RankingPolicy {
  const explore = plan.policy.explore;
  if (!plan.learned || use === "none") return { id: RULES_POLICY_ID, explore };
  return {
    id:
      use === "personal" ? learnedPolicyId(plan.learned.run) : neighboursPolicyId(plan.learned.run),
    explore,
  };
}

interface ModelData {
  model: RecommendationModel;
  /** [titleId, [neighbourId, score, support][]] by title. */
  neighbours: [string, [string, number, number][]][];
}

interface ModelSnapshot {
  model: RecommendationModel;
  neighbours: Map<string, Neighbour[]>;
}

const ModelEnvelope = z.custom<{ data: ModelData | null }>(
  (value) => typeof value === "object" && value !== null && "data" in value,
);
const EditorialEnvelope = z.custom<EditorialData>(
  (value) => typeof value === "object" && value !== null && "collections" in value,
);
const ListsEnvelope = z.custom<{ lists: ProfileLists | null }>(
  (value) => typeof value === "object" && value !== null && "lists" in value,
);

/** Profile keys memoised per process (an HMAC per page otherwise). */
const PROFILE_KEY_MEMORY = 10_000;
/** Per-profile lists remembered per process on SQL stores. */
const LISTS_MEMORY = 5_000;
const LISTS_TTL_MS = 10 * 60_000;
/** How long a member's plan and join date are remembered for experiment targeting. */
const MEMBER_FACTS_TTL_MS = 60_000;
/**
 * The oldest a copy of the served model (and of the editorial data) is ever used, counted from
 * its database read, on every instance and through every cache level: an import or a staff
 * change made by another process is served everywhere within this.
 */
export const MODEL_MAX_AGE_MS = 30_000;
/** How long serving skips a store whose model read failed. */
const STORE_RETRY_MS = 30_000;

function compact(snapshot: ServingSnapshot): ModelData {
  const byTitle = new Map<string, [string, number, number][]>();
  for (const row of snapshot.neighbours) {
    const list = byTitle.get(row.titleId) ?? [];
    list.push([row.neighbourId, row.score, row.support]);
    byTitle.set(row.titleId, list);
  }
  return { model: snapshot.model, neighbours: [...byTitle] };
}

function expand(data: ModelData): ModelSnapshot {
  const neighbours = new Map<string, Neighbour[]>();
  for (const [titleId, rows] of data.neighbours) {
    neighbours.set(
      titleId,
      rows.map(([neighbourId, score, support], index) => ({
        titleId,
        rank: index + 1,
        neighbourId,
        score,
        support,
      })),
    );
  }
  return { model: data.model, neighbours };
}

export class RecommendationServing {
  private readonly deps: ServiceDependencies;
  private readonly seams: AreaSeams;
  private readonly models: TwoLevel<ModelSnapshot | null, { data: ModelData | null }>;
  private readonly editorialData: TwoLevel<EditorialData, EditorialData>;
  private readonly sharedLists: JsonCache<{ lists: ProfileLists | null }> | null;
  private readonly memoryLists = new Map<
    string,
    { lists: ProfileLists | null; expiresAt: number }
  >();
  private readonly profileKeys = new Map<string, string>();
  private readonly memberFacts = new Map<
    string,
    { facts: Awaited<ReturnType<MemberFacts>>; expiresAt: number }
  >();
  private readonly subjectKeys: SubjectKeys;
  /** After a failed model load, pages skip the store for a while instead of each waiting. */
  private storeUnavailableUntil = 0;

  constructor(deps: ServiceDependencies, seams: AreaSeams) {
    this.deps = deps;
    this.seams = seams;
    this.subjectKeys = createSubjectKeys(deps.config.events.pseudonymKey);
    this.models = new TwoLevel(deps.cache, {
      prefix: "webflix:v1:",
      schema: ModelEnvelope,
      // A run another process imported (the importer CLI, a Job beside several replicas) is
      // seen everywhere within `MODEL_MAX_AGE_MS`: no copy of the model is used longer.
      maxAgeMs: MODEL_MAX_AGE_MS,
      sharedTtlSec: 60,
      key: () => "recs-model",
      load: async () => {
        const snapshot = await this.withTimeout(deps.recommendations.servingSnapshot());
        return { data: snapshot ? compact(snapshot) : null };
      },
      build: (envelope) => (envelope.data ? expand(envelope.data) : null),
      clock: deps.clock,
      logger: deps.logger,
      memoryTtlMs: 30_000,
    });
    // Staff decisions change rarely and are read by every page: cached like the catalogue.
    this.editorialData = new TwoLevel(deps.cache, {
      prefix: "webflix:v1:",
      schema: EditorialEnvelope,
      sharedTtlSec: 300,
      key: () => "editorial",
      // A staff decision made on another replica is seen everywhere within the same bound.
      maxAgeMs: MODEL_MAX_AGE_MS,
      load: () => deps.repos.personalisation.loadEditorial(),
      build: (data) => data,
      clock: deps.clock,
      logger: deps.logger,
      memoryTtlMs: 30_000,
    });
    // On SQL a profile's lists are a database read: cached (a run's lists never change once it
    // is served). Workers KV is itself the cache; the memory store needs none.
    this.sharedLists =
      deps.config.personalisation.recommendationStore === "database"
        ? createJsonCache(deps.cache, {
            schema: ListsEnvelope,
            prefix: "webflix:v1:recs-lists:",
            ttlSec: LISTS_TTL_MS / 1000,
          })
        : null;
  }

  /** Forget the cached editorial data (after a staff change in this process). */
  invalidateEditorial(): Promise<void> {
    return this.editorialData.invalidate();
  }

  /**
   * Staff decisions as the engine takes them, for every profile (restricted ones too: an
   * unavailable title is unavailable to everyone). A read failure means none: never an error.
   */
  async editorial(now: number): Promise<EditorialInput | null> {
    try {
      const data = await this.editorialData.get();
      if (
        data.billboards.length === 0 &&
        data.collections.length === 0 &&
        data.availability.length === 0
      ) {
        return null;
      }
      return {
        billboards: new Map(
          data.billboards.map((billboard) => [billboard.view, billboard.titleIds]),
        ),
        collections: data.collections.map((collection) => ({
          id: collection.id,
          name: collection.name,
          view: collection.view,
          position: collection.position,
          titleIds: collection.titleIds,
        })),
        unavailable: new Set(
          data.availability
            .filter((record) => isUnavailable(record, now))
            .map((record) => record.titleId),
        ),
      };
    } catch (error) {
      this.deps.logger.warn("editorial.unavailable", { error: serializeError(error) });
      return null;
    }
  }

  /**
   * Forget erased profiles' cached lists, in this process and the shared cache, for every run
   * given (account deletion: nothing of them may be served from a cache afterwards).
   */
  async forgetProfiles(runs: readonly string[], profileKeys: readonly string[]): Promise<void> {
    const keys = runs.flatMap((run) => profileKeys.map((profileKey) => `${run}:${profileKey}`));
    for (const key of keys) this.memoryLists.delete(key);
    await Promise.all(keys.map((key) => this.sharedLists?.delete(key).catch(() => undefined)));
  }

  /** Forget the cached model and lists (after an import or a rollback in this process). */
  async invalidate(): Promise<void> {
    const remembered = [...this.memoryLists.keys()];
    this.memoryLists.clear();
    await Promise.all([
      this.models.invalidate(),
      ...remembered.map((key) => this.sharedLists?.delete(key).catch(() => undefined)),
    ]);
  }

  /** The plan of one profile's page. Never throws: any failure is the rule engine. */
  async plan(viewer: Viewer, memberFacts?: MemberFacts): Promise<ServingPlan> {
    const { config, clock } = this.deps;
    const now = clock.now();
    const exploreSeed = this.exploreSeed(viewer.session.id, now);
    const restricted = standingOf(viewer.profile) !== "unrestricted";
    const unit = { type: "profile" as const, id: viewer.profile.id };
    // Independent reads side by side (each is cached; on a cold process each is one read).
    const [editorial, snapshot, assigned] = await Promise.all([
      this.editorial(now),
      restricted ? null : this.model(now),
      restricted
        ? ({} as ExperimentAssignments)
        : this.seams
            .assignments(unit, this.context(viewer, memberFacts))
            .catch((error: unknown): ExperimentAssignments => {
              this.deps.logger.warn("recs.assignment_failed", { error: serializeError(error) });
              return {};
            }),
    ]);
    const rules: ServingPlan = {
      policy: { id: RULES_POLICY_ID, explore: exploreSeed !== null },
      editorial,
      learned: null,
      exploreSeed,
    };
    if (restricted) return rules;
    try {
      const { experimentKey, defaultPolicy } = config.personalisation;
      const variant = assigned[experimentKey];
      // Read after the assignment (which loaded and cached the definitions): no second read.
      const control =
        variant === undefined
          ? undefined
          : (await this.deps.experiments.definitions()).find(
              (definition) => definition.key === experimentKey,
            )?.control;
      const policy =
        variant === undefined ? defaultPolicy : variant === control ? "rules" : "learned";
      // The treatment applies only with a fresh model: a stale or missing one is cold start for
      // both arms, so nobody is exposed to a difference that does not exist.
      if (!snapshot || snapshot.model.expiresAt <= now) return rules;
      if (variant !== undefined) {
        await this.seams.logExposure({
          experimentKey,
          variant,
          unit,
          accountId: viewer.session.accountId,
          profileId: viewer.profile.id,
          // The page's own label follows on its impressions; the exposure says which arm.
          context: { experiments: assigned },
        });
      }
      if (policy === "rules") return rules;
      const lists = await this.lists(snapshot.model.run, viewer.profile.id, now);
      // Provisional: the label is decided once the engine knows what the model contributed
      // (`policyFor`); a learned plan's page may still be exactly the rule engine's.
      return {
        policy: {
          id: lists ? learnedPolicyId(snapshot.model.run) : neighboursPolicyId(snapshot.model.run),
          explore: exploreSeed !== null,
        },
        editorial,
        learned: { run: snapshot.model.run, neighbours: snapshot.neighbours, lists },
        exploreSeed,
      };
    } catch (error) {
      this.deps.logger.warn("recs.serving_fallback", {
        profileId: viewer.profile.id,
        error: serializeError(error),
      });
      return rules;
    }
  }

  /**
   * The pseudonymous profile key the pipeline files lists under: the lake's own subject key
   * (`createSubjectKeys`, the events area's, matching the pipeline's `ids.pseudonym`), so a
   * profile's lists are found under exactly the key its behaviour was recorded with.
   */
  async profileKey(profileId: string): Promise<string> {
    const known = this.profileKeys.get(profileId);
    if (known) return known;
    const key = await this.subjectKeys.profile(profileId);
    if (this.profileKeys.size >= PROFILE_KEY_MEMORY) this.profileKeys.clear();
    this.profileKeys.set(profileId, key);
    return key;
  }

  /** The active model, or null (none, or the store is failing: retried after a pause). */
  private async model(now: number): Promise<ModelSnapshot | null> {
    if (now < this.storeUnavailableUntil) return null;
    try {
      return await this.models.get();
    } catch (error) {
      this.storeUnavailableUntil = now + STORE_RETRY_MS;
      this.deps.logger.warn("recs.model_unavailable", { error: serializeError(error) });
      return null;
    }
  }

  /** In the exploration slice: a stable share of sessions, re-drawn each UTC day. */
  private exploreSeed(sessionId: string, now: number): string | null {
    const seed = `${sessionId}:${utcDay(now)}`;
    return mixed01(`explore:${seed}`) < this.deps.config.personalisation.exploreShare ? seed : null;
  }

  private context(viewer: Viewer, memberFacts: MemberFacts | undefined): LazyAssignmentContext {
    const newMemberMs = this.deps.config.experiments.newMemberDays * 86_400_000;
    return {
      // Restricted profiles never reach here (`plan`); stated anyway, the experiments area
      // refuses them by itself too.
      restricted: standingOf(viewer.profile) !== "unrestricted",
      country: null,
      member: async () => {
        if (!memberFacts) return { plan: null, isNew: false };
        // Remembered for a minute: a plan-targeted experiment must not cost each page a read.
        const now = this.deps.clock.now();
        const accountId = viewer.session.accountId;
        let remembered = this.memberFacts.get(accountId);
        if (!remembered || remembered.expiresAt <= now) {
          remembered = {
            facts: await memberFacts(accountId),
            expiresAt: now + MEMBER_FACTS_TTL_MS,
          };
          if (this.memberFacts.size >= PROFILE_KEY_MEMORY) this.memberFacts.clear();
          this.memberFacts.set(accountId, remembered);
        }
        const { facts } = remembered;
        return {
          plan: facts.plan,
          isNew: facts.joinedAt !== null && this.deps.clock.now() - facts.joinedAt < newMemberMs,
        };
      },
    };
  }

  /**
   * A profile's lists, or null. A store that fails or is slow costs this page its personal
   * scores only (the learned policy still has the neighbours), and is not remembered.
   */
  private async lists(run: string, profileId: string, now: number): Promise<ProfileLists | null> {
    const profileKey = await this.profileKey(profileId);
    const cacheKey = `${run}:${profileKey}`;
    const fresh = (lists: ProfileLists | null) => (lists && lists.expiresAt > now ? lists : null);
    const remembered = this.memoryLists.get(cacheKey);
    if (remembered && remembered.expiresAt > now) return fresh(remembered.lists);
    let envelope = this.sharedLists ? await this.sharedLists.get(cacheKey).catch(() => null) : null;
    if (envelope === null) {
      try {
        envelope = {
          lists: await this.withTimeout(
            this.deps.recommendations.profileLists(run, profileKey, now),
          ),
        };
      } catch (error) {
        this.deps.logger.warn("recs.lists_unavailable", { run, error: serializeError(error) });
        return null;
      }
      // Cached with its absence too: a profile without lists must not cost a read per page.
      await this.sharedLists?.set(cacheKey, envelope).catch(() => undefined);
    }
    if (this.sharedLists) {
      if (this.memoryLists.size >= LISTS_MEMORY) this.memoryLists.clear();
      this.memoryLists.set(cacheKey, { lists: envelope.lists, expiresAt: now + LISTS_TTL_MS });
    }
    return fresh(envelope.lists);
  }

  /** A store read that answers too slowly counts as unavailable: the page must not wait. */
  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const ms = this.deps.config.personalisation.readTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Recommendation store did not answer within ${ms} ms`)),
          ms,
        );
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}
