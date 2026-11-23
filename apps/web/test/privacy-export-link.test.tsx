/**
 * The export email's link (`/account/privacy/exports/{id}#token=…`), the served terms on Account ›
 * Privacy, and what a deletion does to the membership, in the real app over the mock API.
 */
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiError, createProblem, type PrivacyRequest } from "@webflix/contracts";
import { toast } from "@webflix/ui";
import { expectNoA11yViolations } from "@webflix/ui/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import {
  resetMockPrivacy,
  setMockExportMode,
  setMockPrivacyRequests,
} from "../src/mocks/privacy.ts";
import { initialState, type MockState } from "../src/mocks/state.ts";

vi.setConfig({ testTimeout: 15_000 });

function renderAt(
  path: string,
  state: MockState,
  spy: (base: ApiClient) => Partial<ApiClient> = () => ({}),
) {
  const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
  const client = { ...base, ...spy(base) } as ApiClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(client, { history });
  const view = render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return { ...view, ...runtime, history };
}

function signedInAs(profileId: string | null): MockState {
  const state = initialState("account");
  state.activeProfileId = profileId;
  return state;
}

const DAY = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

function exportRequest(overrides: Partial<PrivacyRequest> = {}): PrivacyRequest {
  return {
    id: "export-ready",
    kind: "export",
    status: "completed",
    requestedAt: iso(-DAY),
    scheduledFor: null,
    completedAt: iso(-DAY + 60_000),
    downloadUrl: "/api/v1/privacy/exports/export-ready?token=mock-export-ready",
    expiresAt: iso(6 * DAY),
    membership: null,
    email: "sent",
    ...overrides,
  };
}

beforeEach(() => {
  resetMockPrivacy("opt-in");
  toast.reset();
  sessionStorage.clear();
  URL.createObjectURL ??= () => "blob:mock";
  URL.revokeObjectURL ??= () => {};
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the export email's link", () => {
  it("signed out: asks to sign in and come back, with the token out of the address bar", async () => {
    const { history, container } = renderAt(
      "/account/privacy/exports/export-ready#token=mock-export-ready",
      initialState("anonymous"),
    );
    await screen.findByRole("heading", { name: "Sign in to download your data" });
    expect(history.location.hash).toBe("");
    const signIn = screen.getByRole("link", { name: "Sign in" });
    expect(signIn.getAttribute("href")).toBe(
      `/login?redirect=${encodeURIComponent("/account/privacy/exports/export-ready")}`,
    );
    expect(sessionStorage.getItem("webflix:export-token:export-ready")).toBe("mock-export-ready");
    await expectNoA11yViolations(container);
  });

  it("as the account holder: downloads through the API with the link's token", async () => {
    const state = signedInAs("profile-mara");
    setMockPrivacyRequests(state.account.id, [exportRequest()]);
    const downloads: unknown[] = [];
    renderAt("/account/privacy/exports/export-ready#token=mock-export-ready", state, (base) => ({
      fetchDataExport: (input, options) => {
        downloads.push(input);
        return base.fetchDataExport(input, options);
      },
    }));
    await screen.findByRole("heading", { name: "Your data is ready" });
    await userEvent.click(screen.getByRole("button", { name: "Download your data" }));
    await screen.findByRole("heading", { name: "Your download has started" });
    expect(downloads).toEqual([
      { params: { id: "export-ready" }, body: { token: "mock-export-ready" } },
    ]);
  });

  it("comes back after signing in: the token was kept in the tab", async () => {
    sessionStorage.setItem("webflix:export-token:export-ready", "mock-export-ready");
    const state = signedInAs("profile-mara");
    setMockPrivacyRequests(state.account.id, [exportRequest()]);
    renderAt("/account/privacy/exports/export-ready", state);
    await screen.findByRole("heading", { name: "Your data is ready" });
  });

  it("at Who's watching? and on a kids profile: leads to a profile that may download it", async () => {
    const gate = renderAt("/account/privacy/exports/export-ready#token=t", signedInAs(null));
    await screen.findByRole("heading", { name: "Choose your profile to continue" });
    gate.unmount();
    renderAt("/account/privacy/exports/export-ready#token=t", signedInAs("profile-kids"));
    await screen.findByRole("heading", { name: "Switch to a profile without parental controls" });
  });

  it("one honest screen for a link that cannot be used", async () => {
    const state = signedInAs("profile-mara");
    setMockPrivacyRequests(state.account.id, [
      exportRequest({ id: "export-old", downloadUrl: null, expiresAt: iso(-DAY) }),
    ]);
    const expired = renderAt("/account/privacy/exports/export-old#token=x", state);
    await screen.findByRole("heading", { name: "This link has expired" });
    expect(screen.getByText(/Ask for a new copy in Account › Privacy/)).toBeInTheDocument();
    expired.unmount();
    const other = renderAt("/account/privacy/exports/someone-elses#token=x", state);
    await screen.findByRole("heading", { name: "This link is for another Webflix account" });
    other.unmount();
    renderAt("/account/privacy/exports/export-ready", state);
    await screen.findByRole("heading", { name: "This link can't be used" });
  });
});

