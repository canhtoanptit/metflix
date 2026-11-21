import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiError, createProblem, type PlaybackSession } from "@webflix/contracts";
import { makePlaybackSession } from "@webflix/contracts/fixtures";
import { toast } from "@webflix/ui";
import { expectNoA11yViolations } from "@webflix/ui/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app/App.tsx";
import { createAppRuntime } from "../src/app/bootstrap.ts";
import { clearDraft } from "../src/features/member/signup/draft.ts";
import { WatchLifecycle } from "../src/features/watch/lifecycle.ts";
import { titleId } from "../src/mocks/catalog.ts";
import { createMockApiClient } from "../src/mocks/client.ts";
import { MOCK_TITLES } from "../src/mocks/data/catalog.ts";
import { initialState, type MockState } from "../src/mocks/state.ts";
import { locationOf } from "./harness.tsx";

/**
 * The privilege rules in the real app over the in-browser mock API: proof asked for in place
 * (account password, a locked profile's PIN), kids and restricted profiles kept out of account
 * management, the demo account's fixed parts, and a profile locked on another device.
 * Seed: Mara (18+), Theo (18+, PIN 1234), Kids (kids, 7+); password `webflix-demo`.
 * The mock `state` is live: editing it plays another device changing the account.
 */
function renderMember(
  path: string,
  state: MockState,
  overrides: Partial<ApiClient> | ((base: ApiClient) => Partial<ApiClient>) = {},
) {
  const base = createMockApiClient({ state, settings: { latencyMs: 0, failing: [] } });
  const client = {
    ...base,
    ...(typeof overrides === "function" ? overrides(base) : overrides),
  } as ApiClient;
  const history = createMemoryHistory({ initialEntries: [path] });
  const runtime = createAppRuntime(client, { history });
  const view = render(<App queryClient={runtime.queryClient} router={runtime.router} />);
  return { ...view, ...runtime };
}

/** The seeded account, with `profileId` active on this device (null: at the gate). */
function seeded(profileId: string | null, edit: (state: MockState) => void = () => {}) {
  const state = initialState("account");
  state.activeProfileId = profileId;
  edit(state);
  return state;
}

function profileIn(state: MockState, id: string) {
  const profile = state.profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`no ${id} in the mock state`);
  return profile;
}

const problem = (code: "rate_limited" | "demo_account_protected" | "profile_required") =>
  new ApiError(
    code === "rate_limited"
      ? createProblem("rate_limited", { retryAfterSec: 45 })
      : createProblem(code),
  );

beforeEach(() => {
  clearDraft();
  sessionStorage.clear();
});

afterEach(() => {
  act(() => toast.reset());
});

