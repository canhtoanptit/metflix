import {
  type BrowseView,
  type GenreSort,
  type MaturityLevel,
  type RatingValue,
  type RowKind,
  type RowLayout,
  type RowLink,
  type TitleBadge,
  type TitleType,
  TOP_10_BADGES_PER_LIST,
  type VideoQualityTier,
} from "@webflix/contracts";
import type { Popularity } from "../catalog/cache.ts";
import type { CatalogSnapshot } from "../catalog/snapshot.ts";
import { maturityRank } from "../domain/maturity.ts";
import type {
  EpisodeSummary,
  ProfileSignals,
  ProgressRecord,
  TitleRecord,
} from "../repositories/records.ts";
import { addScaled, dot, type FeatureVector, normalize } from "./features.ts";
import { DAY_MS, fnv1a32, utcDay } from "./hash.ts";

/**
 * Personalisation for one profile at one moment: a pure function of the catalog snapshot,
 * the popularity counters, the profile's library signals and the clock. Deterministic (ties
 * always fall back to title id; "random" rotation is a hash of profile and day), so it is
 * unit-testable and two requests with the same inputs produce the same page.
 *
 * The approach is documented in docs/RECOMMENDATIONS.md.
 */

// --- Tunables (documented in docs/RECOMMENDATIONS.md) -----------------------------------------

const RATING_WEIGHT: Record<RatingValue, number> = { love: 3, like: 1.5, dislike: -3 };
const MY_LIST_WEIGHT = 1.2;
const VIEW_WEIGHT = 2.0;
const MY_LIST_HALF_LIFE_DAYS = 60;
const VIEW_HALF_LIFE_DAYS = 30;
const FRESHNESS_DAYS = 45;
/** Below this total signal weight a profile is "cold": rank by popularity, no match score. */
const COLD_START_WEIGHT = 0.5;

/**
 * An item counts as started once this much was watched (shorter plays are samples: no resume
 * point, no Continue Watching entry); it is finished from this fraction of its duration on.
 */
export const MIN_RESUME_SEC = 30;
export const COMPLETION_RATIO = 0.95;

export const ROW_MAX_ITEMS = 40;
const MIN_ROW_ITEMS = 4;
const MIN_GENRE_ROW_ITEMS = 6;
const TOP_10_SIZE = 10;
const MIN_TOP_10_ITEMS = 3;
const NEW_RELEASE_DAYS = 45;
const NEW_BADGE_DAYS = 14;
const MAX_BECAUSE_YOU_WATCHED = 3;
/** First-page positions that count as "prominent" for cross-row variety. */
const PROMINENT_POSITIONS = 6;
/** The billboard picks among this many of the best unstarted matches... */
const BILLBOARD_POOL = 12;
/** ...rotating daily among the top few after freshness and presentation bonuses. */
const BILLBOARD_CANDIDATES = 3;

export interface PersonalizationInput {
  snapshot: CatalogSnapshot;
  popularity: Popularity;
  signals: ProfileSignals;
  profile: { id: string; name: string; maturityCeiling: MaturityLevel };
  now: number;
}

/** Where a title stands for this profile (rules: docs/RECOMMENDATIONS.md, Continue Watching). */
export interface TitleProgress {
  titleId: string;
  /** Most recently watched item of the title, samples included. */
  latest: ProgressRecord;
  /**
   * The item the title's state is anchored on: the most recent one watched far enough to count
   * (finished, or at least `MIN_RESUME_SEC` in). Null when the title was only sampled.
   */
  anchor: ProgressRecord | null;
  /** Every item with progress, most recent first. */
  items: ProgressRecord[];
  /** Hidden from Continue Watching (the anchor was hidden and nothing counted since). */
  hidden: boolean;
  /** Movie finished, or series finished up to its last episode. */
  finished: boolean;
  /** What to resume or play next; null when finished, only sampled, or nothing follows. */
  next: ResumePoint | null;
}

export interface ResumePoint {
  episode: EpisodeSummary | null;
  positionSec: number;
  durationSec: number;
  /** Progress on that item (null when it starts from the beginning). */
  progress: ProgressRecord | null;
  /** The latest activity on the title (orders Continue Watching). */
  updatedAt: number;
}

/**
 * Where one cards list sits, for badge selection: `single` (billboard, title detail) earns any
 * badge, `list` (rows, genre pages, search, My List, More Like This) caps Top 10 badges at
 * `TOP_10_BADGES_PER_LIST`, `progress` and `ranked` rows show no Top 10 badge at all (the row is
 * about progress; the numeral already says it).
 */
export type BadgeSurface = "single" | "list" | "progress" | "ranked";