describe("the terms, from the server, before asking", () => {
  it("says how long the export takes and how long the deletion waits", async () => {
    renderAt("/account/privacy", signedInAs("profile-mara"));
    await screen.findByText(/It usually takes about a minute/);
    expect(screen.getByText(/the download will be here for\s+7 days/)).toBeInTheDocument();
    expect(screen.getByText(/Your account keeps working for\s+14 days/)).toBeInTheDocument();
    expect(
      screen.getByText(/deleted after 13 months, and totals made from it after 37 months/),
    ).toBeInTheDocument();
  });

  it("a batch export says it can take up to half an hour", async () => {
    setMockExportMode("batch");
    renderAt("/account/privacy", signedInAs("profile-mara"));
    await screen.findByText(/It usually takes up to half an hour/);
  });
});

describe("a deletion and the membership", () => {
  it("says before, and while scheduled, that the membership ends and nothing more is charged", async () => {
    renderAt("/account/privacy", signedInAs("profile-mara"));
    const section = await screen.findByRole("region", { name: "Delete your account" });
    // Conditional, from the shared outcome: what deleting today would do.
    await within(section).findByText(
      /If you delete your account today: You can watch until .+\. Nothing more is charged\./,
    );
    await userEvent.click(within(section).getByRole("button", { name: "Delete my account" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete your account?" });
    expect(dialog).toHaveTextContent(/Nothing more is charged\./);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent(/Your account will be deleted on/);
    expect(notice).toHaveTextContent(/Nothing more is charged\./);
    // Focus lands on what happened.
    await waitFor(() => expect(notice).toHaveFocus());
  });

  it("a kept account offers to resume the membership, saying what the next bill is", async () => {
    const resumed = vi.fn();
    renderAt("/account/privacy", signedInAs("profile-mara"), (base) => ({
      resumeMembership: (input, options) => {
        resumed();
        return base.resumeMembership(input, options);
      },
    }));
    const section = await screen.findByRole("region", { name: "Delete your account" });
    await userEvent.click(
      await within(section).findByRole("button", { name: "Delete my account" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: "Delete your account?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));
    // Not while the deletion is scheduled.
    await screen.findByRole("button", { name: "Keep my account" });
    expect(screen.queryByRole("button", { name: "Resume membership" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Keep my account" }));
    const resume = await screen.findByRole("button", { name: "Resume membership" });
    // The resume notice takes focus after keeping (UX review 2.7).
    await waitFor(() => expect(resume.closest('[role="status"]')).toHaveFocus());
    expect(
      screen.getByText(/If you resume it: Your next payment is .+ on .+\./),
    ).toBeInTheDocument();
    await userEvent.click(resume);
    await waitFor(() => expect(resumed).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Resume membership" })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Delete your account" })).toHaveFocus(),
    );
  });

  it("says so honestly when the server refuses to resume because a deletion is scheduled", async () => {
    renderAt("/account/privacy", signedInAs("profile-mara"), () => ({
      resumeMembership: () =>
        Promise.reject(new ApiError(createProblem("account_deletion_scheduled"))),
    }));
    const section = await screen.findByRole("region", { name: "Delete your account" });
    await userEvent.click(
      await within(section).findByRole("button", { name: "Delete my account" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: "Delete your account?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep my account" }));
    await userEvent.click(await screen.findByRole("button", { name: "Resume membership" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your account is scheduled for deletion, so the membership can't be resumed",
    );
  });

  it("while the erasure runs, says so plainly and offers nothing that cannot work", async () => {
    const state = signedInAs("profile-mara");
    setMockPrivacyRequests(state.account.id, [
      {
        ...exportRequest({ id: "deletion-running", kind: "deletion", status: "processing" }),
        scheduledFor: iso(-60_000),
        completedAt: null,
        downloadUrl: null,
        expiresAt: null,
        email: "sent",
      },
    ]);
    renderAt("/account/privacy", state);
    await screen.findByText("We're deleting your account");
    expect(screen.getByText(/can't be stopped now/)).toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).queryByRole("button")).toBeNull();
    expect(within(main).queryByRole("switch")).toBeNull();
  });
});

describe("the export's email", () => {
  it("is promised only when one will come", async () => {
    setMockExportMode("batch");
    const state = signedInAs("profile-mara");
    setMockPrivacyRequests(state.account.id, [
      exportRequest({
        status: "processing",
        completedAt: null,
        downloadUrl: null,
        expiresAt: null,
        email: "suppressed",
        requestedAt: iso(-10_000),
      }),
    ]);
    renderAt("/account/privacy", state);
    await screen.findByText("Preparing your data");
    expect(
      screen.getByText(
        /We can't email .+ \(earlier emails to it didn't arrive\), so check back here\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/We'll email/)).toBeNull();
  });
});
