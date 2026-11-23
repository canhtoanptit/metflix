import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, OIDC_OUTCOMES } from "@webflix/contracts";
import { expectNoA11yViolations } from "@webflix/ui/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { outcomeCopy } from "../src/features/member/auth/FederatedButtons.tsx";
import { afterSignInPath, signInReturnPath } from "../src/features/member/auth/oidc.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import type { MockIdentityState } from "../src/mocks/identity.ts";
import { initialState, type MockScenario, type MockState } from "../src/mocks/state.ts";
import { locationOf } from "./harness.tsx";

/**
 * Sign-in and account security (identity) in the real app over the in-browser mock API: the
 * landing of a federated attempt, "Confirm it's you", and the emailed links.
 */
function renderIdentity(
  path: string,
  scenario: MockScenario,
  options: {
    identity?: Partial<MockIdentityState>;
    state?: (state: MockState) => void;
    overrides?: (base: ApiClient) => Partial<ApiClient>;
  } = {},
) {
  const state = initialState(scenario);
  if (options.identity) {
    state.identity = {
      hasPassword: true,
      emailVerified: true,
      identities: [],
      elevatedUntil: null,
      issuersProveFreshness: true,
      ...options.identity,
    };
  }
  options.state?.(state);
  const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
  const client = { ...base, ...options.overrides?.(base) } as ApiClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(client, { history });
  const view = render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return { ...view, ...runtime, state };
}

const linkedGoogle = (email = "demo@webflix.dev") => [
  { provider: "google" as const, emailAtLink: email, linkedAt: new Date().toISOString() },
];

beforeEach(() => {
  sessionStorage.clear();
});

describe("the words for an attempt that came back signed out", () => {
  it("say what happened for every outcome, and never show an address", () => {
    for (const outcome of OIDC_OUTCOMES) {
      for (const context of ["signin", "signup"] as const) {
        const copy = outcomeCopy(outcome, "Google", context);
        if (copy) expect(`${copy.title} ${copy.body}`).not.toMatch(/@/);
      }
    }
    expect(outcomeCopy("signed-in", "Google", "signin")).toBeNull();
    const linkRequired = outcomeCopy("link-required", "Apple", "signin");
    expect(linkRequired?.body).toContain("Apple can't be added to it automatically");
    expect(linkRequired?.body).toContain("you'll be offered to add Apple right after");
    expect(linkRequired?.more).toContain("Reset the password");
  });

  it("return paths stay same-origin, and an unfinished sign-up resumes the funnel", () => {
    const path = signInReturnPath({
      provider: "google",
      context: "signin",
      from: "/login",
      redirect: "//evil.example/x",
    });
    expect(path).toBe("/login/continue?provider=google&context=signin&from=%2Flogin");
    expect(afterSignInPath({ authenticated: true, profiles: [] }, "/browse")).toBe("/signup");
    expect(afterSignInPath({ authenticated: true, profiles: [{}] }, "/account")).toBe("/account");
    expect(afterSignInPath({ authenticated: true, profiles: [{}] }, undefined)).toBe("/profiles");
  });
});

describe("the sign-in landing", () => {
  it("a cancel goes back to sign-in, explained there, and leaves the address clean", async () => {
    const { router, container } = renderIdentity(
      "/login/continue?provider=google&context=signin&from=%2Flogin&redirect=%2Faccount&oidc=cancelled",
      "anonymous",
    );
    const notice = await screen.findByText("Google sign-in cancelled");
    await waitFor(() => expect(locationOf(router)).toBe("/login?redirect=%2Faccount"));
    expect(notice.closest("[role=status]")).toHaveFocus();
    await expectNoA11yViolations(container);
  });

  it("link-required asks the member to sign in first, naming the provider, not the address", async () => {
    renderIdentity("/login?oidc=link-required&provider=apple", "anonymous");
    const panel = (await screen.findByText("An account already uses this address")).closest(
      "[role=status]",
    ) as HTMLElement;
    expect(panel).toHaveTextContent("your Apple account");
    expect(panel.textContent).not.toMatch(/@/);
  });

  it("a new account is welcomed, named, and sent on to choose a plan", async () => {
    renderIdentity(
      "/login/continue?provider=google&context=signup&from=%2Fsignup&next=%2Fsignup&oidc=signed-up",
      "account",
    );
    const heading = await screen.findByRole("heading", { name: "Welcome to Webflix" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/Your account is ready/)).toHaveTextContent("demo@webflix.dev");
    expect(screen.getByRole("link", { name: "Choose your plan" })).toHaveAttribute(
      "href",
      "/signup",
    );
  });

  it("signed in with no profile yet: the sign-up funnel resumes", async () => {
    const { router } = renderIdentity(
      "/login/continue?provider=google&context=signin&from=%2Flogin&oidc=signed-in",
      "account",
      { state: (state) => (state.profiles = []) },
    );
    await waitFor(() => expect(locationOf(router)).toMatch(/^\/signup/));
  });
});