/** The cards of one surface: the view whose Top 10 list applies and each card's badge. */
export interface CardSurface {
  view: BrowseView;
  badges: ReadonlyMap<string, TitleBadge | null>;
}

export interface PlayTargetPlan {
  action: "play" | "resume";
  episode: EpisodeSummary | null;
  positionSec: number;
  progress: ProgressRecord | null;
}

export interface ContinueWatchingPlan {
  titleId: string;
  episode: EpisodeSummary | null;
  positionSec: number;
  durationSec: number;
  completed: false;
  updatedAt: number;
}

export interface RowPlan {
  id: string;
  view: BrowseView;
  kind: RowKind;
  layout: RowLayout;
  title: string;
  context: {
    sourceTitle: { id: string; name: string } | null;
    genre: { slug: string; name: string } | null;
  };
  link: RowLink | null;
  /** All items, in order (a row is paged from this list). */
  titleIds: string[];
}

interface ItemPosition {
  positionSec: number;
  durationSec: number;
  completed: boolean;
}

export function isCompleted(progress: ItemPosition): boolean {
  return (
    progress.completed ||
    (progress.durationSec > 0 && progress.positionSec >= progress.durationSec * COMPLETION_RATIO)
  );
}

/** Watched far enough to count: finished, or at least `MIN_RESUME_SEC` in. */
export function isEngaged(progress: ItemPosition): boolean {
  return isCompleted(progress) || progress.positionSec >= MIN_RESUME_SEC;
}

/** Started and not finished: Play resumes it. */
export function isInProgress(progress: ItemPosition): boolean {
  return !isCompleted(progress) && progress.positionSec >= MIN_RESUME_SEC;
}

/** Where Play starts an item from its own progress: 0 when finished or only sampled. */
export function resumePositionOf(progress: ItemPosition | undefined): number {
  return progress && isInProgress(progress) ? progress.positionSec : 0;
}

const VIEW_TYPES: Record<BrowseView, TitleType | null> = {
  home: null,
  series: "series",
  movies: "movie",
  "new-popular": null,
};

export class Personalization {
  readonly coldStart: boolean;
  private readonly input: PersonalizationInput;
  private readonly ceilingRank: number;
  private readonly visible: TitleRecord[];
  private readonly myList: Map<string, number>;
  private readonly ratings: Map<string, RatingValue>;
  private readonly progressByTitle = new Map<string, TitleProgress>();
  private readonly taste: FeatureVector;
  private readonly signalWeight = new Map<string, number>();
  private readonly affinityCache = new Map<string, number>();
  private readonly scoreCache = new Map<string, number>();
  private readonly affinityReference: number;
  private readonly top10Cache = new Map<TitleType | null, string[]>();

  constructor(input: PersonalizationInput) {
    this.input = input;
    this.ceilingRank = maturityRank(input.profile.maturityCeiling);
    this.visible = input.snapshot.titles.filter((title) => this.isVisible(title.id));
    this.myList = new Map(input.signals.myList.map((entry) => [entry.titleId, entry.addedAt]));
    this.ratings = new Map(input.signals.ratings.map((entry) => [entry.titleId, entry.value]));
    this.indexProgress();
    const { vector, total } = this.buildTaste();
    this.taste = vector;
    this.coldStart = total < COLD_START_WEIGHT;
    // Normalise match scores by a high affinity among visible titles, so this profile's best
    // matches read ~95% whatever the absolute affinity level of its taste.
    const affinities = this.visible.map((title) => this.affinity(title.id)).sort((a, b) => b - a);
    const reference = affinities[Math.floor(affinities.length * 0.05)] ?? 0;
    this.affinityReference = Math.max(reference, 0.05);
  }

  get now(): number {
    return this.input.now;
  }

  get snapshot(): CatalogSnapshot {
    return this.input.snapshot;
  }

  /** Every catalog surface goes through this: maturity filtering happens here, server-side. */
  isVisible(titleId: string): boolean {
    return this.input.snapshot.maturityRankOf(titleId) <= this.ceilingRank;
  }

  visibleTitles(type: TitleType | null = null): TitleRecord[] {
    return type ? this.visible.filter((title) => title.type === type) : this.visible;
  }

  inMyList(titleId: string): boolean {
    return this.myList.has(titleId);
  }

  rating(titleId: string): RatingValue | null {
    return this.ratings.get(titleId) ?? null;
  }

  progress(titleId: string): TitleProgress | undefined {
    return this.progressByTitle.get(titleId);
  }

  /** Progress of one watchable item (episode id, or title id for movies). */
  itemProgress(itemId: string): ProgressRecord | undefined {
    return this.input.signals.progress.find((entry) => entry.itemId === itemId);
  }

  // --- Scores ---------------------------------------------------------------------------------

