/**
 * Who may do what (docs/BACKEND.md, "Privileges"): parental controls cannot be undone from a
 * kids profile or the gate without the account password or the locked profile's PIN; account
 * management needs a profile without parental controls; every PIN or password check after
 * sign-in shares one per-account budget, charged before any hashing.
 */
import { ApiError, type RouteInput, type Routes } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  APPROVED_CARD,
  createTestApp,
  DEMO,
  type Device,
  onboard,
  signIn,
  type TestApp,
} from "./support.ts";

const PASSWORD = "correct horse battery";

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (ApiError.is(error) ? error.code : String(error)),
  );
}

/**
 * A household with parental controls: the parent's profile ("Me", selected on `parent`), a
 * kids profile (selected on `kid`, another device) and a PIN-locked adult profile.
 */
async function household(t: TestApp, email = "family@example.com") {
  const { device: parent, profileId: parentId } = await onboard(t, { email });
  // No controls yet: the kids profile is added without the password.
  const kids = await parent.api.createProfile({
    body: { name: "Kids", avatarId: "av-robot", isKids: true },
  });
  const locked = await parent.api.createProfile({
    body: { name: "Private", avatarId: "av-owl", currentPassword: PASSWORD },
  });
  await parent.api.updateProfile({
    params: { id: locked.id },
    body: { pin: "1234", currentPassword: PASSWORD },
  });
  const kid = await signIn(t, email, PASSWORD, "Kid tablet", kids.id);
  // Setting up checked the password twice: each test starts from a full credential budget.
  t.clock.advance(120_000);
  return { parent, parentId, kidsId: kids.id, lockedId: locked.id, kid };
}

/** Every account-management call, with a valid body (each must be refused before it acts). */
function accountCalls(device: Device): Array<[string, () => Promise<unknown>]> {
  const api = device.api;
  return [
    ["GET /account", () => api.getAccount()],
    [
      "PATCH /account",
      () => api.updateAccount({ body: { currentPassword: PASSWORD, email: "new@example.com" } }),
    ],
    ["PUT /account/subscription", () => api.changePlan({ body: { planId: "premium" } })],
    ["DELETE /account/subscription", () => api.cancelMembership()],
    ["POST /account/subscription/resume", () => api.resumeMembership()],
    [
      "PUT /account/payment-method",
      () => api.updatePaymentMethod({ body: { payment: APPROVED_CARD } }),
    ],
    ["GET /account/sessions", () => api.listDevices()],
    ["DELETE /account/sessions/:id", () => api.revokeDevice({ params: { id: "ses-other" } })],
    ["POST /auth/logout-all", () => api.logoutAll()],
  ];
}

describe("a kids-profile session", () => {
  it("cannot undo parental controls: no new profile, no edits to others, no deletes", async () => {
    const t = await createTestApp();
    const { kid, parentId, lockedId, kidsId } = await household(t);
    // The reviewer's path: an unrestricted profile created from the kids profile.
    expect(
      await codeOf(
        kid.api.createProfile({
          body: { name: "Free", avatarId: "av-fox", maturityCeiling: "18+" },
        }),
      ),
    ).toBe("unrestricted_profile_required");
    // Not even with the password: from a kids profile, only switching is possible.
    expect(
      await codeOf(
        kid.api.createProfile({
          body: { name: "Free", avatarId: "av-fox", currentPassword: PASSWORD },
        }),
      ),
    ).toBe("unrestricted_profile_required");
    expect(await codeOf(kid.api.deleteProfile({ params: { id: lockedId } }))).toBe(
      "unrestricted_profile_required",
    );
    expect(await codeOf(kid.api.deleteProfile({ params: { id: parentId } }))).toBe(
      "unrestricted_profile_required",
    );
    expect(
      await codeOf(kid.api.updateProfile({ params: { id: parentId }, body: { name: "Mine" } })),
    ).toBe("unrestricted_profile_required");
    expect(
      await codeOf(
        kid.api.updateProfile({
          params: { id: kidsId },
          body: { isKids: false, maturityCeiling: "18+", currentPassword: PASSWORD },
        }),
      ),
    ).toBe("unrestricted_profile_required");
    // Its own name, avatar and settings remain its own.
    const renamed = await kid.api.updateProfile({
      params: { id: kidsId },
      body: { name: "Robo", avatarId: "av-fox", settings: { autoplayPreviews: false } },
    });
    expect(renamed).toMatchObject({ name: "Robo", isKids: true, maturityCeiling: "7+" });
    const profiles = await kid.api.listProfiles();
    expect(profiles.items).toHaveLength(3);
    expect(profiles.parentalControls).toBe(true);
  });

  it("cannot manage the account; it can switch profile and sign out", async () => {
    const t = await createTestApp();
    const { kid, parentId, lockedId } = await household(t);
    for (const [name, call] of accountCalls(kid)) {
      expect(await codeOf(call()), name).toBe("unrestricted_profile_required");
    }
    expect(await codeOf(kid.api.selectProfile({ body: { profileId: lockedId } }))).toBe(
      "profile_pin_required",
    );
    await kid.api.selectProfile({ body: { profileId: parentId } });
    await kid.api.logout();
    expect((await kid.api.getSession()).authenticated).toBe(false);
  });
});

