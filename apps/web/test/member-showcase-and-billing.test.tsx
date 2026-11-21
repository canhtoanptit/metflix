import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiError, createProblem } from "@webflix/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { clearDraft } from "../src/features/member/signup/draft.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockScenario } from "../src/mocks/state.ts";

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

describe("account: update payment method", () => {
  it("replaces the card through its own endpoint, not a plan change", async () => {
    const user = userEvent.setup();
    let update = vi.fn<ApiClient["updatePaymentMethod"]>();
    const changePlan = vi.fn<ApiClient["changePlan"]>();
    renderApp("/account", "profile", (base) => {
      update = vi.fn(base.updatePaymentMethod);
      return { updatePaymentMethod: update, changePlan };
    });
    await user.click(await screen.findByRole("button", { name: "Update payment method" }));
    const dialog = await screen.findByRole("dialog", { name: "Update payment method" });
    await user.type(within(dialog).getByLabelText(/Card number/i), "5555 5555 5555 4444");
    await user.type(within(dialog).getByLabelText(/Expiry/i), "0333");
    await user.type(within(dialog).getByLabelText(/Security code|CVC/i), "123");
    await user.type(within(dialog).getByLabelText(/Name on card/i), "Sam Rivera");
    await user.click(within(dialog).getByRole("button", { name: "Save card" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0].body.payment.cardNumber.replaceAll(" ", "")).toBe(
      "5555555555554444",
    );
    expect(changePlan).not.toHaveBeenCalled();
    expect(await screen.findByText(/•••• 4444/)).toBeVisible();
  });
});
