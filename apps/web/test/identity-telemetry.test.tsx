import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "@webflix/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockScenario } from "../src/mocks/state.ts";

/**
 * Behaviour events queued under one identity must never be sent under the next: every flow that
 * changes who the session is drops the queue before its request (the runtime also drops it when
 * the new session arrives, but a batch sent in between would be stamped with the new identity).
 * Each test records, at the moment the identity-changing request leaves, whether the queue had
 * been dropped; removing the call fails it.
 */
const discard = vi.hoisted(() => vi.fn());
vi.mock("../src/app/telemetry/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/app/telemetry/runtime.ts")>()),
  discardPendingEvents: discard,
}));

function renderApp(
  path: string,
  scenario: MockScenario,
  overrides: (base: ApiClient) => Partial<ApiClient>,
) {
  const base = createMockApiClient({
    state: initialState(scenario),
    settings: { latencyMs: 0, failing: [] },
  });
  const client = { ...base, ...overrides(base) } as ApiClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(client, { history });
  render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return runtime;
}

/** Wraps an API method: records how many times the queue had been dropped when it was called. */
function recording<K extends keyof ApiClient>(base: ApiClient, key: K, seen: number[]) {
  const original = base[key] as (...args: unknown[]) => unknown;
  return {
    [key]: (...args: unknown[]) => {
      seen.push(discard.mock.calls.length);
      return original(...args);
    },
  } as Partial<ApiClient>;
}

beforeEach(() => {
  discard.mockClear();
  sessionStorage.clear();
});

describe("queued behaviour events never cross identities", () => {
  it("signing out drops them before the request", async () => {
    const seen: number[] = [];
    renderApp("/logout", "profile", (base) => recording(base, "logout", seen));
    await screen.findByRole("heading", { name: "You've signed out" });
    expect(seen).toEqual([1]);
  });

  it("signing out of every device drops them before the request", async () => {
    const user = userEvent.setup();
    const seen: number[] = [];
    renderApp("/account/devices", "profile", (base) => recording(base, "logoutAll", seen));
    await user.click(await screen.findByRole("button", { name: "Sign out of all devices" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("choosing a profile, with its PIN too, drops them before PUT /session/profile", async () => {
    const user = userEvent.setup();
    const seen: number[] = [];
    renderApp("/profiles", "account", (base) => recording(base, "selectProfile", seen));
    await user.click(await screen.findByRole("button", { name: /^Theo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.type(within(dialog).getByLabelText("Digit 1 of 4"), "1234");
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("signing in drops what was queued while signed out, before the request", async () => {
    const user = userEvent.setup();
    const seen: number[] = [];
    renderApp("/login", "anonymous", (base) => recording(base, "login", seen));
    await user.type(await screen.findByLabelText("Email address"), "demo@webflix.dev");
    await user.type(screen.getByLabelText("Password", { exact: true }), "webflix-demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeGreaterThan(0);
  });
});
