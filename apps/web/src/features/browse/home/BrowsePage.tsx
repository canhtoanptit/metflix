import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { BrowseView, Row } from "@webflix/contracts";
import {
  Avatar,
  Button,
  CloseIcon,
  cx,
  ErrorState,
  LazyMount,
  RowSliderSkeleton,
  useInView,
  useMediaQuery,
} from "@webflix/ui";
import { useEffect, useMemo } from "react";
import { SectionErrorBoundary } from "../../../app/errors/ErrorPages.tsx";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useBrowseProfile } from "../common/session.ts";
import { GenreMenuEntry as GenreMenu } from "../shell/menus.tsx";
import { PHONE_QUERY } from "../shell/TopNav.tsx";
import { Billboard, BillboardSkeleton } from "./Billboard.tsx";
import { BrowseRow } from "./BrowseRow.tsx";

const VIEW_TITLES: Record<BrowseView, string> = {
  home: "Home",
  series: "Series",
  movies: "Movies",
  "new-popular": "New & Popular",
};

/** Rows rendered eagerly; the rest mount shortly before they scroll into view. */
const EAGER_ROWS = 3;
/** Skeleton rows shown on first load, by layout (the usual top of a home page). */
const FIRST_LOAD_LAYOUTS: Row["layout"][] = ["continue", "ranked", "standard", "standard"];

/**
 * A browse view: billboard, then rows. The first batch of rows arrives with the billboard; later
 * batches load as the person scrolls towards the end (`nextCursor`), each row paging its own
 * items. Skeletons keep the final geometry, so nothing shifts as data lands.
 */
function BrowseScreen({ view }: { view: BrowseView }) {
  const browse = useInfiniteQuery(queries.browse(view));
  const phone = useMediaQuery(PHONE_QUERY);
  const profile = useBrowseProfile();
  const pages = browse.data?.pages;
  const billboard = pages?.[0]?.billboard ?? null;
  const rows = useMemo(() => pages?.flatMap((page) => page.rows) ?? [], [pages]);
  const hasHero = view !== "new-popular" && (billboard !== null || browse.isPending);
  const typed = view === "series" || view === "movies";
  const kidsHome = profile.isKids && view === "home";

  if (browse.isError && !browse.data) {
    const error = describeError(browse.error);
    return (
      <main id="main" className="pt-nav">
        <h1 className="sr-only">{VIEW_TITLES[view]}</h1>
        <ErrorState
          layout="page"
          title={error.title}
          description={error.description}
          reference={error.reference}
          action={
            <Button variant="primary" onClick={() => browse.refetch()}>
              Try again
            </Button>
          }
        />
      </main>
    );
  }

  return (
    <main
      id="main"
      data-kids={profile.isKids || undefined}
      className={cx(
        "relative pb-8",
        // Kids: friendlier, rounder cards (the card radius token mapped to a larger one).
        profile.isKids && "[--radius-card:var(--radius-xl)]",
      )}
      aria-busy={browse.isPending || undefined}
    >
      {phone && view !== "new-popular" ? (
        <div className="pt-nav">
          <CategoryBar view={view} />
        </div>
      ) : null}

      {hasHero ? (
        <>
          {typed && !phone ? <ViewHeader view={view} /> : null}
          <h1 className="sr-only">
            {view === "home" ? `${profile.name}'s home` : VIEW_TITLES[view]}
          </h1>
          {billboard ? <Billboard billboard={billboard} /> : <BillboardSkeleton />}
        </>
      ) : (
        <header
          className={cx(
            "px-gutter pb-6",
            phone ? "pt-[calc(var(--spacing-nav)+0.75rem)]" : "pt-[calc(var(--spacing-nav)+2rem)]",
          )}
        >
          <h1 className="type-headline text-fg">{VIEW_TITLES[view]}</h1>
          {view === "new-popular" ? (
            <p className="mt-2 type-body text-fg-muted">
              What's arrived on Webflix and what everyone is watching today.
            </p>
          ) : null}
        </header>
      )}

      <div
        className={cx(
          "relative z-(--z-raised) flex flex-col gap-row-gap",
          hasHero && !phone ? "-mt-[6vw]" : phone && hasHero ? "mt-8" : null,
        )}
      >
        {kidsHome && !browse.isPending ? <KidsGreeting /> : null}
        {browse.isPending ? (
          FIRST_LOAD_LAYOUTS.map((layout, index) => (
            <RowSliderSkeleton key={index} layout={layout} />
          ))
        ) : rows.length === 0 ? (
          <EmptyBrowse view={view} />
        ) : (
          rows.map((row, index) => (
            <SectionErrorBoundary key={row.id} fallback={() => null}>
              {index < EAGER_ROWS ? (
                <BrowseRow row={row} view={view} priority={index === 0} />
              ) : (
                <LazyMount
                  placeholder={<RowSliderSkeleton layout={row.layout} title={row.title} />}
                >
                  <BrowseRow row={row} view={view} />
                </LazyMount>
              )}
            </SectionErrorBoundary>
          ))
        )}
        {browse.data ? <MoreRows query={browse} /> : null}
      </div>
    </main>
  );
}

