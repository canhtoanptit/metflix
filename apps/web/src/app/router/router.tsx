import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { NotFoundPage, RouteErrorPage } from "../errors/ErrorPages.tsx";
import { PagePending } from "./PagePending.tsx";
import { routeTree } from "./tree.ts";

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    context: { queryClient },
    // Hovering or focusing a link preloads the route's code and loader.
    defaultPreload: "intent",
    // React Query owns data freshness; the router never serves its own stale loader data.
    defaultPreloadStaleTime: 0,
    defaultPendingMs: 600,
    defaultPendingMinMs: 300,
    defaultPendingComponent: PagePending,
    defaultErrorComponent: RouteErrorPage,
    defaultNotFoundComponent: NotFoundPage,
    // Back/forward restore the scroll position of each history entry.
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