  /** Cosine similarity between the profile's taste and the title, -1..1 (0 when cold). */
  affinity(titleId: string): number {
    let value = this.affinityCache.get(titleId);
    if (value === undefined) {
      value = this.taste.size === 0 ? 0 : dot(this.taste, this.input.snapshot.features(titleId));
      this.affinityCache.set(titleId, value);
    }
    return value;
  }

  /** Overall personal ranking score (higher is better). */
  score(titleId: string): number {
    let value = this.scoreCache.get(titleId);
    if (value === undefined) {
      const title = this.input.snapshot.title(titleId);
      if (!title) return Number.NEGATIVE_INFINITY;
      const popularity = title.popularity / 100;
      const trend = this.input.popularity.trend(titleId);
      const fresh = Math.exp(-Math.max(0, this.ageDays(title)) / FRESHNESS_DAYS);
      value = this.coldStart
        ? 0.5 * popularity + 0.35 * trend + 0.15 * fresh
        : 0.55 * this.affinity(titleId) + 0.2 * popularity + 0.15 * trend + 0.1 * fresh;
      this.scoreCache.set(titleId, value);
    }
    return value;
  }

  /** 0-100 predicted match, null for a profile we know nothing about yet. */
  matchScore(titleId: string): number | null {
    if (this.coldStart) return null;
    const title = this.input.snapshot.title(titleId);
    if (!title) return null;
    const relative = clamp(this.affinity(titleId) / this.affinityReference, 0, 1);
    const match = Math.round(52 + 46 * (0.8 * relative + 0.2 * (title.popularity / 100)));
    return this.rating(titleId) === "dislike" ? Math.min(match, 55) : clamp(match, 0, 98);
  }

  /**
   * Rank (1-10) in the Top 10 list of `view`'s "Top 10 ... Today" row: the overall list on
   * Home, the series or movies list on those views, the title's own type on New & Popular.
   */
  top10Rank(titleId: string, view: BrowseView): number | null {
    const title = this.input.snapshot.title(titleId);
    if (!title || !this.isVisible(titleId)) return null;
    const type = view === "new-popular" ? title.type : VIEW_TYPES[view];
    const rank = this.top10(type).indexOf(titleId);
    return rank < 0 ? null : rank + 1;
  }

  /**
   * One badge per card, chosen by the server (docs/RECOMMENDATIONS.md, Badges). Priority:
   * `leaving-soon` (reserved: the catalog has no availability windows), `new-episodes`,
   * `top-10` (only in `view`'s Top 10 list, and only where `surface` allows it), `new`.
   * In a `list`, only the first `TOP_10_BADGES_PER_LIST` ranked cards in list order earn it.
   */
  cardSurface(ids: readonly string[], view: BrowseView, surface: BadgeSurface): CardSurface {
    let top10Left =
      surface === "single"
        ? Number.POSITIVE_INFINITY
        : surface === "list"
          ? TOP_10_BADGES_PER_LIST
          : 0;
    const badges = new Map<string, TitleBadge | null>();
    for (const id of ids) {
      if (badges.has(id)) continue;
      const status = this.statusBadge(id);
      let badge: TitleBadge | null = status;
      if (status !== "new-episodes" && top10Left > 0 && this.top10Rank(id, view) !== null) {
        badge = "top-10";
        top10Left -= 1;
      }
      badges.set(id, badge);
    }
    return { view, badges };
  }

  /** Badges that are not about popularity. */
  private statusBadge(titleId: string): "new-episodes" | "new" | null {
    const title = this.input.snapshot.title(titleId);
    if (!title || this.ageDays(title) > NEW_BADGE_DAYS) return null;
    return title.type === "series" && (title.seasonCount ?? 0) > 1 ? "new-episodes" : "new";
  }

  /** Best video quality the title's packaged media offers; null without packaged media. */
  bestVideoQuality(titleId: string): VideoQualityTier | null {
    return this.input.snapshot.bestVideoQuality(titleId);
  }

  // --- Progress-derived ---------------------------------------------------------------------

  /**
   * What Play does: resume (or start the next episode of) what the profile is in the middle of,
   * otherwise start the movie, or the series' first playable episode, from the beginning.
   */
  playTarget(titleId: string): PlayTargetPlan | null {
    const title = this.input.snapshot.title(titleId);
    if (!title?.isPlayable) return null;
    const next = this.resumePoint(titleId);
    if (next) {
      return {
        action: next.positionSec > 0 ? "resume" : "play",
        episode: next.episode,
        positionSec: next.positionSec,
        progress: next.progress,
      };
    }
    if (title.type === "movie")
      return { action: "play", episode: null, positionSec: 0, progress: null };
    const first = this.input.snapshot.episodes(titleId).find((episode) => episode.isPlayable);
    return first ? { action: "play", episode: first, positionSec: 0, progress: null } : null;
  }