describe("the gate and restricted profiles", () => {
  it("needs the password to add a profile while controls are in use", async () => {
    const t = await createTestApp();
    const { parent } = await household(t);
    await parent.api.clearProfile();
    const body: RouteInput<Routes["createProfile"]>["body"] = { name: "Guest", avatarId: "av-fox" };
    expect(await codeOf(parent.api.createProfile({ body }))).toBe("password_required");
    expect(
      await codeOf(parent.api.createProfile({ body: { ...body, currentPassword: "not-it-1" } })),
    ).toBe("current_password_invalid");
    const created = await parent.api.createProfile({
      body: { ...body, currentPassword: PASSWORD },
    });
    expect(created.maturityCeiling).toBe("18+");
  });

  it("needs a locked profile's PIN or the password to change or delete it", async () => {
    const t = await createTestApp();
    const { parent, lockedId } = await household(t);
    await parent.api.clearProfile();
    const rename = (extra: { currentPin?: string; currentPassword?: string } = {}) =>
      parent.api.updateProfile({ params: { id: lockedId }, body: { name: "Renamed", ...extra } });
    expect(await codeOf(rename())).toBe("profile_unlock_required");
    expect(await codeOf(rename({ currentPin: "0000" }))).toBe("profile_pin_invalid");
    expect((await rename({ currentPin: "1234" })).name).toBe("Renamed");
    expect((await rename({ currentPassword: PASSWORD })).name).toBe("Renamed");
    // Lowering its ceiling is a restriction, but the profile is still its owner's.
    expect(
      await codeOf(
        parent.api.updateProfile({ params: { id: lockedId }, body: { maturityCeiling: "7+" } }),
      ),
    ).toBe("profile_unlock_required");
    expect(await codeOf(parent.api.deleteProfile({ params: { id: lockedId } }))).toBe(
      "profile_unlock_required",
    );
    expect(
      await codeOf(
        parent.api.deleteProfile({ params: { id: lockedId }, body: { currentPin: "9" } }),
      ),
    ).toBe("validation_failed");
    await parent.api.deleteProfile({ params: { id: lockedId }, body: { currentPin: "1234" } });
    expect((await parent.api.listProfiles()).items).toHaveLength(2);
  });

  it("needs the password to loosen a profile, from any session", async () => {
    const t = await createTestApp();
    const { parent, kidsId } = await household(t);
    const loosen = (extra: { currentPassword?: string } = {}) =>
      parent.api.updateProfile({
        params: { id: kidsId },
        body: { isKids: false, maturityCeiling: "18+", ...extra },
      });
    expect(await codeOf(loosen())).toBe("password_required");
    expect(await codeOf(loosen({ currentPassword: "wrong-one" }))).toBe("current_password_invalid");
    expect((await loosen({ currentPassword: PASSWORD })).maturityCeiling).toBe("18+");
  });

  it("refuses account management at the gate and from a restricted profile", async () => {
    const t = await createTestApp();
    const { parent } = await household(t);
    const teen = await parent.api.createProfile({
      body: { name: "Teen", avatarId: "av-owl", maturityCeiling: "13+", currentPassword: PASSWORD },
    });
    await parent.api.clearProfile();
    for (const [name, call] of accountCalls(parent)) {
      expect(await codeOf(call()), `${name} at the gate`).toBe("profile_required");
    }
    await parent.api.selectProfile({ body: { profileId: teen.id } });
    for (const [name, call] of accountCalls(parent)) {
      expect(await codeOf(call()), `${name} from a 13+ profile`).toBe(
        "unrestricted_profile_required",
      );
    }
  });

  it("lets a locked profile's own session change and delete it without its PIN again", async () => {
    const t = await createTestApp();
    const { lockedId } = await household(t);
    const owner = await signIn(t, "family@example.com", PASSWORD, "Owner laptop");
    await owner.api.selectProfile({ body: { profileId: lockedId, pin: "1234" } });
    const renamed = await owner.api.updateProfile({
      params: { id: lockedId },
      body: { name: "Mine", settings: { autoplayNextEpisode: false } },
    });
    expect(renamed).toMatchObject({ name: "Mine", isLocked: true });
    // Changing its own PIN is still a password matter.
    expect(
      await codeOf(owner.api.updateProfile({ params: { id: lockedId }, body: { pin: "4321" } })),
    ).toBe("password_required");
    await owner.api.deleteProfile({ params: { id: lockedId } });
  });
});

describe("a household without parental controls", () => {
  it("adds profiles without the password, and its profiles manage the account", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "flat@example.com" });
    expect((await device.api.listProfiles()).parentalControls).toBe(false);
    await device.api.createProfile({ body: { name: "Partner", avatarId: "av-owl" } });
    expect((await device.api.getAccount()).account.email).toBe("flat@example.com");
    await device.api.changePlan({ body: { planId: "premium" } });
  });
});

