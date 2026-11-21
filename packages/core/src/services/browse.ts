import type {
  Billboard,
  BrowsePage,
  BrowseView,
  ContinueWatchingItem,
  GenreList,
  GenrePage,
  GenreSort,
  Row,
  SeasonEpisodes,
  TitleCardList,
  TitleDetail,
  TitlePopularity,
  TitleType,
} from "@webflix/contracts";
import type { ShowcaseData } from "../catalog/cache.ts";
import { AppError } from "../errors.ts";
import { type BadgeSurface, Personalization, type RowPlan } from "../recommendations/engine.ts";
import { addDays, utcDay } from "../recommendations/hash.ts";
import type { TitleRecord } from "../repositories/records.ts";
import type { ServiceDependencies, ServiceState, Viewer } from "./context.ts";
import { pageOf, pageUnserved } from "./pagination.ts";
import {
  presentCard,
  presentCards,
  presentContinueItem,
  presentPlayTarget,
  presentProgressRecord,
  presentTitleDetail,
} from "./presenters.ts";

/** Rows per browse batch (the SPA lazy-loads the next batch as the user scrolls). */
export const ROWS_PER_BATCH = 6;
/** Items a row arrives with; `GET /browse/rows/:rowId` pages the rest. */
export const ROW_FIRST_PAGE = 20;
/** Days the popularity diagnostics cover: Trending's window. */
const POPULARITY_DAYS = 7;