  /**
   * Titles the profile is in the middle of, most recent activity first: exactly the titles
   * whose play target comes from their progress, unless hidden, disliked or above the ceiling.
   */
  continueWatching(type: TitleType | null = null): ContinueWatchingPlan[] {
    const items: ContinueWatchingPlan[] = [];
    for (const progress of this.progressByTitle.values()) {
      if (progress.hidden || !this.isVisible(progress.titleId)) continue;
      const title = this.input.snapshot.title(progress.titleId);
      if (!title || (type && title.type !== type) || this.rating(title.id) === "dislike") continue;
      const next = this.resumePoint(title.id);
      if (!next) continue;
      items.push({
        titleId: title.id,
        episode: next.episode,
        positionSec: next.positionSec,
        durationSec: next.durationSec,
        completed: false,
        updatedAt: next.updatedAt,
      });
    }
    return items
      .sort((a, b) => b.updatedAt - a.updatedAt || a.titleId.localeCompare(b.titleId))
      .slice(0, ROW_MAX_ITEMS);
  }

  /** Finished titles, most recent first. */
  watchAgain(type: TitleType | null = null): string[] {
    return [...this.progressByTitle.values()]
      .filter((progress) => progress.finished && this.isVisible(progress.titleId))
      .filter((progress) => !type || this.input.snapshot.title(progress.titleId)?.type === type)
      .filter((progress) => this.rating(progress.titleId) !== "dislike")
      .sort((a, b) => b.latest.updatedAt - a.latest.updatedAt || a.titleId.localeCompare(b.titleId))
      .map((progress) => progress.titleId)
      .slice(0, ROW_MAX_ITEMS);
  }

  /** The progress-derived resume point, if it is playable (the only kind Play may use). */
  private resumePoint(titleId: string): ResumePoint | null {
    const title = this.input.snapshot.title(titleId);
    const next = this.progressByTitle.get(titleId)?.next;
    if (!title?.isPlayable || !next || (next.episode && !next.episode.isPlayable)) return null;
    return next;
  }

  // --- Lists ---------------------------------------------------------------------------------

