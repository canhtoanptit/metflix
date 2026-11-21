import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiError, createProblem } from "@webflix/contracts";
import { expectNoA11yViolations } from "@webflix/ui/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { clearDraft } from "../src/features/member/signup/draft.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { initialState, type MockScenario } from "../src/mocks/state.ts";
import { locationOf } from "./harness.tsx";

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
    expect(await screen.findByRole("alert")).toHaveTextContent(/please wait 0:4[12]/i);
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
    await user.click(screen.getByRole("button", { name: "Continue" }));
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

  it("email → plan → payment (declined, then approved) → profiles → home", async () => {
    const user = userEvent.setup();
    let signups = 0;
    const { router, container } = renderMember("/signup", "anonymous", (base) => ({
      signup: async (input, options) => {
        signups += 1;
        return base.signup(input, options);
      },
    }));
    await throughStepOne(user, "new.member@example.com");

    // Plan: the recommended plan is preselected and the choice lives in the URL.
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup/plan"));
    expect(await screen.findByRole("heading", { name: /Choose the plan/ })).toHaveFocus();
    await user.click(await screen.findByRole("radio", { name: /Basic/ }));
    await waitFor(() => expect(locationOf(router)).toBe("/signup/plan?plan=basic"));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Payment: card formatting, a declined card, then an approved one.
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup/payment"));
    await screen.findByText(/Basic ·/);
    const number = screen.getByLabelText("Card number");
    await user.type(number, "4000000000000002");
    expect(number).toHaveValue("4000 0000 0000 0002");
    await user.type(screen.getByLabelText("Expiry (MM / YY)"), "1230");
    expect(screen.getByLabelText("Expiry (MM / YY)")).toHaveValue("12 / 30");
    await user.type(screen.getByLabelText("Security code"), "123");
    await user.type(screen.getByLabelText("Name on card"), "Sam Rivera");
    await user.click(screen.getByRole("button", { name: "Start membership" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined");
    await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveFocus());
    expect(screen.getByLabelText("Card number")).toHaveAccessibleDescription(/declined/);
    await expectNoA11yViolations(container);

    await user.clear(screen.getByLabelText("Card number"));
    await user.type(screen.getByLabelText("Card number"), "4242424242424242");
    // Two quick submits send one request.
    const start = screen.getByRole("button", { name: "Start membership" });
    await user.dblClick(start);
    await waitFor(() => expect(router.state.location.pathname).toBe("/signup/profile"), {
      timeout: 5000,
    });
    expect(signups).toBe(2);

    // Profiles: the first name is required; then into the app.
    await user.click(await screen.findByRole("button", { name: "Start watching" }));
    expect(screen.getByLabelText("Your name")).toHaveAccessibleDescription("Enter a name.");
    await user.type(screen.getByLabelText("Your name"), "Sam");
    await user.type(screen.getByLabelText("Profile 2 name (optional)"), "Pip");
    await user.click(screen.getAllByRole("checkbox", { name: "Kids profile" })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Create 2 profiles" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse"), { timeout: 5000 });
  }, 30_000);

  it("steps guard themselves: plan and payment need the earlier answers", async () => {
    const { router } = renderMember("/signup/payment?plan=basic", "anonymous");
    await waitFor(() => expect(locationOf(router)).toBe("/signup"));
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

  it("forgot PIN: the account password removes the lock and goes straight in", async () => {
    const user = userEvent.setup();
    const { router } = renderMember("/profiles", "account");
    await user.click(await screen.findByRole("button", { name: /^Theo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.click(within(dialog).getByRole("button", { name: "Forgot PIN?" }));
    const reset = await screen.findByRole("dialog", { name: "Remove profile lock" });
    await user.type(within(reset).getByLabelText("Account password"), "webflix-demo");
    await user.click(within(reset).getByRole("button", { name: "Remove lock" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse"));
  });
});

describe("manage profiles", () => {
  it("raising a maturity rating asks for the password; a wrong one is said inline", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn<ApiClient["updateProfile"]>();
    const { router } = renderMember("/profiles/profile-kids/edit", "account", (base) => ({
      updateProfile: async (input, options) => {
        updateProfile(input, options);
        if (input.body.currentPassword === "wrong-password") {
          throw new ApiError(createProblem("current_password_invalid"));
        }
        return base.updateProfile(input, options);
      },
    }));
    await user.click(await screen.findByRole("switch", { name: "Kids profile" }));
    await user.click(screen.getByRole("radio", { name: /13\+ · Teens/ }));
    expect(screen.getByText(/asked for your account password/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(confirm).getByLabelText("Account password"), "wrong-password");
    await user.click(within(confirm).getByRole("button", { name: "Save changes" }));
    const field = within(confirm).getByLabelText("Account password");
    await waitFor(() => expect(field).toHaveAccessibleDescription(/isn't right/));
    expect(field).toHaveValue("");
    await user.type(field, "webflix-demo");
    await user.click(within(confirm).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
    expect(updateProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: { isKids: false, maturityCeiling: "13+", currentPassword: "webflix-demo" },
      }),
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
    const { router } = renderMember("/account/cancel", "profile");
    await user.click(await screen.findByRole("button", { name: "Finish cancellation" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/account"));
    expect(await screen.findByText(/Your membership ends on/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Keep my membership" }));
    await waitFor(() => expect(screen.queryByText(/Your membership ends on/)).toBeNull());
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
