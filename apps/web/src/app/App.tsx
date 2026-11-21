import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { UiProvider } from "@webflix/ui";
import type { AppRouter } from "./router/router.tsx";

export interface AppProps {
  queryClient: QueryClient;
  router: AppRouter;
}

/** Providers, outermost first: data, design-system runtime (tooltips, toasts), routing. */
export function App({ queryClient, router }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <UiProvider>
        <RouterProvider router={router} />
      </UiProvider>
    </QueryClientProvider>
  );
}
