/**
 * BROWSE — owned by the browse engineer. Every browse screen is declared here and lazily
 * loaded from this folder; `app/router/tree.ts` plugs `browseRoutes.profile` into the
 * profile-guarded layout. Add, change or remove routes here only.
 */
import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { BROWSE_VIEWS, GENRE_SORTS, TITLE_TYPES } from "@webflix/contracts";
import { profileLayout } from "../../app/router/layouts.tsx";
import { optionalSearch, searchParam } from "../../app/router/search.ts";

/** Signed-in navigation shell: top nav, profile menu, notifications, the title overlay host. */
export const browseShellRoute = createRoute({
  getParentRoute: () => profileLayout,
  id: "browse-shell",
  component: lazyRouteComponent(() => import("./shell/BrowseShell.tsx"), "BrowseShell"),
});

const homeRoute = createRoute({
  getParentRoute: () => browseShellRoute,
  path: "/browse",
  staticData: { title: "Home" },
  component: lazyRouteComponent(() => import("./home/BrowsePage.tsx"), "HomeBrowsePage"),
});

const seriesRoute = createRoute({
  getParentRoute: () => browseShellRoute,
  path: "/browse/series",
  staticData: { title: "Series" },
  component: lazyRouteComponent(() => import("./home/BrowsePage.tsx"), "SeriesBrowsePage"),
});

const moviesRoute = createRoute({
  getParentRoute: () => browseShellRoute,
  path: "/browse/movies",
  staticData: { title: "Movies" },
  component: lazyRouteComponent(() => import("./home/BrowsePage.tsx"), "MoviesBrowsePage"),
});

const newPopularRoute = createRoute({
  getParentRoute: () => browseShellRoute,
  path: "/browse/new-popular",
  staticData: { title: "New & Popular" },
  component: lazyRouteComponent(() => import("./home/BrowsePage.tsx"), "NewPopularBrowsePage"),
});

export const genreRoute = createRoute({
  getParentRoute: () => browseShellRoute,
  path: "/browse/genre/$slug",
  staticData: { title: "Genre" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      type: searchParam.oneOf(TITLE_TYPES, search.type),
      sort: searchParam.oneOf(GENRE_SORTS, search.sort),
    }),
  component: lazyRouteComponent(() => import("./genre/GenrePage.tsx"), "GenrePage"),
});

const myListRoute = createRoute({
  getParentRoute: () => browseShellRoute,
  path: "/my-list",
  staticData: { title: "My List" },
  component: lazyRouteComponent(() => import("./my-list/MyListPage.tsx"), "MyListPage"),
});

export const searchRoute = createRoute({
  getParentRoute: () => browseShellRoute,
  path: "/search",
  staticData: { title: "Search" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({ q: searchParam.string(search.q) }),
  component: lazyRouteComponent(() => import("./search/SearchPage.tsx"), "SearchPage"),
});

/** Shareable deep link to a title: opens the detail overlay over the home page. */
const titleDeepLinkRoute = createRoute({
  getParentRoute: () => profileLayout,
  path: "/title/$titleId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/browse", search: { title: params.titleId }, replace: true });
  },
});

export const browseRoutes = {
  profile: [
    browseShellRoute.addChildren([
      homeRoute,
      seriesRoute,
      moviesRoute,
      newPopularRoute,
      genreRoute,
      myListRoute,
      searchRoute,
    ]),
    titleDeepLinkRoute,
  ],
} as const;

/** Browse views in nav order, for the shell's links. */
export const BROWSE_NAV = [
  { view: BROWSE_VIEWS[0], to: "/browse", label: "Home" },
  { view: BROWSE_VIEWS[1], to: "/browse/series", label: "Series" },
  { view: BROWSE_VIEWS[2], to: "/browse/movies", label: "Movies" },
  { view: BROWSE_VIEWS[3], to: "/browse/new-popular", label: "New & Popular" },
] as const;