  /** More Like This, personalised: content similarity first, taste second. */
  similar(titleId: string, limit = 12, type: TitleType | null = null): string[] {
    return this.input.snapshot
      .similar(titleId)
      .filter(({ id }) => this.isVisible(id) && this.rating(id) !== "dislike")
      .filter(({ id }) => !type || this.input.snapshot.title(id)?.type === type)
      .map(({ id, similarity }) => ({
        id,
        rank: 0.75 * similarity + 0.25 * Math.max(0, this.affinity(id)),
      }))
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ id }) => id);
  }

  /** Visible titles by recent views; padded with seed popularity so the row is never empty. */
  top10(type: TitleType | null = null): string[] {
    const cached = this.top10Cache.get(type);
    if (cached) return cached;
    const eligible = (id: string) => {
      const title = this.input.snapshot.title(id);
      return !!title && this.isVisible(id) && (!type || title.type === type);
    };
    const ranked = this.input.popularity.ranked.filter(eligible).slice(0, TOP_10_SIZE);
    if (ranked.length < TOP_10_SIZE) {
      const fill = this.visibleTitles(type)
        .filter((title) => !ranked.includes(title.id))
        .sort((a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id))
        .map((title) => title.id);
      ranked.push(...fill.slice(0, TOP_10_SIZE - ranked.length));
    }
    this.top10Cache.set(type, ranked);
    return ranked;
  }

  genreTitles(genreId: string, type: TitleType | null, sort: GenreSort): string[] {
    const titles = this.visibleTitles(type).filter((title) => title.genreIds.includes(genreId));
    const byName = (a: TitleRecord, b: TitleRecord) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
    switch (sort) {
      case "a-z":
        return titles.sort(byName).map((title) => title.id);
      case "z-a":
        return titles.sort((a, b) => byName(b, a)).map((title) => title.id);
      case "newest":
        return titles
          .sort(
            (a, b) =>
              b.releaseYear - a.releaseYear || b.addedAt - a.addedAt || a.id.localeCompare(b.id),
          )
          .map((title) => title.id);
      case "oldest":
        return titles
          .sort(
            (a, b) =>
              a.releaseYear - b.releaseYear || a.addedAt - b.addedAt || a.id.localeCompare(b.id),
          )
          .map((title) => title.id);
      case "suggested":
        return this.rank(titles.map((title) => title.id));
    }
  }

  // --- Browse composition ---------------------------------------------------------------------

  billboard(view: BrowseView): string | null {
    if (view === "new-popular") return null;
    const type = VIEW_TYPES[view];
    // A strong personal match the profile has not started: what it is watching already leads
    // Continue Watching. Among the best few, prefer fresh, original, previewable titles.
    const pool = this.visibleTitles(type)
      .filter((title) => title.isPlayable && this.rating(title.id) !== "dislike")
      .filter((title) => !this.progressByTitle.get(title.id)?.anchor)
      .sort((a, b) => this.score(b.id) - this.score(a.id) || a.id.localeCompare(b.id))
      .slice(0, BILLBOARD_POOL);
    const candidates = pool
      .map((title, index) => ({
        id: title.id,
        rank:
          0.6 * (1 - index / Math.max(1, pool.length - 1)) +
          0.2 * Math.exp(-Math.max(0, this.ageDays(title)) / FRESHNESS_DAYS) +
          0.1 * (title.isOriginal ? 1 : 0) +
          0.07 * (title.preview ? 1 : 0) +
          0.03 * (title.images.logo ? 1 : 0),
      }))
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
      .slice(0, BILLBOARD_CANDIDATES);
    if (candidates.length === 0) return null;
    // Rotates daily per profile and view, and is stable within the day.
    const pick =
      fnv1a32(`${this.input.profile.id}:${view}:${utcDay(this.input.now)}`) % candidates.length;
    return candidates[pick]?.id ?? null;
  }

  rows(view: BrowseView): RowPlan[] {
    const plans = view === "new-popular" ? this.newAndPopularRows() : this.catalogRows(view);
    return this.withVariety(plans.filter((plan) => plan.titleIds.length > 0));
  }

  /** A single row by id (for `GET /browse/rows/:rowId`), or null. */
  row(rowId: string): RowPlan | null {
    const [view] = rowId.split(":");
    if (!isBrowseView(view)) return null;
    return this.rows(view).find((plan) => plan.id === rowId) ?? this.adHocRow(rowId);
  }

  private catalogRows(view: Exclude<BrowseView, "new-popular">): RowPlan[] {
    const type = VIEW_TYPES[view];
    const typeLabel = type === "series" ? "Series" : type === "movie" ? "Movies" : null;
    const rows: RowPlan[] = [];
    const add = (plan: RowPlan | null) => {
      if (plan) rows.push(plan);
    };

    const continueIds = this.continueWatching(type).map((item) => item.titleId);
    add(
      continueIds.length > 0
        ? this.plan(
            view,
            "continue-watching",
            null,
            "continue",
            `Continue Watching for ${this.input.profile.name}`,
            continueIds,
          )
        : null,
    );
    const top10 = this.top10(type);
    add(
      top10.length >= MIN_TOP_10_ITEMS
        ? this.plan(
            view,
            "top-10",
            null,
            "ranked",
            typeLabel ? `Top 10 ${typeLabel} Today` : "Top 10 on Webflix Today",
            top10,
            { kind: "view", view: "new-popular" },
          )
        : null,
    );
    add(
      this.minimum(
        this.plan(view, "trending", null, "standard", "Trending Now", this.trending(type), {
          kind: "view",
          view: "new-popular",
        }),
      ),
    );
    const myList = this.myListIds(type);
    add(
      myList.length > 0
        ? this.plan(view, "my-list", null, "standard", "My List", myList, { kind: "my-list" })
        : null,
    );

    const because = this.becauseYouWatched(type);
    const genres = this.genreRows(view, type, typeLabel);
    add(because[0] ?? null);
    add(
      this.minimum(
        this.plan(view, "new-releases", null, "standard", "New Releases", this.newReleases(type), {
          kind: "view",
          view: "new-popular",
        }),
      ),
    );
    add(genres[0] ?? null);
    add(
      this.minimum(
        this.plan(
          view,
          "originals",
          null,
          "tall",
          "Only on Webflix",
          this.rank(
            this.visibleTitles(type)
              .filter((title) => title.isOriginal && this.rating(title.id) !== "dislike")
              .map((title) => title.id),
          ),
        ),
      ),
    );
    add(because[1] ?? null);
    add(genres[1] ?? null);
    add(genres[2] ?? null);
    const again = this.watchAgain(type);
    add(
      again.length > 0
        ? this.plan(view, "watch-again", null, "standard", "Watch It Again", again)
        : null,
    );
    add(genres[3] ?? null);
    add(because[2] ?? null);
    for (const genre of genres.slice(4)) add(genre);
    return rows;
  }

  private newAndPopularRows(): RowPlan[] {
    const view = "new-popular";
    const recent = this.visible
      .filter((title) => this.rating(title.id) !== "dislike")
      .sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id))
      .slice(0, ROW_MAX_ITEMS)
      .map((title) => title.id);
    const rows: (RowPlan | null)[] = [
      this.minimum(this.plan(view, "new-releases", null, "standard", "New on Webflix", recent)),
      this.topRow(view, "series", "Top 10 Series Today"),
      this.topRow(view, "movie", "Top 10 Movies Today"),
      this.minimum(
        this.plan(view, "trending", null, "standard", "Trending Now", this.trending(null)),
      ),
      this.minimum(
        this.plan(
          view,
          "originals",
          null,
          "tall",
          "Fresh from Webflix",
          this.visible
            .filter((title) => title.isOriginal && this.rating(title.id) !== "dislike")
            .sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id))
            .map((title) => title.id),
        ),
      ),
    ];
    return rows.filter((row): row is RowPlan => row !== null);
  }

  private topRow(view: BrowseView, type: TitleType, title: string): RowPlan | null {
    const ids = this.top10(type);
    if (ids.length < MIN_TOP_10_ITEMS) return null;
    return this.plan(view, "top-10", type === "series" ? "series" : "movies", "ranked", title, ids);
  }

  private trending(type: TitleType | null): string[] {
    const candidates = this.visibleTitles(type).filter(
      (title) => this.rating(title.id) !== "dislike",
    );
    return candidates
      .map((title) => {
        const trend = this.input.popularity.trend(title.id);
        const rank = this.coldStart
          ? trend + 0.001 * title.popularity
          : 0.75 * trend + 0.25 * Math.max(0, this.affinity(title.id)) + 0.001 * title.popularity;
        return { id: title.id, rank, trend };
      })
      .filter((entry) => entry.trend > 0 || candidates.length < MIN_ROW_ITEMS * 2)
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
      .slice(0, ROW_MAX_ITEMS)
      .map((entry) => entry.id);
  }

  private newReleases(type: TitleType | null): string[] {
    const titles = this.visibleTitles(type)
      .filter((title) => this.rating(title.id) !== "dislike")
      .sort((a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id));
    const recent = titles.filter((title) => this.ageDays(title) <= NEW_RELEASE_DAYS);
    return (recent.length >= MIN_ROW_ITEMS * 2 ? recent : titles.slice(0, 20))
      .slice(0, ROW_MAX_ITEMS)
      .map((title) => title.id);
  }

  /** My List, most recently added first, visible titles only. */
  myListIds(type: TitleType | null = null, limit: number = ROW_MAX_ITEMS): string[] {
    return [...this.myList]
      .sort(([a, ta], [b, tb]) => tb - ta || a.localeCompare(b))
      .map(([id]) => id)
      .filter((id) => this.input.snapshot.title(id) !== undefined && this.isVisible(id))
      .filter((id) => !type || this.input.snapshot.title(id)?.type === type)
      .slice(0, limit);
  }

  /** "Because You Watched X" rows: recent, engaged, liked-or-unrated sources. */
  private becauseYouWatched(type: TitleType | null): RowPlan[] {
    const view = type === "series" ? "series" : type === "movie" ? "movies" : "home";
    const sources = [...this.progressByTitle.values()]
      .filter((progress) => this.isVisible(progress.titleId))
      .filter((progress) => this.rating(progress.titleId) !== "dislike")
      .filter((progress) => (this.signalWeight.get(progress.titleId) ?? 0) >= 1)
      .sort(
        (a, b) => b.latest.updatedAt - a.latest.updatedAt || a.titleId.localeCompare(b.titleId),
      );
    const rows: RowPlan[] = [];
    for (const source of sources) {
      if (rows.length >= MAX_BECAUSE_YOU_WATCHED) break;
      const row = this.becauseRow(view, source.titleId, type);
      if (row) rows.push(row);
    }
    return rows;
  }

  private becauseRow(view: BrowseView, sourceId: string, type: TitleType | null): RowPlan | null {
    const source = this.input.snapshot.title(sourceId);
    if (!source || !this.isVisible(sourceId)) return null;
    const items = this.similar(sourceId, ROW_MAX_ITEMS, type).filter(
      (id) => !this.progressByTitle.get(id)?.finished,
    );
    if (items.length < MIN_ROW_ITEMS) return null;
    const plan = this.plan(
      view,
      "because-you-watched",
      sourceId,
      "standard",
      `Because You Watched ${source.name}`,
      items,
    );
    plan.context.sourceTitle = { id: source.id, name: source.name };
    return plan;
  }

  private genreRows(view: BrowseView, type: TitleType | null, typeLabel: string | null): RowPlan[] {
    const candidates = this.visibleTitles(type);
    const maxPrior = Math.max(
      1e-9,
      ...this.input.snapshot.genres.map((genre) => this.genrePrior(genre.id, candidates)),
    );
    return this.input.snapshot.genres
      .map((genre) => ({
        genre,
        count: candidates.filter((title) => title.genreIds.includes(genre.id)).length,
        preference:
          (this.coldStart ? 0 : (this.taste.get(`g:${genre.id}`) ?? 0)) +
          0.15 * (this.genrePrior(genre.id, candidates) / maxPrior),
      }))
      .filter((entry) => entry.count >= MIN_GENRE_ROW_ITEMS)
      .sort(
        (a, b) =>
          b.preference - a.preference ||
          a.genre.position - b.genre.position ||
          a.genre.id.localeCompare(b.genre.id),
      )
      .slice(0, type ? 10 : 8)
      .map(({ genre }) => {
        const items = this.genreTitles(genre.id, type, "suggested")
          .filter((id) => this.rating(id) !== "dislike")
          .slice(0, ROW_MAX_ITEMS);
        const plan = this.plan(
          view,
          "genre",
          genre.slug,
          "standard",
          typeLabel ? `${genre.name} ${typeLabel}` : genre.name,
          items,
          { kind: "genre", slug: genre.slug },
        );
        plan.context.genre = { slug: genre.slug, name: genre.name };
        return plan;
      });
  }

  /** Popularity-weighted size of a genre among visible titles. */
  private genrePrior(genreId: string, titles: readonly TitleRecord[]): number {
    let sum = 0;
    for (const title of titles) {
      if (title.genreIds.includes(genreId)) {
        sum += title.popularity / 100 + this.input.popularity.trend(title.id);
      }
    }
    return sum;
  }

  /** Rows that cannot be found in the current plan but are valid (an older cursor). */
  private adHocRow(rowId: string): RowPlan | null {
    const [view, kind, param] = rowId.split(":");
    if (!isBrowseView(view) || view === "new-popular" || !param) return null;
    const type = VIEW_TYPES[view];
    if (kind === "because-you-watched") return this.becauseRow(view, param, type);
    if (kind === "genre") {
      const genre = this.input.snapshot.genreBySlugName(param);
      if (!genre) return null;
      const typeLabel = type === "series" ? "Series" : type === "movie" ? "Movies" : null;
      const plan = this.plan(
        view,
        "genre",
        genre.slug,
        "standard",
        typeLabel ? `${genre.name} ${typeLabel}` : genre.name,
        this.genreTitles(genre.id, type, "suggested")
          .filter((id) => this.rating(id) !== "dislike")
          .slice(0, ROW_MAX_ITEMS),
        { kind: "genre", slug: genre.slug },
      );
      plan.context.genre = { slug: genre.slug, name: genre.name };
      return plan;
    }
    return null;
  }

  /**
   * Cross-row variety: a title already shown in the first page of an earlier row moves to the
   * back of later browsing rows (it is not removed, so rows stay full). Rows whose order is the
   * point keep it: canonical lists (Continue Watching, My List, Top 10, Watch It Again),
   * relevance lists (Because You Watched) and chronological ones (New Releases).
   */
  private withVariety(plans: RowPlan[]): RowPlan[] {
    const prominent = new Set<string>();
    const fixed = new Set<RowKind>([
      "continue-watching",
      "my-list",
      "top-10",
      "watch-again",
      "because-you-watched",
      "new-releases",
    ]);
    for (const plan of plans) {
      if (!fixed.has(plan.kind)) {
        const fresh = plan.titleIds.filter((id) => !prominent.has(id));
        const seen = plan.titleIds.filter((id) => prominent.has(id));
        plan.titleIds = [...fresh, ...seen];
      }
      for (const id of plan.titleIds.slice(0, PROMINENT_POSITIONS)) prominent.add(id);
    }
    return plans;
  }

  private plan(
    view: BrowseView,
    kind: RowKind,
    param: string | null,
    layout: RowLayout,
    title: string,
    titleIds: string[],
    link: RowLink | null = null,
  ): RowPlan {
    return {
      id: param ? `${view}:${kind}:${param}` : `${view}:${kind}`,
      view,
      kind,
      layout,
      title,
      context: { sourceTitle: null, genre: null },
      link,
      titleIds: titleIds.slice(0, layout === "ranked" ? TOP_10_SIZE : ROW_MAX_ITEMS),
    };
  }

  private minimum(plan: RowPlan): RowPlan | null {
    return plan.titleIds.length >= MIN_ROW_ITEMS ? plan : null;
  }

  /** Order by personal score; finished titles sink. */
  private rank(ids: string[]): string[] {
    return ids
      .map((id) => ({
        id,
        rank: this.score(id) - (this.progressByTitle.get(id)?.finished ? 1 : 0),
      }))
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
      .map(({ id }) => id);
  }

  private ageDays(title: TitleRecord): number {
    return (this.input.now - title.addedAt) / DAY_MS;
  }

  // --- Signals --------------------------------------------------------------------------------

  /**
   * Each title's state from its progress rows. A title is anchored on its most recent item
   * watched far enough to count, so a few seconds of anything (the next episode autoplaying
   * before the member left, a sampled title, an old episode reopened) never erases what the
   * member is in the middle of. From the anchor: an unfinished item resumes; a finished one
   * moves on to the next episode (resuming it if it is itself in progress); a finished movie
   * or finale finishes the title.
   */
  private indexProgress(): void {
    const byTitle = new Map<string, ProgressRecord[]>();
    for (const entry of this.input.signals.progress) {
      const list = byTitle.get(entry.titleId) ?? [];
      list.push(entry);
      byTitle.set(entry.titleId, list);
    }
    for (const [titleId, items] of byTitle) {
      const title = this.input.snapshot.title(titleId);
      if (!title) continue;
      items.sort((a, b) => b.updatedAt - a.updatedAt || a.itemId.localeCompare(b.itemId));
      const latest = items[0];
      if (!latest) continue;
      const anchor = items.find(isEngaged) ?? null;
      let next: ResumePoint | null = null;
      let finished = false;
      const resume = (
        episode: EpisodeSummary | null,
        progress: ProgressRecord | null,
        durationSec: number,
      ): ResumePoint => ({
        episode,
        positionSec: progress?.positionSec ?? 0,
        durationSec: progress?.durationSec ?? durationSec,
        progress,
        updatedAt: latest.updatedAt,
      });
      const episode = anchor?.episodeId ? this.input.snapshot.episode(anchor.episodeId) : undefined;
      if (!anchor) {
        // Only sampled: not started.
      } else if (!isCompleted(anchor)) {
        if (title.type === "movie") next = resume(null, anchor, anchor.durationSec);
        else if (episode) next = resume(episode, anchor, anchor.durationSec);
      } else if (title.type === "movie") {
        finished = true;
      } else if (episode) {
        const following = this.input.snapshot.nextEpisode(episode.id);
        if (following) {
          const started = items.find((item) => item.itemId === following.id);
          next = resume(
            following,
            started && isInProgress(started) ? started : null,
            started?.durationSec || following.runtimeSec,
          );
        } else {
          finished = true;
        }
      }
      this.progressByTitle.set(titleId, {
        titleId,
        latest,
        anchor,
        items,
        hidden: anchor?.hidden ?? false,
        finished,
        next,
      });
    }
  }

  /** The taste vector: signal-weighted sum of the features of titles the profile engaged with. */
  private buildTaste(): { vector: FeatureVector; total: number } {
    const now = this.input.now;
    const decay = (since: number, halfLifeDays: number, floor: number) =>
      Math.max(floor, 0.5 ** (Math.max(0, now - since) / DAY_MS / halfLifeDays));

    for (const [titleId, addedAt] of this.myList) {
      this.bump(titleId, MY_LIST_WEIGHT * decay(addedAt, MY_LIST_HALF_LIFE_DAYS, 0.5));
    }
    for (const progress of this.progressByTitle.values()) {
      const title = this.input.snapshot.title(progress.titleId);
      if (!title) continue;
      let engagement: number;
      if (title.type === "movie") {
        engagement = isCompleted(progress.latest)
          ? 1
          : clamp(
              (progress.latest.positionSec / Math.max(1, progress.latest.durationSec)) * 1.2,
              0.15,
              0.9,
            );
      } else {
        const completed = progress.items.filter(isCompleted).length;
        engagement = clamp(0.3 + 0.12 * progress.items.length + 0.08 * completed, 0.3, 1);
      }
      this.bump(
        progress.titleId,
        VIEW_WEIGHT * engagement * decay(progress.latest.updatedAt, VIEW_HALF_LIFE_DAYS, 0.25),
      );
    }
    for (const [titleId, value] of this.ratings) {
      // A dislike overrides everything else known about the title.
      if (value === "dislike") this.signalWeight.set(titleId, RATING_WEIGHT.dislike);
      else this.bump(titleId, RATING_WEIGHT[value]);
    }

    const raw = new Map<string, number>();
    let total = 0;
    for (const [titleId, weight] of this.signalWeight) {
      if (!this.isVisible(titleId)) continue;
      addScaled(raw, this.input.snapshot.features(titleId), weight);
      total += Math.abs(weight);
    }
    return { vector: normalize(raw), total };
  }

  private bump(titleId: string, weight: number): void {
    if (this.ratings.get(titleId) === "dislike") return;
    this.signalWeight.set(titleId, (this.signalWeight.get(titleId) ?? 0) + weight);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isBrowseView(value: string | undefined): value is BrowseView {
  return value === "home" || value === "series" || value === "movies" || value === "new-popular";
}
