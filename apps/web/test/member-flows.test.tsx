import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiError, createProblem } from "@webflix/contracts";
import { expectNoA11yViolations } from "@webflix/ui/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { leaveFor } from "../src/features/member/billing/navigation.ts";
import { clearDraft } from "../src/features/member/signup/draft.ts";
import { mockProviderConfirm } from "../src/mocks/billing.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockScenario } from "../src/mocks/state.ts";
import { locationOf } from "./harness.tsx";

vi.mock("../src/features/member/billing/navigation.ts", () => ({ leaveFor: vi.fn() }));

/**
 * Member flows in the real app (routes, guards, query client) over the in-browser mock API.
 * `overrides` replace single API methods to produce answers the mock never gives (rate limits,
 * declines) and to count calls.
 */
function renderMember(
  path: string,
  scenario: MockScenario,
  overrides: Partial<ApiClient> | ((base: ApiClient) => Partial<ApiClient>) = {},
) {
  const base = createMockApiClient({
    state: initialState(scenario),
    settings: { latencyMs: 0, failing: [] },
  });
  const client = {
    ...base,
    ...(typeof overrides === "function" ? overrides(base) : overrides),
  } as ApiClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(client, { history });
  const view = render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return { ...view, ...runtime };
}

const rateLimited = (retryAfterSec = 30) =>
  new ApiError(createProblem("rate_limited", { retryAfterSec }));

beforeEach(() => {
  clearDraft();
  sessionStorage.clear();
});

