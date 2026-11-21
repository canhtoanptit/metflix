import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockScenario } from "../src/mocks/state.ts";

/**
 * The real app (route tree, guards, query client) over the in-browser mock API, at `path`, in a
 * given session state. Latency 0 keeps tests fast.
 */
export function renderApp(path: string, scenario: MockScenario) {
  const apiClient = createMockApiClient({
    state: initialState(scenario),
    settings: { latencyMs: 0, failing: [] },
  });
  const history = createMemoryHistory({ initialEntries: [path] });
  const { router, queryClient } = createAppRuntime(apiClient, { history });
  const view = render(<App queryClient={queryClient} router={router} />);
  return { ...view, router, queryClient, history };
}

export const locationOf = (router: ReturnType<typeof renderApp>["router"]) =>
  `${router.state.location.pathname}${router.state.location.searchStr}`;
