/**
 * The privacy screens in the real app over the in-browser mock API: the first-visit consent
 * prompt (who sees it, refusing as easily as accepting, choosing per purpose), and Account ›
 * Privacy (consent switches, the data export as a wait, deletion with its cooling-off period).
 * Seed: Mara (18+), Theo (18+, PIN), Kids (kids, 7+).
 */
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApiClient } from "@webflix/contracts";
import { toast } from "@webflix/ui";
import { expectNoA11yViolations } from "@webflix/ui/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { promptAllowedOn } from "../src/app/telemetry/PrivacyShell.tsx";
import { createMockApiClient } from "../src/mocks/client.ts";
import { resetMockPrivacy } from "../src/mocks/privacy.ts";
import { initialState, type MockState } from "../src/mocks/state.ts";

const PROMPT_WAIT = { timeout: 5000 };
// The prompt waits for the page to settle (1.2 s) after the consent is read.
vi.setConfig({ testTimeout: 15_000 });

function renderAt(path: string, state: MockState, spy: Partial<ApiClient> = {}) {
  const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
  const client = { ...base, ...spy } as ApiClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(client, { history });
  const view = render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return { ...view, ...runtime, client: base };
}

function signedInAs(profileId: string | null): MockState {
  const state = initialState("account");
  state.activeProfileId = profileId;
  return state;
}

