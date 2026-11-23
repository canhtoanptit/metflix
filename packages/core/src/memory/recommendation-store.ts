import {
  assertNeighbours,
  assertProfileLists,
  MAX_PROFILE_ERASURE,
  type Neighbour,
  type NewRecommendationModel,
  type ProfileLists,
  type RecommendationModel,
  type RecommendationStore,
  type ServingSnapshot,
} from "../ports/recommendation-store.ts";

/** Profile keys per `profileKeys` page (small, so the paging is exercised). */
const PROFILE_KEYS_PAGE = 100;

/** In-process `RecommendationStore` (tests; any mode configured with `memory`). */
export class MemoryRecommendationStore implements RecommendationStore {
  private readonly registered = new Map<string, RecommendationModel>();
  /** run → title → rank → row. */
  private readonly neighbourRows = new Map<string, Map<string, Map<number, Neighbour>>>();
  /** run → profile key → lists. */
  private readonly lists = new Map<string, Map<string, ProfileLists>>();

  async activeModel(): Promise<RecommendationModel | null> {
    const active = [...this.registered.values()].find((model) => model.status === "active");
    return active ? { ...active } : null;
  }

  async models(): Promise<RecommendationModel[]> {
    return [...this.registered.values()]
      .sort((a, b) => b.importedAt - a.importedAt || b.run.localeCompare(a.run))
      .map((model) => ({ ...model }));
  }

  async servingSnapshot(): Promise<ServingSnapshot | null> {
    const model = await this.activeModel();
    if (!model) return null;
    const byTitle = this.neighbourRows.get(model.run) ?? new Map<string, Map<number, Neighbour>>();
    const neighbours = [...byTitle.keys()]
      .sort(compareBytes)
      .flatMap((titleId) =>
        [...(byTitle.get(titleId)?.values() ?? [])]
          .sort((a, b) => a.rank - b.rank)
          .map((row) => ({ ...row })),
      );
    return { model, neighbours };
  }

  async profileLists(run: string, profileKey: string, now: number): Promise<ProfileLists | null> {
    const found = this.lists.get(run)?.get(profileKey);
    if (!found || found.expiresAt <= now) return null;
    return structuredClone(found);
  }

  async beginImport(model: NewRecommendationModel): Promise<void> {
    const existing = this.registered.get(model.run);
    if (existing?.status === "active") throw new Error(`Run ${model.run} is being served`);
    this.registered.set(model.run, {
      ...model,
      status: "importing",
      activatedAt: existing?.activatedAt ?? null,
      finishedAt: null,
      error: null,
    });
  }

  async putNeighbours(run: string, rows: readonly Neighbour[]): Promise<void> {
    assertNeighbours(rows);
    this.requireBegun(run);
    let byTitle = this.neighbourRows.get(run);
    if (!byTitle) {
      byTitle = new Map();
      this.neighbourRows.set(run, byTitle);
    }
    for (const row of rows) {
      let ranks = byTitle.get(row.titleId);
      if (!ranks) {
        ranks = new Map();
        byTitle.set(row.titleId, ranks);
      }
      ranks.set(row.rank, { ...row });
    }
  }

  async putProfileLists(run: string, lists: readonly ProfileLists[]): Promise<void> {
    assertProfileLists(run, lists);
    this.requireBegun(run);
    let byProfile = this.lists.get(run);
    if (!byProfile) {
      byProfile = new Map();
      this.lists.set(run, byProfile);
    }
    for (const list of lists) byProfile.set(list.profileKey, structuredClone(list));
  }

  async failImport(run: string, error: string): Promise<void> {
    const model = this.requireBegun(run);
    if (model.status === "active") throw new Error(`Run ${run} is being served`);
    this.registered.set(run, { ...model, status: "failed", error });
  }

  async activate(run: string, now: number): Promise<void> {
    const target = this.registered.get(run);
    if (!target || target.status === "failed") {
      throw new Error(`Run ${run} cannot be activated (${target?.status ?? "unknown"})`);
    }
    for (const [key, model] of this.registered) {
      if (model.status === "active" && key !== run) {
        this.registered.set(key, { ...model, status: "ready" });
      }
    }
    this.registered.set(run, {
      ...target,
      status: "active",
      activatedAt: now,
      finishedAt: target.finishedAt ?? now,
    });
  }

  async deleteRun(run: string): Promise<void> {
    if (this.registered.get(run)?.status === "active") {
      throw new Error("The active run cannot be deleted");
    }
    this.registered.delete(run);
    this.neighbourRows.delete(run);
    this.lists.delete(run);
  }

  async deleteProfileLists(profileKeys: readonly string[]): Promise<void> {
    if (profileKeys.length > MAX_PROFILE_ERASURE) throw new RangeError("Too many profile keys");
    for (const byProfile of this.lists.values()) {
      for (const key of profileKeys) byProfile.delete(key);
    }
  }

  async profileKeys(
    run: string,
    cursor: string | null,
  ): Promise<{ keys: string[]; cursor: string | null }> {
    const keys = [...(this.lists.get(run)?.keys() ?? [])].sort(compareBytes);
    const after = cursor === null ? keys : keys.filter((key) => key > cursor);
    const page = after.slice(0, PROFILE_KEYS_PAGE);
    return {
      keys: page,
      cursor: after.length > PROFILE_KEYS_PAGE ? (page[page.length - 1] ?? null) : null,
    };
  }

  async recordManifest(run: string, manifestSha256: string): Promise<void> {
    const model = this.requireBegun(run);
    this.registered.set(run, { ...model, manifestSha256 });
  }

  private requireBegun(run: string): RecommendationModel {
    const model = this.registered.get(run);
    if (!model) throw new Error(`Run ${run} was not begun`);
    return model;
  }
}

/** Byte order of UTF-16 strings that are ASCII ids (title ids): plain code-unit comparison. */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