describe("credential checks after sign-in", () => {
  it("share one per-account budget across routes, charged before any hashing", async () => {
    const t = await createTestApp({ config: { WEBFLIX_RATE_LIMIT_PROFILE_PIN: "5/60" } });
    const { parent, kidsId, lockedId } = await household(t);
    const hasher = t.deps.passwords;
    const verify = hasher.verify.bind(hasher);
    let verifications = 0;
    hasher.verify = async (password, encoded) => {
      verifications += 1;
      return verify(password, encoded);
    };
    const guesses: Array<() => Promise<unknown>> = [
      () => parent.api.selectProfile({ body: { profileId: lockedId, pin: "0000" } }),
      () =>
        parent.api.updateProfile({
          params: { id: kidsId },
          body: { isKids: false, currentPassword: "guess-1" },
        }),
      () =>
        parent.api.createProfile({
          body: { name: "X", avatarId: "av-fox", currentPassword: "guess-2" },
        }),
      () => parent.api.deleteProfile({ params: { id: lockedId }, body: { currentPin: "0001" } }),
      () =>
        parent.api.updateAccount({ body: { currentPassword: "guess-3", email: "e@example.com" } }),
    ];
    for (const guess of guesses) expect(await codeOf(guess())).not.toBe("rate_limited");
    expect(verifications).toBe(5);
    // The budget is spent: every route now refuses before hashing, even with the right secret.
    for (const guess of guesses) expect(await codeOf(guess())).toBe("rate_limited");
    expect(
      await codeOf(
        parent.api.updateProfile({
          params: { id: kidsId },
          body: { isKids: false, currentPassword: PASSWORD },
        }),
      ),
    ).toBe("rate_limited");
    expect(verifications).toBe(5);
  });

  it("stops the password oracle: 25 wrong guesses, limited after the fifth", async () => {
    const t = await createTestApp({ config: { WEBFLIX_RATE_LIMIT_PROFILE_PIN: "5/60" } });
    const { parent, kidsId } = await household(t);
    const codes: string[] = [];
    for (let guess = 0; guess < 25; guess += 1) {
      codes.push(
        (await codeOf(
          parent.api.updateProfile({
            params: { id: kidsId },
            body: { isKids: false, maturityCeiling: "18+", currentPassword: `guess-${guess}` },
          }),
        )) ?? "ok",
      );
    }
    expect(codes.slice(0, 5)).toEqual(Array(5).fill("current_password_invalid"));
    expect(codes.slice(5)).toEqual(Array(20).fill("rate_limited"));
  });
});

describe("the shared demo account", () => {
  it("keeps its sign-in details, membership and profiles; settings and switching still work", async () => {
    const t = await createTestApp();
    const demo = await signIn(t, DEMO.email, DEMO.password, "Visitor", "pr-demo");
    const other = await signIn(t, DEMO.email, DEMO.password, "Other visitor", "pr-demo");
    const otherSession = (await other.api.listDevices()).items.find((item) => item.current)?.id;
    const refused: Array<[string, () => Promise<unknown>]> = [
      [
        "email",
        () =>
          demo.api.updateAccount({
            body: { currentPassword: DEMO.password, email: "mine@example.com" },
          }),
      ],
      [
        "password",
        () =>
          demo.api.updateAccount({
            body: { currentPassword: DEMO.password, newPassword: "taken-over-1" },
          }),
      ],
      ["plan", () => demo.api.changePlan({ body: { planId: "basic" } })],
      ["cancel", () => demo.api.cancelMembership()],
      ["card", () => demo.api.updatePaymentMethod({ body: { payment: APPROVED_CARD } })],
      ["sign out everywhere", () => demo.api.logoutAll()],
      ["revoke", () => demo.api.revokeDevice({ params: { id: otherSession ?? "x" } })],
      ["add profile", () => demo.api.createProfile({ body: { name: "X", avatarId: "av-fox" } })],
      ["delete profile", () => demo.api.deleteProfile({ params: { id: "pr-kids" }, body: {} })],
      [
        "lock",
        () =>
          demo.api.updateProfile({
            params: { id: "pr-demo" },
            body: { pin: "1111", currentPassword: DEMO.password },
          }),
      ],
      ["rename", () => demo.api.updateProfile({ params: { id: "pr-demo" }, body: { name: "X" } })],
    ];
    for (const [name, call] of refused) {
      expect(await codeOf(call()), name).toBe("demo_account_protected");
    }
    const tuned = await demo.api.updateProfile({
      params: { id: "pr-demo" },
      body: { settings: { subtitleLanguage: "en" } },
    });
    expect(tuned.settings.subtitleLanguage).toBe("en");
    expect((await demo.api.getAccount()).account.isDemo).toBe(true);
    expect((await other.api.getSession()).authenticated).toBe(true);
    await demo.api.selectProfile({ body: { profileId: "pr-kids" } });
  });
});
