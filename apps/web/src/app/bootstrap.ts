import type { RouterHistory } from "@tanstack/react-router";
import type { ApiClient } from "@webflix/contracts";
import { setApiClient } from "./api.ts";
import { createQueryClient } from "./query/client.ts";
import { type AppRouter, createAppRouter } from "./router/router.tsx";
import { sessionCache } from "./session/session.ts";

/**
 * Wire the API client, the QueryClient and the router together. Shared by `main.tsx` and tests,
 * so tests run the real guards, cache policy and route tree.
 */
export function createAppRuntime(apiClient: ApiClient, options: { history?: RouterHistory } = {}) {
  setApiClient(apiClient);
  const runtime: { router?: AppRouter } = {};
  const queryClient = createQueryClient({
    onUnauthenticated: () => {
      sessionCache.signOut(queryClient);
      void runtime.router?.invalidate();
    },
    onProfileRequired: () => {
      sessionCache.clearProfile(queryClient);
      void runtime.router?.invalidate();
    },
  });
  const router = createAppRouter(queryClient, options.history);
  runtime.router = router;
  return { queryClient, router };
}
