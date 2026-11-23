import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiError, createProblem } from "@webflix/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { leaveFor } from "../src/features/member/billing/navigation.ts";
import { clearDraft } from "../src/features/member/signup/draft.ts";
import { mockProviderConfirm, setMockMembership } from "../src/mocks/billing.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockScenario } from "../src/mocks/state.ts";

vi.mock("../src/features/member/billing/navigation.ts", () => ({ leaveFor: vi.fn() }));

/** The real app over the in-browser mock API; `overrides` replace single API methods. */
function renderApp(
  path: string,
  scenario: MockScenario,
  overrides: (base: ApiClient) => Partial<ApiClient> = () => ({}),
) {
  const base = createMockApiClient({
    state: initialState(scenario),
    settings: { latencyMs: 0, failing: [] },
  });
  const client = { ...base, ...overrides(base) } as ApiClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(client, { history });
  const view = render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return { ...view, ...runtime };
}

beforeEach(() => {
  clearDraft();
  sessionStorage.clear();
});

describe("signed-out artwork comes from the public showcase", () => {
  it("the landing page draws the showcase's versioned artwork, fetched once with the navigation", async () => {
    let showcase = vi.fn<ApiClient["getShowcase"]>();
    const { container } = renderApp("/", "anonymous", (base) => {
      showcase = vi.fn(base.getShowcase);
      return { getShowcase: showcase };
    });
    expect(await screen.findByRole("heading", { name: "Now on Webflix" })).toBeVisible();
    const items = (await showcase.mock.results[0]?.value)?.items ?? [];
    const first = items[0];
    if (!first) throw new Error("the mock showcase is empty");
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources.some((src) => src?.includes(`/titles/${first.id}/poster-`))).toBe(true);
    // Every title image comes from the showcase, with its content-hash version.
    const titleImages = sources.filter((src) => src?.includes("/cdn/img/titles/"));
    expect(titleImages.length).toBeGreaterThan(0);
    expect(titleImages.every((src) => src?.includes("?v="))).toBe(true);
    expect(showcase).toHaveBeenCalledTimes(1);
  });

  it("keeps the landing page whole without artwork when the showcase cannot be loaded", async () => {
    const { container } = renderApp("/", "anonymous", () => ({
      getShowcase: vi.fn(async () => {
        throw new ApiError(createProblem("internal_error"));
      }),
    }));
    expect(
      await screen.findByRole("heading", { name: "Stories that stay with you." }),
    ).toBeVisible();
    expect(screen.getAllByLabelText("Email address").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Choose your plan" })).toBeVisible(),
    );
    expect(screen.queryByRole("heading", { name: "Now on Webflix" })).toBeNull();
    expect(container.querySelectorAll('img[src*="/cdn/img/titles/"]')).toHaveLength(0);
  });
});

describe("account: membership and billing", () => {
  it("replaces the card in the provider's form: Webflix never receives the card", async () => {
    const user = userEvent.setup();
    const changePlan = vi.fn<ApiClient["changePlan"]>();
    let setup = vi.fn<ApiClient["setupPaymentMethod"]>();
    const { router } = renderApp("/account/membership/payment", "profile", (base) => {
      setup = vi.fn(base.setupPaymentMethod);
      return { changePlan, setupPaymentMethod: setup };
    });
    // One click: the provider's page is where the new card goes (UX review 3.14).
    await user.click(await screen.findByRole("button", { name: "Replace card" }));
    await waitFor(() => expect(leaveFor).toHaveBeenCalled());
    const href = new URL(vi.mocked(leaveFor).mock.calls.at(-1)?.[0] ?? "", "http://app.local");
    expect(href.pathname).toBe("/mock-pay");
    // The card is chosen on the provider's page, never on Webflix's.
    mockProviderConfirm(
      href.searchParams.get("secret") ?? "",
      { card: "5555555555554444" },
      () => undefined,
    );
    await router.navigate({ href: `${href.searchParams.get("return")}&payment=succeeded` });
    expect(
      await screen.findByText("Your card has been updated", {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(await screen.findByText(/Mastercard •••• 4444/)).toBeVisible();
    expect(setup).toHaveBeenCalledTimes(1);
    expect(changePlan).not.toHaveBeenCalled();
  });

  it("previews a plan change on the server and applies exactly that preview", async () => {
    const user = userEvent.setup();
    let preview = vi.fn<ApiClient["previewPlanChange"]>();
    let changePlan = vi.fn<ApiClient["changePlan"]>();
    const { router } = renderApp("/account/membership/plan", "profile", (base) => {
      preview = vi.fn(base.previewPlanChange);
      changePlan = vi.fn(base.changePlan);
      return { previewPlanChange: preview, changePlan };
    });
    await user.click(await screen.findByRole("radio", { name: /Premium/ }));
    const summary = await screen.findByRole("status", { name: "Switching to Premium" });
    expect(within(summary).getByText("Charged today")).toBeVisible();
    const previewed = await preview.mock.results[0]?.value;
    const pay = screen.getByRole("button", { name: /^Pay .* and switch$/ });
    await user.click(pay);
    await waitFor(() => expect(router.state.location.pathname).toBe("/account/membership"));
    expect(changePlan).toHaveBeenCalledWith({
      body: { planId: "premium", previewToken: previewed.previewToken },
    });
  });

  it("a failed renewal in grace: still watching, with one clear ask", async () => {
    const state = initialState("profile");
    setMockMembership(state, "past_due");
    const client = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
    const history = createMemoryHistory({ initialEntries: ["/account/membership"] });
    const runtime = createAppRuntime(client, { history });
    render(<App queryClient={runtime.queryClient} router={runtime.router} />);
    expect(await screen.findByText("We couldn't take your last payment")).toBeVisible();
    expect(screen.getByText(/You can keep watching until/)).toBeVisible();
    expect(screen.getAllByRole("link", { name: "Update payment method" })[0]).toHaveAttribute(
      "href",
      "/account/membership/payment",
    );
  });

  it("an account on hold is refused playback with the way back, not an error", async () => {
    const state = initialState("profile");
    setMockMembership(state, "suspended");
    const client = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
    const history = createMemoryHistory({ initialEntries: ["/watch/t-sintel"] });
    const runtime = createAppRuntime(client, { history });
    render(<App queryClient={runtime.queryClient} router={runtime.router} />);
    expect(
      await screen.findByRole("heading", { name: "Your membership is on hold" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Update payment method" })).toHaveAttribute(
      "href",
      "/account/membership/payment",
    );
  });
});