export function createBrowseService(deps: ServiceDependencies, state: ServiceState) {
  const { repos, clock, config } = deps;

  async function personalize(viewer: Viewer): Promise<Personalization> {
    const [snapshot, popularity, signals] = await Promise.all([
      state.catalog.get(),
      state.popularity.get(),
      repos.library.loadSignals(viewer.profile.id),
    ]);
    return new Personalization({
      snapshot,
      popularity,
      signals,
      profile: viewer.profile,
      now: clock.now(),
    });
  }

  /** The title, or the right error: unknown → not_found, above the ceiling → maturity_restricted. */
  function visibleTitle(
    personalization: Personalization,
    viewer: Viewer,
    titleId: string,
  ): TitleRecord {
    const title = personalization.snapshot.title(titleId);
    if (!title) throw new AppError("not_found", { detail: "No such title" });
    if (!personalization.isVisible(titleId)) {
      throw new AppError("maturity_restricted", {
        maturity: title.maturity,
        profileMaturityCeiling: viewer.profile.maturityCeiling,
      });
    }
    return title;
  }

  const ROW_BADGES: Record<RowPlan["layout"], BadgeSurface> = {
    standard: "list",
    tall: "list",
    ranked: "ranked",
    continue: "progress",
  };

  function renderRow(
    personalization: Personalization,
    plan: RowPlan,
    cursor: string | undefined,
    limit: number,
  ): Row {
    const page = pageUnserved(
      plan.titleIds,
      (id) => id,
      cursor,
      plan.layout === "ranked" ? plan.titleIds.length : limit,
    );
    // Badges are decided over the whole row, so later pages respect the row's Top 10 cap.
    const surface = personalization.cardSurface(plan.titleIds, plan.view, ROW_BADGES[plan.layout]);
    const base = {
      id: plan.id,
      kind: plan.kind,
      title: plan.title,
      context: plan.context,
      link: plan.link,
      nextCursor: page.nextCursor,
    };
    switch (plan.layout) {
      case "ranked":
        return {
          ...base,
          layout: "ranked",
          items: presentCards(personalization, page.items, surface).map((title, index) => ({
            rank: page.offset + index + 1,
            title,
          })),
        };
      case "continue": {
        const byTitle = new Map(
          personalization.continueWatching().map((item) => [item.titleId, item]),
        );
        return {
          ...base,
          layout: "continue",
          items: page.items.flatMap((id): ContinueWatchingItem[] => {
            const item = byTitle.get(id);
            const presented = item ? presentContinueItem(personalization, item, surface) : null;
            return presented ? [presented] : [];
          }),
        };
      }
      case "tall":
        return {
          ...base,
          layout: "tall",
          items: presentCards(personalization, page.items, surface),
        };
      case "standard":
        return {
          ...base,
          layout: "standard",
          items: presentCards(personalization, page.items, surface),
        };
    }
  }

  function billboard(personalization: Personalization, view: BrowseView): Billboard | null {
    const id = personalization.billboard(view);
    const title = id ? personalization.snapshot.title(id) : undefined;
    if (!title) return null;
    return {
      title: presentCard(
        personalization,
        title,
        personalization.cardSurface([title.id], view, "single"),
      ),
      synopsis: title.synopsis,
      backdrop: title.images.backdrop,
      maturityDescriptors: [...title.maturityDescriptors],
      playTarget: presentPlayTarget(personalization.playTarget(title.id)),
    };
  }

  return {
    personalize,

    async getBrowse(
      viewer: Viewer,
      view: BrowseView,
      cursor: string | undefined,
    ): Promise<BrowsePage> {
      const personalization = await personalize(viewer);
      // Batches carry what they served: a row the plan gained or lost meanwhile (My List
      // emptied, Continue Watching appearing) neither repeats nor skips another.
      const batch = pageUnserved(
        personalization.rows(view),
        (plan) => plan.id,
        cursor,
        ROWS_PER_BATCH,
        "r",
      );
      return {
        view,
        billboard: cursor === undefined ? billboard(personalization, view) : null,
        rows: batch.items.map((plan) =>
          renderRow(personalization, plan, undefined, ROW_FIRST_PAGE),
        ),
        nextCursor: batch.nextCursor,
      };
    },

    async getRow(
      viewer: Viewer,
      rowId: string,
      cursor: string | undefined,
      limit: number | undefined,
    ): Promise<Row> {
      const personalization = await personalize(viewer);
      const plan = personalization.row(rowId);
      if (!plan) throw new AppError("not_found", { detail: "No such row" });
      return renderRow(personalization, plan, cursor, limit ?? ROW_FIRST_PAGE);
    },

    async listGenres(viewer: Viewer): Promise<GenreList> {
      const personalization = await personalize(viewer);
      const visible = personalization.visibleTitles();
      return {
        items: personalization.snapshot.genres
          .filter((genre) => visible.some((title) => title.genreIds.includes(genre.id)))
          .map((genre) => ({
            id: genre.id,
            slug: genre.slug,
            name: genre.name,
            description: genre.description,
          })),
      };
    },

    async getGenrePage(
      viewer: Viewer,
      slug: string,
      query: {
        type?: TitleType | undefined;
        sort?: GenreSort | undefined;
        cursor?: string | undefined;
        limit?: number | undefined;
      },
    ): Promise<GenrePage> {
      const personalization = await personalize(viewer);
      const genre = personalization.snapshot.genreBySlugName(slug);
      if (!genre) throw new AppError("not_found", { detail: "No such genre" });
      const sort = query.sort ?? "suggested";
      const ids = personalization.genreTitles(genre.id, query.type ?? null, sort);
      const page = pageOf(ids, query.cursor, query.limit);
      return {
        genre: { id: genre.id, slug: genre.slug, name: genre.name, description: genre.description },
        type: query.type ?? null,
        sort,
        items: presentCards(
          personalization,
          page.items,
          personalization.cardSurface(ids, "home", "list"),
        ),
        nextCursor: page.nextCursor,
      };
    },

    async getTitle(viewer: Viewer, titleId: string): Promise<TitleDetail> {
      const personalization = await personalize(viewer);
      return presentTitleDetail(personalization, visibleTitle(personalization, viewer, titleId));
    },

    async listEpisodes(
      viewer: Viewer,
      titleId: string,
      seasonNumber: number,
    ): Promise<SeasonEpisodes> {
      const personalization = await personalize(viewer);
      const title = visibleTitle(personalization, viewer, titleId);
      const season = personalization.snapshot
        .seasons(title.id)
        .find((candidate) => candidate.number === seasonNumber);
      if (title.type !== "series" || !season)
        throw new AppError("not_found", { detail: "No such season" });
      const episodes = await repos.catalog.listEpisodes(title.id, seasonNumber);
      return {
        titleId: title.id,
        season: {
          number: season.number,
          name: season.name,
          episodeCount: season.episodeCount,
          releaseYear: season.releaseYear,
        },
        items: episodes.map((episode) => {
          const progress = personalization.itemProgress(episode.id);
          return {
            id: episode.id,
            titleId: episode.titleId,
            seasonNumber: episode.seasonNumber,
            number: episode.number,
            name: episode.name,
            synopsis: episode.synopsis,
            runtimeSec: episode.runtimeSec,
            still: episode.still,
            isPlayable: episode.isPlayable,
            progress: progress ? presentProgressRecord(progress) : null,
          };
        }),
      };
    },

    /** The public marketing showcase (no profile, no personal state) and its validator. */
    getShowcase(): Promise<ShowcaseData> {
      return state.showcase.get();
    },

    /**
     * Daily counters of one title as stored (seed baseline and real playback), for the last
     * week, newest first. Diagnostics: absent (`not_found`) in production.
     */
    async getTitlePopularity(titleId: string): Promise<TitlePopularity> {
      if (config.environment === "production") {
        throw new AppError("not_found", { detail: "Not available in production" });
      }
      const snapshot = await state.catalog.get();
      if (!snapshot.title(titleId)) throw new AppError("not_found", { detail: "No such title" });
      const today = utcDay(clock.now());
      const stored = new Map(
        (await repos.stats.titleDays(titleId, addDays(today, -(POPULARITY_DAYS - 1)))).map(
          (row) => [row.day, row],
        ),
      );
      return {
        titleId,
        days: Array.from({ length: POPULARITY_DAYS }, (_, index) => {
          const day = addDays(today, -index);
          return (
            stored.get(day) ?? {
              day,
              baselineViews: 0,
              playbackViews: 0,
              playbackWatchSec: 0,
              playbackProfiles: 0,
            }
          );
        }),
      };
    },

    async listSimilar(viewer: Viewer, titleId: string): Promise<TitleCardList> {
      const personalization = await personalize(viewer);
      visibleTitle(personalization, viewer, titleId);
      const ids = personalization.similar(titleId, 12);
      return {
        items: presentCards(personalization, ids, personalization.cardSurface(ids, "home", "list")),
      };
    },
  };
}

export type BrowseService = ReturnType<typeof createBrowseService>;