describe("adding a profile", () => {
  it("asks for the account password in place while parental controls are in use", async () => {
    const user = userEvent.setup();
    const createProfile = vi.fn<ApiClient["createProfile"]>();
    const { router, container } = renderMember("/profiles/new", seeded(null), (base) => ({
      createProfile: async (input, options) => {
        createProfile(input, options);
        return base.createProfile(input, options);
      },
    }));
    expect(await screen.findByText(/Parental controls are on for this account/)).toBeVisible();
    await expectNoA11yViolations(container);
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Ana");
    await user.click(screen.getByRole("button", { name: "Add profile" }));

    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(createProfile).not.toHaveBeenCalled();
    await user.type(within(confirm).getByLabelText("Account password"), "wrong-password");
    await user.click(within(confirm).getByRole("button", { name: "Add profile" }));
    const field = within(confirm).getByLabelText("Account password");
    await waitFor(() => expect(field).toHaveAccessibleDescription(/isn't right/));
    await user.type(field, "webflix-demo");
    await user.click(within(confirm).getByRole("button", { name: "Add profile" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
    expect(createProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ name: "Ana", currentPassword: "webflix-demo" }),
      }),
      undefined,
    );
  });

  it("asks when the server says controls came on since the page loaded", async () => {
    const user = userEvent.setup();
    const { router } = renderMember("/profiles/new", seeded(null), (base) => ({
      // This page's view of the account: no parental controls (another device adds them).
      listProfiles: async (input, options) => ({
        ...(await base.listProfiles(input, options)),
        parentalControls: false,
      }),
    }));
    await user.type(await screen.findByRole("textbox", { name: /Name/ }), "Ana");
    expect(screen.queryByText(/Parental controls are on/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add profile" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm it's you" });
    // The refusal is the question, not an error.
    expect(within(confirm).queryByRole("alert")).toBeNull();
    await user.type(within(confirm).getByLabelText("Account password"), "webflix-demo");
    await user.click(within(confirm).getByRole("button", { name: "Add profile" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
  });

  it("sign-up never asks for the password, and its kids profiles end up kids profiles", async () => {
    const user = userEvent.setup();
    const state = seeded(null, (draft) => {
      draft.profiles = [];
    });
    const { router } = renderMember("/signup/profile", state);
    await user.type(await screen.findByLabelText("Your name"), "Sam");
    await user.type(screen.getByLabelText("Profile 2 name (optional)"), "Pip");
    await user.click(screen.getByRole("checkbox", { name: "Kids profile" }));
    await user.type(screen.getByLabelText("Profile 3 name (optional)"), "Ana");
    await user.click(screen.getByRole("button", { name: "Create 3 profiles" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse"), {
      timeout: 5000,
    });
    expect(state.profiles.map(({ name, isKids }) => ({ name, isKids }))).toEqual([
      { name: "Sam", isKids: false },
      { name: "Pip", isKids: true },
      { name: "Ana", isKids: false },
    ]);
  });
});

describe("a locked profile is its owner's", () => {
  it("editing it from another profile asks for its PIN; a wrong one is said in place", async () => {
    const user = userEvent.setup();
    const updateProfile = vi.fn<ApiClient["updateProfile"]>();
    const { router } = renderMember(
      "/profiles/profile-theo/edit",
      seeded("profile-mara"),
      (base) => ({
        updateProfile: async (input, options) => {
          updateProfile(input, options);
          return base.updateProfile(input, options);
        },
      }),
    );
    expect(await screen.findByText(/Theo is locked\. You'll be asked/)).toBeVisible();
    const name = screen.getByRole("textbox", { name: /Name/ });
    await user.clear(name);
    await user.type(name, "Teddy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.keyboard("0000");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Incorrect PIN");
    await waitFor(() => expect(within(dialog).getByLabelText("Digit 1 of 4")).toHaveFocus());
    expect(within(dialog).getByRole("group", { name: "PIN for Theo" })).toHaveAccessibleDescription(
      "Incorrect PIN. Please try again.",
    );
    await expectNoA11yViolations(dialog);
    await user.keyboard("1234");
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
    expect(updateProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { name: "Teddy", currentPin: "1234" } }),
      undefined,
    );
  });

  it("deleting it from the gate takes the account password instead of the PIN", async () => {
    const user = userEvent.setup();
    const state = seeded(null);
    const { router } = renderMember("/profiles/profile-theo/edit", state);
    await user.click(await screen.findByRole("button", { name: "Delete profile" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete Theo?" });
    await user.click(within(confirm).getByRole("button", { name: "Delete profile" }));

    const unlock = await screen.findByRole("dialog", { name: "Delete Theo?" });
    await user.click(
      within(unlock).getByRole("button", { name: "Use the account password instead" }),
    );
    await user.type(within(unlock).getByLabelText("Account password"), "webflix-demo");
    await user.click(within(unlock).getByRole("button", { name: "Delete profile" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
    expect(state.profiles.some((profile) => profile.id === "profile-theo")).toBe(false);
  });

  it("a profile locked elsewhere since the page loaded asks for its PIN on the first refusal", async () => {
    const user = userEvent.setup();
    const state = seeded("profile-mara", (draft) => {
      profileIn(draft, "profile-theo").pin = null;
    });
    const { router } = renderMember("/profiles/profile-theo/edit", state);
    const name = await screen.findByRole("textbox", { name: /Name/ });
    profileIn(state, "profile-theo").pin = "4321";
    await user.clear(name);
    await user.type(name, "Teddy");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.keyboard("4321");
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
    expect(profileIn(state, "profile-theo").name).toBe("Teddy");
  });

  it("rate-limited PIN checks show the timer and lock the boxes", async () => {
    const user = userEvent.setup();
    renderMember("/profiles/profile-theo/edit", seeded(null), {
      updateProfile: async () => {
        throw problem("rate_limited");
      },
    });
    const name = await screen.findByRole("textbox", { name: /Name/ });
    await user.type(name, "y");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.keyboard("1111");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /Too many attempts.*try again in 0:4[45]/i,
    );
    expect(within(dialog).getByLabelText("Digit 1 of 4")).toBeDisabled();
  });
});

describe("kids profiles manage nothing", () => {
  it("are sent from profile management to Who's watching?, which offers only other profiles", async () => {
    const { router } = renderMember("/profiles/manage", seeded("profile-kids"));
    await waitFor(() => expect(locationOf(router)).toBe("/profiles"));
    expect(await screen.findByRole("heading", { name: "Who's watching?" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Mara/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Manage profiles" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Add profile" })).toBeNull();
  });

  it("forgot PIN still works from Who's watching? after leaving Kids", async () => {
    const user = userEvent.setup();
    const state = seeded("profile-kids");
    const { router } = renderMember("/profiles", state);
    await user.click(await screen.findByRole("button", { name: /^Theo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    await user.click(within(dialog).getByRole("button", { name: "Forgot PIN?" }));
    const reset = await screen.findByRole("dialog", { name: "Remove profile lock" });
    await user.type(within(reset).getByLabelText("Account password"), "webflix-demo");
    await user.click(within(reset).getByRole("button", { name: "Remove lock" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse"));
    expect(state.activeProfileId).toBe("profile-theo");
    expect(profileIn(state, "profile-theo").pin).toBeNull();
  });
});

describe("account pages", () => {
  it("at the gate, ask for a profile first and come back after choosing it", async () => {
    const user = userEvent.setup();
    const { router } = renderMember("/account/devices", seeded(null));
    await waitFor(() => expect(locationOf(router)).toBe("/profiles?redirect=%2Faccount%2Fdevices"));
    expect(
      await screen.findByText("Choose your profile to continue to your account."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Mara/ }));
    await waitFor(() => expect(locationOf(router)).toBe("/account/devices"));
    expect(await screen.findByRole("heading", { name: "Devices" })).toBeVisible();
  });

  it("from a kids profile, offer a switch instead of forms that fail", async () => {
    const getAccount = vi.fn();
    const { container } = renderMember("/account/plan", seeded("profile-kids"), { getAccount });
    const heading = await screen.findByRole("heading", {
      name: "Account settings are available from a profile without parental controls",
    });
    expect(heading).toBeVisible();
    expect(screen.getByText(/Kids is a kids profile\./)).toBeVisible();
    expect(screen.getByRole("link", { name: "Switch profile" })).toHaveAttribute(
      "href",
      "/profiles?redirect=%2Faccount%2Fplan",
    );
    expect(screen.queryByRole("navigation", { name: "Account" })).toBeNull();
    expect(getAccount).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("from a restricted profile, say why", async () => {
    renderMember(
      "/account",
      seeded("profile-mara", (state) => {
        profileIn(state, "profile-mara").maturityCeiling = "13+";
      }),
    );
    expect(
      await screen.findByText(/Mara's profile has a maturity limit \(13\+ · Teens\)\./),
    ).toBeVisible();
  });

  it("a ceiling lowered on another device turns the next refusal into the same panel", async () => {
    const user = userEvent.setup();
    const state = seeded("profile-mara");
    renderMember("/account/devices", state);
    await user.click(await screen.findByRole("button", { name: "Sign out Living room TV" }));
    profileIn(state, "profile-mara").maturityCeiling = "16+";
    const confirm = await screen.findByRole("alertdialog", { name: "Sign out Living room TV?" });
    await user.click(within(confirm).getByRole("button", { name: "Sign out device" }));
    expect(
      await screen.findByText(/Mara's profile has a maturity limit \(16\+ · Older teens\)\./),
    ).toBeVisible();
  });

  it("a profile signed off on another device goes to Who's watching? and comes back", async () => {
    const user = userEvent.setup();
    const state = seeded("profile-mara");
    const { router } = renderMember("/account/devices", state);
    await user.click(await screen.findByRole("button", { name: "Sign out Living room TV" }));
    state.activeProfileId = null;
    const confirm = await screen.findByRole("alertdialog", { name: "Sign out Living room TV?" });
    await user.click(within(confirm).getByRole("button", { name: "Sign out device" }));
    await waitFor(() => expect(locationOf(router)).toBe("/profiles?redirect=%2Faccount%2Fdevices"));
  });

  it("explain a demo-account refusal in plain words", async () => {
    const user = userEvent.setup();
    renderMember("/account/cancel", seeded("profile-mara"), {
      cancelMembership: async () => {
        throw problem("demo_account_protected");
      },
    });
    await user.click(await screen.findByRole("button", { name: "Finish cancellation" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't cancel your membership");
    expect(alert).toHaveTextContent(/Everyone who tries Webflix shares this account/);
  });
});

describe("the demo account", () => {
  const demo = () =>
    seeded("profile-mara", (state) => {
      state.account.isDemo = true;
    });

  it("says once on the overview what stays fixed, and offers none of it", async () => {
    renderMember("/account", demo());
    expect(await screen.findByText("This is the shared demo account")).toBeVisible();
    expect(await screen.findByText(/Visa •••• 4242/)).toBeVisible();
    for (const name of ["Change plan", "Cancel membership", "Update"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Update payment method" })).toBeNull();
  });

  it("hides sign-in changes", async () => {
    renderMember("/account/security", demo());
    expect(
      await screen.findByText("The demo account's sign-in details can't be changed"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Update email" })).toBeNull();
  });

  it("signs out this device only", async () => {
    renderMember("/account/devices", demo());
    expect(await screen.findAllByText("Living room TV")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Sign out Living room TV" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out of all devices" })).toBeNull();
  });

  it("offers no new profiles and no lock removal on Who's watching?", async () => {
    const user = userEvent.setup();
    renderMember(
      "/profiles",
      seeded(null, (state) => {
        state.account.isDemo = true;
      }),
    );
    await user.click(await screen.findByRole("button", { name: /^Theo/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    expect(within(dialog).queryByRole("button", { name: "Forgot PIN?" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Add profile" })).toBeNull();
  });

  it("keeps profiles' shape but saves their playback settings", async () => {
    const user = userEvent.setup();
    const state = demo();
    const { router } = renderMember("/profiles/profile-mara/edit", state);
    expect(await screen.findByText("This is the shared demo account")).toBeVisible();
    expect(screen.getByRole("textbox", { name: /Name/ })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Kids profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Autoplay previews" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/profiles/manage"));
    expect(profileIn(state, "profile-mara").settings.autoplayPreviews).toBe(false);
    expect(screen.queryByRole("link", { name: "Add profile" })).toBeNull();
  });
});

describe("a profile locked on another device", () => {
  it("browse lands on Who's watching? with a word on why, and the PIN gets back in", async () => {
    const user = userEvent.setup();
    const state = seeded("profile-mara");
    const { router } = renderMember("/browse", state);
    await screen.findByRole("region", { name: /Continue Watching for Mara/ }, { timeout: 5000 });

    // Another device sets a PIN on Mara: the server signs this device off the profile.
    profileIn(state, "profile-mara").pin = "4321";
    state.activeProfileId = null;
    await act(() => router.navigate({ to: "/my-list" }));

    await waitFor(() => expect(locationOf(router)).toBe("/profiles?redirect=%2Fmy-list"));
    expect(await screen.findByText("Choose a profile to continue")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: /^Mara/ }));
    const dialog = await screen.findByRole("dialog", { name: "Profile lock is on" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.keyboard("4321");
    await waitFor(() => expect(locationOf(router)).toBe("/my-list"));
  });

  it("playback stops on the designed screen, naming what happened", async () => {
    const id = MOCK_TITLES[0] ? titleId(MOCK_TITLES[0]) : "";
    renderMember(`/watch/${id}`, seeded("profile-mara"), {
      createPlaybackSession: async () => {
        throw problem("profile_required");
      },
    });
    expect(
      await screen.findByRole(
        "heading",
        { name: "This profile was locked on another device" },
        { timeout: 5000 },
      ),
    ).toBeVisible();
    expect(screen.getByText(/Someone added or changed Mara's PIN/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Choose a profile" })).toHaveAttribute(
      "href",
      `/profiles?redirect=${encodeURIComponent(`/watch/${id}`)}`,
    );
  });

  it("a heartbeat answered with profile_required blocks playback and stops reporting", async () => {
    const playing: PlaybackSession = { ...makePlaybackSession(), id: "ps-locked" };
    const sendHeartbeat = vi.fn(async () => {
      throw problem("profile_required");
    });
    const lifecycle = new WatchLifecycle({
      api: {
        createPlaybackSession: async () => playing,
        sendHeartbeat,
        endPlaybackSession: async () => undefined,
      } as unknown as ConstructorParameters<typeof WatchLifecycle>[0]["api"],
    });
    await lifecycle.open({ titleId: playing.titleId });
    const sample = {
      sessionId: playing.id,
      positionSec: 300,
      durationSec: 1800,
      state: "playing",
      reason: "interval",
    } as const;
    await lifecycle.report(sample);
    expect(lifecycle.getState()).toMatchObject({
      status: "blocked",
      block: { kind: "profile-required" },
    });
    await lifecycle.report({ ...sample, positionSec: 330 });
    expect(sendHeartbeat).toHaveBeenCalledTimes(1);
  });
});
