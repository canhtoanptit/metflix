import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "@webflix/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { clearDraft } from "../src/features/member/signup/draft.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockState } from "../src/mocks/state.ts";

/**
 * Sign-up changes who the session is twice: creating the account signs the browser in, and the
 * first profile is selected at the end. Behaviour events queued before either must be dropped
 * before the request leaves (a batch sent in the window before the client learns of the new
 * session would be stamped with it). Each test records, at the moment the request leaves,
 * whether the queue had been dropped; removing the call fails it.
 */
const discard = vi.hoisted(() => vi.fn());
vi.mock("../src/app/telemetry/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/app/telemetry/runtime.ts")>()),
  discardPendingEvents: discard,
}));

function renderApp(path: string, state: MockState, wrap: (base: ApiClient) => Partial<ApiClient>) {
  const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
  const client = { ...base, ...wrap(base) } as ApiClient;
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
  clearDraft();
  sessionStorage.clear();
});

describe("sign-up never sends queued events under the new identity", () => {
  it("creating the account drops them before POST /auth/signup", async () => {
    const user = userEvent.setup();
    const seen: number[] = [];
    renderApp("/signup", initialState("anonymous"), (base) => recording(base, "signup", seen));
    await user.type(await screen.findByLabelText("Email address"), "new.member@example.com");
    await user.type(screen.getByLabelText("Password", { exact: true }), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("selecting the first profile drops them before PUT /session/profile", async () => {
    const user = userEvent.setup();
    const seen: number[] = [];
    // An account with a membership and nobody to watch yet: the profile step.
    const state = initialState("account");
    state.profiles = [];
    renderApp("/signup/profile", state, (base) => recording(base, "selectProfile", seen));
    await user.type(await screen.findByLabelText("Your name"), "Sam");
    discard.mockClear();
    await user.click(screen.getByRole("button", { name: "Start watching" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBeGreaterThan(0);
  });
});