describe("Confirm it's you", () => {
  it("prompts when the server asks for a proof, takes the password, then does the action", async () => {
    const user = userEvent.setup();
    const unlink = vi.fn();
    renderIdentity("/account/security", "profile", {
      identity: { identities: linkedGoogle() },
      overrides: (base) => ({
        unlinkIdentity: (...args: Parameters<ApiClient["unlinkIdentity"]>) => {
          unlink();
          return base.unlinkIdentity(...args);
        },
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Unlink Google" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Unlink Google?" });
    expect(confirm).toHaveTextContent("won't reconnect on its own");
    await user.click(within(confirm).getByRole("button", { name: "Unlink Google" }));

    const prompt = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(prompt).toHaveTextContent("To unlink Google, confirm you're the account holder.");
    // Both ways the account has are offered.
    expect(within(prompt).getByRole("link", { name: "Use Google instead" })).toBeInTheDocument();
    await user.type(within(prompt).getByLabelText("Webflix password"), "not-it");
    await user.click(within(prompt).getByRole("button", { name: "Confirm" }));
    expect(await within(prompt).findByText(/isn't right/)).toBeInTheDocument();
    await user.type(within(prompt).getByLabelText("Webflix password"), "webflix-demo");
    await user.click(within(prompt).getByRole("button", { name: "Confirm" }));

    expect((await screen.findAllByText("Google is unlinked")).length).toBeGreaterThan(0);
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  it("with no way to confirm, leads the member to set a password by email", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    const { container } = renderIdentity("/account/security", "profile", {
      identity: {
        hasPassword: false,
        identities: linkedGoogle(),
        // A provider that does not report when the member last signed in (Google may not).
        issuersProveFreshness: false,
      },
      overrides: (base) => ({
        requestPasswordReset: (...args: Parameters<ApiClient["requestPasswordReset"]>) => {
          reset(args[0]?.body.email);
          return base.requestPasswordReset(...args);
        },
      }),
    });
    const form = await screen.findByRole("form", { name: "Set a password" });
    await user.type(within(form).getByLabelText("New password"), "a long new passphrase");
    await user.click(within(form).getByRole("button", { name: "Set password" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(await within(prompt).findByText("Set a password to continue")).toBeInTheDocument();
    expect(prompt).toHaveTextContent("signs you out on every device, this one too");
    await expectNoA11yViolations(container);
    await user.click(within(prompt).getByRole("button", { name: "Email me a link" }));
    expect(await within(prompt).findByText("Check your email")).toBeInTheDocument();
    expect(reset).toHaveBeenCalledWith("demo@webflix.dev");
  });

  it("dismissed, it changes nothing and reports nothing", async () => {
    const user = userEvent.setup();
    renderIdentity("/account/security", "profile", {
      identity: { hasPassword: false, identities: linkedGoogle() },
    });
    const form = await screen.findByRole("form", { name: "Set a password" });
    await user.type(within(form).getByLabelText("New password"), "a long new passphrase");
    await user.click(within(form).getByRole("button", { name: "Set password" }));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(prompt).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("emailed links", () => {
  it("an altered reset link gets the honest screen at once", async () => {
    renderIdentity("/reset-password#token=cut-short", "anonymous");
    expect(
      await screen.findByRole("heading", { name: "This link can't be used" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("a verification link verifies once, on opening", async () => {
    const confirm = vi.fn();
    renderIdentity(`/verify-email#token=${"a".repeat(43)}`, "anonymous", {
      overrides: (base) => ({
        confirmEmailVerification: (...args: Parameters<ApiClient["confirmEmailVerification"]>) => {
          confirm();
          return base.confirmEmailVerification(...args);
        },
      }),
    });
    // Opened signed out: verified, with no promise about providers (security review H1).
    expect(
      await screen.findByRole("heading", { name: "The email address is verified" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/sign in and add them in Account › Security/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reset its password" })).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("opened in its own account's session, it says Google or Apple can sign in too", async () => {
    renderIdentity(`/verify-email#token=${"c".repeat(43)}`, "account", {
      identity: { emailVerified: false },
    });
    expect(
      await screen.findByRole("heading", { name: "Your email is verified" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/you can now sign in with it as well/)).toBeInTheDocument();
  });

  it("opened in another, already verified account's session, it says so", async () => {
    renderIdentity(`/verify-email#token=${"d".repeat(43)}`, "account", {
      identity: { emailVerified: true },
    });
    expect(
      await screen.findByRole("heading", { name: "That email address is verified" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/different Webflix account/)).toBeInTheDocument();
    expect(screen.queryByText(/you can now sign in with it as well/)).toBeNull();
  });

  it("a reset signs this device in, says so, and goes where sign-in goes", async () => {
    const user = userEvent.setup();
    const { router } = renderIdentity(`/reset-password#token=${"b".repeat(43)}`, "anonymous");
    await user.type(
      await screen.findByLabelText("New password", { exact: true }),
      "a brand new passphrase",
    );
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    expect(
      (await screen.findAllByText("You're signed in here, and signed out everywhere else.")).length,
    ).toBeGreaterThan(0);
    await waitFor(() => expect(locationOf(router)).toMatch(/^\/profiles/));
  });
});

describe("link-required, the password way", () => {
  it("signing in offers the provider on Security, with the password as the proof", async () => {
    const user = userEvent.setup();
    const elevate = vi.fn();
    const { router } = renderIdentity("/login?oidc=link-required&provider=google", "anonymous", {
      overrides: (base) => ({
        elevate: (...args: Parameters<ApiClient["elevate"]>) => {
          elevate(args[0]?.body.password);
          return base.elevate(...args);
        },
      }),
    });
    expect(await screen.findByText("An account already uses this address")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email address"), "demo@webflix.dev");
    await user.type(screen.getByLabelText("Password", { exact: true }), "webflix-demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    // The account has profiles: Who's watching? first, saying what comes next.
    expect(
      await screen.findByText("Choose your profile, then add Google to your account."),
    ).toBeInTheDocument();
    expect(elevate).toHaveBeenCalledWith("webflix-demo");
    await user.click(screen.getByRole("button", { name: /^Mara/ }));
    const offer = await screen.findByRole("alertdialog", { name: "Add Google to your account?" });
    expect(offer).toHaveTextContent("You tried to sign in with Google");
    await waitFor(() => expect(locationOf(router)).toBe("/account/security"));
  });
});