/**
 * The Kids home greets its viewer by name, with their picture: a child recognises "their" page,
 * and a grown-up sees whose profile is on.
 */
function KidsGreeting() {
  const profile = useBrowseProfile();
  return (
    <div data-testid="kids-greeting" className="flex items-center gap-3 px-gutter sm:gap-4">
      <Avatar src={profile.avatar.imageUrl} name={profile.name} size="md" decorative />
      <p className="flex flex-col">
        <span className="type-title-lg text-fg">Hi, {profile.name}!</span>
        <span className="type-body-sm text-fg-muted">Shows and films picked for you</span>
      </p>
    </div>
  );
}

/** Loads the next batch of rows as the end of the page comes near. */
interface NextBatch {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}

function MoreRows({ query }: { query: NextBatch }) {
  const [ref, near] = useInView<HTMLDivElement>({ rootMargin: "1400px 0px", once: false });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;

  useEffect(() => {
    if (near && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [near, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  if (isFetchNextPageError) {
    return (
      <div className="flex flex-col items-start gap-3 px-gutter">
        <p className="type-body text-fg-muted">More rows couldn't be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => fetchNextPage()}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div ref={ref} className="flex flex-col gap-row-gap">
      {isFetchingNextPage ? (
        <>
          <RowSliderSkeleton layout="standard" />
          <RowSliderSkeleton layout="standard" />
        </>
      ) : null}
    </div>
  );
}

function EmptyBrowse({ view }: { view: BrowseView }) {
  return (
    <div className="px-gutter py-16 text-center">
      <p className="type-title text-fg">Nothing to show here yet</p>
      <p className="mt-2 type-body text-fg-muted">
        {view === "home"
          ? "New titles arrive every week."
          : `There are no ${VIEW_TITLES[view].toLowerCase()} for this profile yet.`}
      </p>
    </div>
  );
}

/** Series / Movies: the view's name and a genre picker, over the top of the billboard. */
function ViewHeader({ view }: { view: "series" | "movies" }) {
  return (
    <div className="absolute inset-x-0 top-nav z-(--z-raised) flex items-center gap-6 px-gutter py-2">
      <p aria-hidden className="type-title-lg text-fg drop-shadow-md">
        {VIEW_TITLES[view]}
      </p>
      <GenreMenu type={view === "series" ? "series" : "movie"} />
    </div>
  );
}

/** Phones: the category pills under the top bar (Series, Movies, Categories). */
function CategoryBar({ view }: { view: BrowseView }) {
  const pill =
    "focus-ring inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 type-label transition-colors duration-fast ease-standard";
  return (
    <nav
      aria-label="Categories"
      className="scrollbar-none flex items-center gap-2 overflow-x-auto px-gutter py-2"
    >
      {view === "series" || view === "movies" ? (
        <>
          <Link
            to="/browse"
            aria-label="Back to Home"
            className={cx(pill, "border-line-strong px-2 text-fg")}
          >
            <CloseIcon size="sm" />
          </Link>
          <span aria-current="page" className={cx(pill, "border-fg bg-fg text-fg-inverse")}>
            {VIEW_TITLES[view]}
          </span>
          <GenreMenu type={view === "series" ? "series" : "movie"} appearance="pill">
            All genres
          </GenreMenu>
        </>
      ) : (
        <>
          <Link
            to="/browse/series"
            className={cx(pill, "border-line-strong text-fg hover:border-fg")}
          >
            Series
          </Link>
          <Link
            to="/browse/movies"
            className={cx(pill, "border-line-strong text-fg hover:border-fg")}
          >
            Movies
          </Link>
          <GenreMenu appearance="pill">Categories</GenreMenu>
        </>
      )}
    </nav>
  );
}

export function HomeBrowsePage() {
  return <BrowseScreen view="home" />;
}

export function SeriesBrowsePage() {
  return <BrowseScreen view="series" />;
}

export function MoviesBrowsePage() {
  return <BrowseScreen view="movies" />;
}

export function NewPopularBrowsePage() {
  return <BrowseScreen view="new-popular" />;
}
