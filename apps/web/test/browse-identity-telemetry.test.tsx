import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "@webflix/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { profileMenuModule } from "../src/features/browse/shell/menus.tsx";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState } from "../src/mocks/state.ts";

/**
 * The browse profile switcher changes who the session is: behaviour events queued for the
 * profile being left must be dropped before `PUT /session/profile` leaves, or a batch sent in
 * between would be stamped by the server as the next profile's. The test records, at the moment
 * the request leaves, whether the queue had been dropped; removing the call fails it.
 */
const discard = vi.hoisted(() => vi.fn());
vi.mock("../src/app/telemetry/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/app/telemetry/runtime.ts")>()),
  discardPendingEvents: discard,
}));

beforeEach(() => {
  discard.mockClear();
  sessionStorage.clear();
});

describe("the browse profile menu", () => {
  it("drops queued behaviour events before switching profile", { timeout: 30_000 }, async () => {
    // The menu's code is loaded up front (the shell preloads it when the page is idle, a timer
    // that a busy machine delays): the real trigger is on screen from the first render, so
    // nothing here waits on idle time.
    await profileMenuModule.load();
    const user = userEvent.setup();
    const seen: number[] = [];
    const base = createMockApiClient({
      state: initialState("profile"),
      settings: { latencyMs: 0, failing: [] },
    });
    const client = {
      ...base,
      selectProfile: (...args: Parameters<ApiClient["selectProfile"]>) => {
        seen.push(discard.mock.calls.length);
        return base.selectProfile(...args);
      },
    } as ApiClient;
    const history = createMemoryHistory({ initialEntries: ["/browse"] });
    const runtime = createAppRuntime(client, { history });
    render(<App queryClient={runtime.queryClient} router={runtime.router} />);

    const trigger = await screen.findByRole(
      "button",
      { name: /^Profile menu for/, expanded: false },
      { timeout: 20_000 },
    );
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: /^Kids/ }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeGreaterThan(0);
  });
});