describe("sign in", () => {
  it("wrong credentials: one clear alert, password cleared and focused for another try", async () => {
    const user = userEvent.setup();
    const { container } = renderMember("/login", "anonymous");
    await user.type(await screen.findByLabelText("Email address"), "demo@webflix.dev");
    await user.type(screen.getByLabelText("Password", { exact: true }), "nope-nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password");
    const password = screen.getByLabelText("Password", { exact: true });
    expect(password).toHaveValue("");
    await waitFor(() => expect(password).toHaveFocus());
    await expectNoA11yViolations(container);
  });

  it("on the browser that asked for its account's deletion, Sign in says it was done", async () => {
    // Only the date is kept, and only by the browser that asked (Account › Privacy).
    localStorage.setItem("webflix:deletion-due", new Date(Date.now() - 3_600_000).toISOString());
    try {
      const user = userEvent.setup();
      const { container } = renderMember("/login", "anonymous");
      expect(await screen.findByText("Your account has been deleted")).toBeInTheDocument();
      expect(screen.getByText(/You asked for it on this browser/)).toBeInTheDocument();
      await user.type(screen.getByLabelText("Email address"), "demo@webflix.dev");
      await user.type(screen.getByLabelText("Password", { exact: true }), "nope-nope");
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        /If you meant the account deleted on .+, it no longer exists/,
      );
      // No reset offered for an account that is gone; a new account is.
      expect(within(alert).queryByRole("link", { name: /reset/i })).not.toBeInTheDocument();
      expect(within(alert).getByRole("link", { name: "create a new account" })).toBeInTheDocument();
      await expectNoA11yViolations(container);
    } finally {
      localStorage.removeItem("webflix:deletion-due");
    }
  });

  it("says nothing of a deletion that isn't due yet", async () => {
    localStorage.setItem("webflix:deletion-due", new Date(Date.now() + 3_600_000).toISOString());
    try {
      renderMember("/login", "anonymous");
      expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
      expect(screen.queryByText("Your account has been deleted")).not.toBeInTheDocument();
    } finally {
      localStorage.removeItem("webflix:deletion-due");
    }
  });

  it("validates before sending, with errors tied to their fields", async () => {
    const user = userEvent.setup();
    const login = vi.fn();
    renderMember("/login", "anonymous", { login });
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    const email = screen.getByLabelText("Email address");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription(/Enter your email address/);
    expect(email).toHaveFocus();
    expect(login).not.toHaveBeenCalled();
  });

  it("rate limited: a visible timer, and the button stays disabled until it runs out", async () => {
    const user = userEvent.setup();
    const login = vi.fn(async () => {
      throw rateLimited(42);
    });
    renderMember("/login?email=demo%40webflix.dev", "anonymous", { login });
    await user.type(await screen.findByLabelText("Password", { exact: true }), "whatever-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    // One live countdown, on the button; the message itself stays still.
    expect(await screen.findByRole("alert")).toHaveTextContent(/sign-in is paused for a moment/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/\d:\d\d/);
    const button = screen.getByRole("button", { name: /Try again in 0:4[12]/ });
    expect(button).toBeDisabled();
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("continues to the page the member was going to", async () => {
    const user = userEvent.setup();
    const { router } = renderMember("/login?redirect=%2Fmy-list", "anonymous");
    await user.type(await screen.findByLabelText("Email address"), "demo@webflix.dev");
    await user.type(screen.getByLabelText("Password", { exact: true }), "webflix-demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    // Signed in without a profile: the gate first, still carrying the destination.
    await waitFor(() => expect(locationOf(router)).toBe("/profiles?redirect=%2Fmy-list"));
  });
});

describe("sign-up", () => {
  async function throughStepOne(user: ReturnType<typeof userEvent.setup>, email: string) {
    const emailField = await screen.findByLabelText("Email address", {}, { timeout: 5000 });
    await user.clear(emailField);
    await user.type(emailField, email);
    await user.type(screen.getByLabelText("Password", { exact: true }), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));
  }

  /** The provider's hosted form, as the mock's stand-in does it: confirm, then come back. */
  async function atProvider(
    router: ReturnType<typeof renderMember>["router"],
    card: string,
    outcome: "succeeded" | null,
  ) {
    await waitFor(() => expect(leaveFor).toHaveBeenCalled());
    const href = new URL(vi.mocked(leaveFor).mock.calls.at(-1)?.[0] ?? "", "http://app.local");
    vi.mocked(leaveFor).mockClear();
    expect(href.pathname).toBe("/mock-pay");
    mockProviderConfirm(href.searchParams.get("secret") ?? "", { card }, () => undefined);
    const back = href.searchParams.get("return") ?? "/";
    await router.navigate({ href: outcome ? `${back}&payment=${outcome}` : back });
  }

  it("offers sign-in when the email already has an account", async () => {
    const user = userEvent.setup();
    renderMember("/signup", "anonymous");
    await throughStepOne(user, "demo@webflix.dev");
    const email = await screen.findByLabelText("Email address");
    await waitFor(() => expect(email).toHaveAccessibleDescription(/already a Webflix account/));
    expect(screen.getByRole("link", { name: "Sign in instead" })).toHaveAttribute(
      "href",
      "/login?email=demo%40webflix.dev",
    );
  });

  it("account → plan → payment in the provider's form (declined, then approved) → profiles → home", async () => {
    const user = userEvent.setup();
    let signups = 0;
    const { router, container } = renderMember("/signup", "anonymous", (base) => ({
      signup: async (input, options) => {
        signups += 1;
        expect(input.body).toEqual({
          email: "new.member@example.com",
          password: expect.any(String),
        });
        return base.signup(input, options);
      },
    }));
    await throughStepOne(user, "new.member@example.com");

    // Plan, signed in: the recommended plan is preselected and the choice lives in the URL.
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup/plan"));
    expect(signups).toBe(1);
    expect(await screen.findByRole("heading", { name: /Choose the plan/ })).toHaveFocus();
    await user.click(await screen.findByRole("radio", { name: /Basic/ }));
    await waitFor(() => expect(locationOf(router)).toBe("/signup/plan?plan=basic"));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Payment: what is due, then the provider's form (no card field on Webflix's page).
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup/payment"));
    await screen.findByText("Basic");
    expect(screen.queryByLabelText(/Card number/)).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Continue to payment" }));
    await atProvider(router, "4000000000000002", null);

    // Back without a result: Webflix asks the server, which reports the decline.
    expect(await screen.findByRole("heading", { name: "Your card was declined" })).toBeVisible();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("link", { name: "Use another card" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup/payment"));
    await user.click(await screen.findByRole("button", { name: "Continue to payment" }));
    await atProvider(router, "4242424242424242", "succeeded");

    // Confirmed: a new member's first card gets the trial.
    expect(
      await screen.findByRole(
        "heading",
        { name: "Your free trial has started" },
        { timeout: 5000 },
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create your profiles" }));

    // Profiles: the first name is required; then into the app.
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup/profile"));
    await user.click(await screen.findByRole("button", { name: "Start watching" }));
    expect(screen.getByLabelText("Your name")).toHaveAccessibleDescription("Enter a name.");
    await user.type(screen.getByLabelText("Your name"), "Sam");
    await user.type(screen.getByLabelText("Profile 2 name (optional)"), "Pip");
    await user.click(screen.getByRole("checkbox", { name: "Profile 2 is a kids profile" }));
    await user.click(screen.getByRole("button", { name: "Create 2 profiles" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse"), { timeout: 5000 });
  }, 30_000);

  it("steps guard themselves: a guest starts at the beginning", async () => {
    const { router } = renderMember("/signup/payment?plan=basic", "anonymous");
    await waitFor(() => expect(locationOf(router)).toBe("/signup"));
  });

  it("a signed-in account without a membership resumes at the plan, not the profiles", async () => {
    const state = initialState("account");
    state.profiles = [];
    state.billing = {
      membership: {
        status: "none",
        planId: null,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        currentPeriodEnd: null,
        graceEndsAt: null,
        suspendedReason: null,
        provider: null,
      },
      trialUsed: false,
      trialCards: [],
      checkouts: [],
      setups: [],
      invoices: [],
    };
    const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
    const history = createMemoryHistory({ initialEntries: ["/signup/profile"] });
    const runtime = createAppRuntime(base, { history });
    render(<App queryClient={runtime.queryClient} router={runtime.router} />);
    await waitFor(() => expect(locationOf(runtime.router)).toBe("/signup/plan"));
  });
});

describe("profile gate", () => {
  it("wrong PIN, then the right one; the dialog is labelled and the boxes reset", async () => {
    const user = userEvent.setup();
    const { router } = renderMember("/profiles", "account");
    await user.click(await screen.findByRole("button", { name: /^Theo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.keyboard("0000");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Incorrect PIN");
    await waitFor(() => expect(within(dialog).getByLabelText("Digit 1 of 4")).toHaveFocus());
    await user.keyboard("1234");
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse"));
  });

  it("rate-limited PIN attempts show a timer and lock the boxes", async () => {
    const user = userEvent.setup();
    const selectProfile = vi.fn(async () => {
      throw rateLimited(60);
    });
    renderMember("/profiles", "account", { selectProfile });
    await user.click(await screen.findByRole("button", { name: /^Theo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.keyboard("1111");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /Too many attempts.*try again in (1:00|0:59)/i,
    );
    expect(within(dialog).getByLabelText("Digit 1 of 4")).toBeDisabled();
  });

  it("forgot PIN: confirming it's the account holder removes the lock and goes straight in", async () => {
    const user = userEvent.setup();
    const { router } = renderMember("/profiles", "account");
    await user.click(await screen.findByRole("button", { name: /^Theo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.click(within(dialog).getByRole("button", { name: "Forgot PIN?" }));
    const reset = await screen.findByRole("dialog", { name: "Remove profile lock" });
    await user.click(within(reset).getByRole("button", { name: "Remove lock" }));
    const prove = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(await within(prove).findByLabelText("Webflix password"), "webflix-demo");
    await user.click(within(prove).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse"));
  });
});

describe("manage profiles", () => {
  it("raising a maturity rating asks to confirm it's you; a wrong password is said inline", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn<ApiClient["updateProfile"]>();
    const { router } = renderMember("/profiles/profile-kids/edit", "account", (base) => ({
      updateProfile: async (input, options) => {
        updateProfile(input, options);
        return base.updateProfile(input, options);
      },
    }));
    await user.click(await screen.findByRole("switch", { name: "Kids profile" }));
    await user.click(screen.getByRole("radio", { name: /13\+ · Teens/ }));
    expect(screen.getByText(/asked to confirm it's you when you save/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(confirm).toHaveTextContent("To raise Kids' maturity rating to 13+");
    await user.type(await within(confirm).findByLabelText("Webflix password"), "wrong-password");
    await user.click(within(confirm).getByRole("button", { name: "Confirm" }));
    const field = within(confirm).getByLabelText("Webflix password");
    await waitFor(() => expect(field).toHaveAccessibleDescription(/isn't right/));
    expect(field).toHaveValue("");
    expect(updateProfile).not.toHaveBeenCalled();
    await user.type(field, "webflix-demo");
    await user.click(within(confirm).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
    expect(updateProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { isKids: false, maturityCeiling: "13+" } }),
      undefined,
    );
  });

  it("the last profile cannot be deleted, and says why", async () => {
    const state = initialState("account");
    state.profiles = state.profiles.slice(0, 1);
    const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
    const history = createMemoryHistory({ initialEntries: ["/profiles/profile-mara/edit"] });
    const runtime = createAppRuntime(base, { history });
    render(<App queryClient={runtime.queryClient} router={runtime.router} />);
    expect(await screen.findByRole("button", { name: "Delete profile" })).toBeDisabled();
    expect(screen.getByText(/only profile on the account/)).toBeVisible();
  });
});

describe("account", () => {
  it("cancel, then keep the membership", async () => {
    const user = userEvent.setup();
    // The milestone 1 address still leads to the cancel page.
    const { router } = renderMember("/account/cancel", "profile");
    await user.click(await screen.findByRole("button", { name: "Finish cancellation" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/account/membership"));
    // The page's notice and its toast say the same thing (UX review 2.4).
    await waitFor(() => expect(screen.getAllByText(/Your membership ends on/)).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Keep my membership" }));
    // The toast is replaced, not stacked: nothing says "ends on" any more.
    await waitFor(() => expect(screen.queryAllByText(/Your membership ends on/)).toHaveLength(0));
    expect(await screen.findByText("Your membership will continue")).toBeVisible();
  });

  it("signs out another device after confirming", async () => {
    const user = userEvent.setup();
    const { container } = renderMember("/account/devices", "profile");
    await user.click(await screen.findByRole("button", { name: "Sign out Living room TV" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Sign out Living room TV?" });
    await user.click(within(confirm).getByRole("button", { name: "Sign out device" }));
    await waitFor(() => expect(screen.queryByText("Living room TV")).toBeNull());
    await expectNoA11yViolations(container);
  });

  it("viewing activity removes an entry optimistically", async () => {
    const user = userEvent.setup();
    renderMember("/account/activity", "profile");
    const remove = await screen.findByRole("button", { name: /Remove Kilometer Zero/ });
    await user.click(remove);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Remove Kilometer Zero/ })).toBeNull(),
    );
  });
});

describe("accessibility of the member screens", () => {
  it.each([
    ["/", "anonymous"],
    ["/signup", "anonymous"],
    ["/profiles", "account"],
    ["/profiles/manage", "account"],
    ["/profiles/profile-mara/edit", "account"],
    ["/profiles/new", "account"],
    ["/account", "profile"],
    ["/account/plan", "profile"],
    ["/account/security", "profile"],
  ] as const)("%s has no axe violations", async (path, scenario) => {
    const { container, router } = renderMember(path, scenario);
    await waitFor(() => expect(router.state.status).toBe("idle"), { timeout: 5000 });
    await screen.findByRole("heading", { level: 1 }, { timeout: 5000 });
    await waitFor(() => expect(container.querySelector("[aria-busy='true']")).toBeNull());
    await expectNoA11yViolations(container);
  });
});
