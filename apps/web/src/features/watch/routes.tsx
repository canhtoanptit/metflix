/**
 * WATCH — owned by the member + watch engineer. Full-screen playback, outside the browse shell,
 * under the profile guard.
 */
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { profileLayout } from "../../app/router/layouts.tsx";
import { optionalSearch, searchParam } from "../../app/router/search.ts";

export const watchRoute = createRoute({
  getParentRoute: () => profileLayout,
  path: "/watch/$titleId",
  staticData: { title: "Watch" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      /** Episode to play (series); the server picks the resume episode when absent. */
      episode: searchParam.string(search.episode),
      /** Start position in seconds ("Play from beginning" passes 0). */
      t: searchParam.int(search.t),
    }),
  component: lazyRouteComponent(() => import("./WatchPage.tsx"), "WatchPage"),
});

export const watchRoutes = { profile: [watchRoute] } as const;