beforeEach(() => {
  resetMockPrivacy("opt-in");
  toast.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("the consent prompt", () => {
  it("asks a member on a profile without parental controls, and refusing is one click", async () => {
    const updates: unknown[] = [];
    const state = signedInAs("profile-mara");
    const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
    const { container } = renderAt("/browse", state, {
      updateConsent: (input, options) => {
        updates.push(input.body);
        return base.updateConsent(input, options);
      },
    });
    const prompt = await screen.findByRole(
      "region",
      { name: "Your viewing data, your choice" },
      PROMPT_WAIT,
    );
    const allow = within(prompt).getByRole("button", { name: "Allow" });
    const refuse = within(prompt).getByRole("button", { name: "Don't allow" });
    // Equal weight: the same kind of button, side by side.
    expect(refuse.className).toBe(allow.className);
    await expectNoA11yViolations(container);
    await userEvent.click(refuse);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Your viewing data, your choice" })).toBeNull(),
    );
    expect(updates).toEqual([
      { purpose: "personalisation", granted: false, source: "banner" },
      { purpose: "analytics", granted: false, source: "banner" },
    ]);
  });

  it("lets the member choose per purpose, with nothing ticked for them", async () => {
    const updates: unknown[] = [];
    const state = signedInAs("profile-mara");
    const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
    renderAt("/browse", state, {
      updateConsent: (input, options) => {
        updates.push(input.body);
        return base.updateConsent(input, options);
      },
    });
    const prompt = await screen.findByRole(
      "region",
      { name: "Your viewing data, your choice" },
      PROMPT_WAIT,
    );
    await userEvent.click(within(prompt).getByRole("button", { name: "Choose for each use" }));
    const personalisation = within(prompt).getByRole("switch", {
      name: "Personalized recommendations",
    });
    const analytics = within(prompt).getByRole("switch", { name: "Improving Webflix" });
    expect(personalisation).toHaveAttribute("aria-checked", "false");
    expect(analytics).toHaveAttribute("aria-checked", "false");
    // Focus follows (UX review 2.7): into the choices, back to the button, into them again.
    await waitFor(() => expect(personalisation).toHaveFocus());
    await userEvent.click(within(prompt).getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(within(prompt).getByRole("button", { name: "Choose for each use" })).toHaveFocus(),
    );
    await userEvent.click(within(prompt).getByRole("button", { name: "Choose for each use" }));
    await userEvent.click(
      within(prompt).getByRole("switch", { name: "Personalized recommendations" }),
    );
    await userEvent.click(within(prompt).getByRole("button", { name: "Save choices" }));
    await waitFor(() => expect(updates).toHaveLength(2));
    expect(updates).toEqual([
      { purpose: "personalisation", granted: true, source: "banner" },
      { purpose: "analytics", granted: false, source: "banner" },
    ]);
    // The prompt is gone: focus is on the page it stood in front of.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("MAIN"));
  });

  it("can wait: 'Decide later' puts it off for this visit and records nothing", async () => {
    const updates: unknown[] = [];
    const state = signedInAs("profile-mara");
    const first = renderAt("/browse", state, {
      updateConsent: () => {
        updates.push("answered");
        return Promise.reject(new Error("not expected"));
      },
    });
    const prompt = await screen.findByRole(
      "region",
      { name: "Your viewing data, your choice" },
      PROMPT_WAIT,
    );
    await userEvent.click(within(prompt).getByRole("button", { name: "Decide later" }));
    expect(screen.queryByRole("region", { name: "Your viewing data, your choice" })).toBeNull();
    first.unmount();
    renderAt("/browse", state);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(screen.queryByRole("region", { name: "Your viewing data, your choice" })).toBeNull();
    expect(updates).toEqual([]);
  });

  it("appears only on the browsing pages: never over a flow, the account pages or the player", async () => {
    for (const path of [
      "/browse",
      "/browse/series",
      "/browse/genre/drama",
      "/search",
      "/my-list",
    ]) {
      expect(promptAllowedOn(path), path).toBe(true);
    }
    for (const path of [
      "/",
      "/login",
      "/signup",
      "/signup/payment",
      "/profiles",
      "/profiles/manage",
      "/account",
      "/account/security",
      "/account/membership/checkout",
      "/account/privacy",
      "/watch/t-sintel",
      "/browser-extension",
    ]) {
      expect(promptAllowedOn(path), path).toBe(false);
    }
    renderAt("/account/security", signedInAs("profile-mara"));
    await screen.findByRole("main", {}, PROMPT_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(screen.queryByRole("region", { name: /your viewing data/i })).toBeNull();
  });

  it("never asks a kids profile", async () => {
    renderAt("/browse", signedInAs("profile-kids"));
    await screen.findByRole("main", {}, PROMPT_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(screen.queryByRole("region", { name: /your viewing data/i })).toBeNull();
  });

  it("tells an opt-out member once, with turning it off as easy as keeping it", async () => {
    resetMockPrivacy("opt-out");
    const state = signedInAs("profile-mara");
    const first = renderAt("/browse", state);
    const notice = await screen.findByRole(
      "region",
      { name: "Webflix learns from what you browse" },
      PROMPT_WAIT,
    );
    const keep = within(notice).getByRole("button", { name: "Keep it on" });
    const off = within(notice).getByRole("button", { name: "Turn it off" });
    expect(off.className).toBe(keep.className);
    await userEvent.click(keep);
    expect(screen.queryByRole("region", { name: /learns from what you browse/i })).toBeNull();
    first.unmount();
    renderAt("/browse", state);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(screen.queryByRole("region", { name: /learns from what you browse/i })).toBeNull();
  });
});

describe("Account › Privacy", () => {
  it("changes a purpose with its switch and says why each is on or off", async () => {
    resetMockPrivacy("opt-out");
    const { container } = renderAt("/account/privacy", signedInAs("profile-mara"));
    const personalisation = await screen.findByRole("switch", {
      name: "Personalized recommendations",
    });
    expect(personalisation).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByText("On by default. Turn it off any time.")).toHaveLength(2);
    await userEvent.click(personalisation);
    await waitFor(() => expect(personalisation).toHaveAttribute("aria-checked", "false"));
    await screen.findByText(/^Turned off by you on /);
    // The switch keeps focus through the save (UX review 2.7).
    expect(personalisation).toHaveFocus();
    await expectNoA11yViolations(container);
  });

  it("asks for a copy, says it's being prepared, then offers the download", async () => {
    renderAt("/account/privacy", signedInAs("profile-mara"));
    await userEvent.click(await screen.findByRole("button", { name: "Ask for my data" }));
    await screen.findByText("Preparing your data");
    expect(screen.getByText(/You don't need to stay on this page/)).toBeInTheDocument();
    await screen.findByText("Your data is ready", {}, { timeout: 10_000 });
    // A button now: the token goes in a POST's body, never in a URL (privacy review L3).
    expect(screen.getByRole("button", { name: "Download your data" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download your data" })).toBeNull();
  }, 15_000);

  it("explains deletion before it is asked for, schedules it, and keeping the account is one click", async () => {
    renderAt("/account/privacy", signedInAs("profile-mara"));
    await screen.findByText("What we keep");
    expect(screen.getByText(/invoices, payments and refunds/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete your account?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));
    const scheduled = await screen.findByText(/Your account will be deleted on/);
    expect(scheduled).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep my account" }));
    await screen.findByRole("button", { name: "Delete my account" });
  });

  it("is not offered to a kids profile", async () => {
    renderAt("/account/privacy", signedInAs("profile-kids"));
    await screen.findByRole("heading", {
      name: /available from a profile without parental controls/i,
    });
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
