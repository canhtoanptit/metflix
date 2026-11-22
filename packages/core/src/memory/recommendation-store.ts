import {
  assertNeighbourLookup,
  assertNeighbours,
  type Neighbour,
  type ProfileLists,
  type RecommendationModel,
  type RecommendationStore,
} from "../ports/recommendation-store.ts";

/** In-process `RecommendationStore` (tests; the dev mode until SQLite serves it). */
export class MemoryRecommendationStore implements RecommendationStore {
  private readonly models = new Map<string, RecommendationModel>();
  private readonly neighbourRows = new Map<string, Map<string, Neighbour[]>>();
  private readonly lists = new Map<string, ProfileLists>();
  private active: string | null = null;

  async activeModel(): Promise<RecommendationModel | null> {
    const model = this.active === null ? undefined : this.models.get(this.active);
    return model ? { ...model } : null;
  }

  async neighbours(titleIds: readonly string[]): Promise<Map<string, Neighbour[]>> {
    assertNeighbourLookup(titleIds);
    const result = new Map<string, Neighbour[]>();
    const run = this.active === null ? undefined : this.neighbourRows.get(this.active);
    if (!run) return result;
    for (const titleId of titleIds) {
      const rows = run.get(titleId);
      if (rows && rows.length > 0) {
        result.set(
          titleId,
          [...rows].sort((a, b) => a.rank - b.rank).map((row) => ({ ...row })),
        );
      }
    }
    return result;
  }

  async profileLists(profileKey: string, now: number): Promise<ProfileLists | null> {
    const lists = this.lists.get(profileKey);
    if (!lists || lists.expiresAt <= now) return null;
    return structuredClone(lists);
  }

  async beginImport(model: RecommendationModel): Promise<void> {
    this.models.set(model.run, { ...model });
    if (!this.neighbourRows.has(model.run)) this.neighbourRows.set(model.run, new Map());
  }

  async putNeighbours(run: string, rows: readonly Neighbour[]): Promise<void> {
    assertNeighbours(rows);
    const byTitle = this.neighbourRows.get(run);
    if (!byTitle) throw new Error(`Run ${run} was not begun`);
    for (const row of rows) {
      const list = (byTitle.get(row.titleId) ?? []).filter(
        (existing) => existing.rank !== row.rank,
      );
      list.push({ ...row });
      byTitle.set(row.titleId, list);
    }
  }

  async putProfileLists(lists: readonly ProfileLists[]): Promise<void> {
    for (const list of lists) this.lists.set(list.profileKey, structuredClone(list));
  }

  async activate(run: string): Promise<void> {
    if (!this.models.has(run)) throw new Error(`Run ${run} was not begun`);
    this.active = run;
  }

  async deleteRun(run: string): Promise<void> {
    if (run === this.active) throw new Error("The active run cannot be deleted");
    this.models.delete(run);
    this.neighbourRows.delete(run);
  }

  async deleteProfileLists(profileKeys: readonly string[]): Promise<void> {
    for (const key of profileKeys) this.lists.delete(key);
  }
}
