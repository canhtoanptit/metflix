import { describe, expect, it } from "vitest";
import { createTestServices, subscribeForTest } from "../../src/testing/index.ts";
import {
  authOf,
  DEMO_ACCOUNT,
  demoViewer,
  MEMBER_PASSWORD,
  memberDevice,
  memberViewer,
  openLogin,
  uncharged,
} from "./helpers.ts";

const client = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile Safari/604.1" };

describe("auth", () => {
  it("signs up without a membership; only a provider checkout makes the account a member", async () => {
    const t = await createTestServices();
    expect(await t.services.auth.emailStatus("new@example.com")).toEqual({ next: "signup" });
    const issued = await t.services.auth.signup(
      { email: "new@example.com", password: "long-enough" },
      client,
    );
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // No membership is exactly that: no stand-in subscription or plan.
    expect(issued.state).toMatchObject({
      authenticated: true,
      account: { email: "new@example.com" },
      subscription: null,
      plan: null,
      profiles: [],
      activeProfile: null,
      membership: { status: "none", planId: null },
      entitlement: { entitled: false, reason: "no_membership" },
    });
    const auth = await authOf(t, issued.token);
    expect(auth.session.deviceLabel).toBe("Safari on iPhone");
    expect(auth.session.deviceType).toBe("mobile");
    expect(await t.services.auth.emailStatus("new@example.com")).toEqual({ next: "login" });
    const before = await t.services.account.getAccount(auth.session.accountId);
    expect(before).toMatchObject({ subscription: null, plan: null, paymentMethod: null });

    await subscribeForTest(t, auth, { plan: "standard" });
    const details = await t.services.account.getAccount(auth.session.accountId);
    expect(details).toMatchObject({
      subscription: { planId: "standard", status: "active" },
      plan: { id: "standard", maxStreams: 2 },
      paymentMethod: { brand: "visa", last4: "4242" },
      membership: { status: "trialing" },
    });
  });

  it("refuses a second account for the same email", async () => {
    const t = await createTestServices();
    await expect(
      t.services.auth.signup({ email: "demo@webflix.dev", password: "long-enough" }, client),
    ).rejects.toMatchObject({ code: "email_already_registered" });
  });

  it("logs in, rejects bad credentials alike and honours remember-me", async () => {
    const t = await createTestServices();
    const ok = await t.services.auth.login(
      { email: "demo@webflix.dev", password: "webflix-demo" },
      client,
      openLogin,
    );
    expect(ok.maxAgeSec).toBe(t.deps.config.session.ttlSec);
    expect(ok.state.profiles.map((profile) => profile.id)).toEqual([
      "pr-demo",
      "pr-kids",
      "pr-locked",
    ]);
    expect(ok.state.profiles.find((profile) => profile.id === "pr-locked")?.isLocked).toBe(true);

    const short = await t.services.auth.login(
      { email: "demo@webflix.dev", password: "webflix-demo", rememberMe: false },
      client,
      openLogin,
    );
    expect(short.maxAgeSec).toBeNull();
    expect((await authOf(t, short.token)).session.persistent).toBe(false);

    for (const body of [
      { email: "demo@webflix.dev", password: "wrong-password" },
      { email: "nobody@webflix.dev", password: "webflix-demo" },
    ]) {
      await expect(t.services.auth.login(body, client, openLogin)).rejects.toMatchObject({
        code: "invalid_credentials",
      });
    }
  });

  it("expires sessions and records activity at most every five minutes", async () => {
    const t = await createTestServices();
    const issued = await t.services.auth.login(
      { email: "demo@webflix.dev", password: "webflix-demo" },
      client,
      openLogin,
    );
    const first = await authOf(t, issued.token);
    t.clock.advance(60_000);
    expect((await authOf(t, issued.token)).session.lastSeenAt).toBe(first.session.lastSeenAt);
    t.clock.advance(5 * 60_000);
    expect((await authOf(t, issued.token)).session.lastSeenAt).toBe(t.clock.now());
    expect(await t.services.auth.authenticate("not-a-token")).toBeNull();
    expect(await t.services.auth.authenticate("A".repeat(43))).toBeNull();
    t.clock.advance(t.deps.config.session.ttlSec * 1000);
    expect(await t.services.auth.authenticate(issued.token)).toBeNull();
  });

  it("guards locked profiles with their PIN", async () => {
    const t = await createTestServices();
    const issued = await t.services.auth.login(
      { email: "demo@webflix.dev", password: "webflix-demo" },
      client,
      openLogin,
    );
    const auth = await authOf(t, issued.token);
    let charged = 0;
    const charge = async () => {
      charged += 1;
    };
    await expect(
      t.services.auth.selectProfile(auth, { profileId: "pr-locked" }, charge),
    ).rejects.toMatchObject({
      code: "profile_pin_required",
    });
    await expect(
      t.services.auth.selectProfile(auth, { profileId: "pr-locked", pin: "0000" }, charge),
    ).rejects.toMatchObject({ code: "profile_pin_invalid" });
    const state = await t.services.auth.selectProfile(
      auth,
      { profileId: "pr-locked", pin: "1234" },
      charge,
    );
    expect(state.activeProfile?.id).toBe("pr-locked");
    expect((await authOf(t, issued.token)).profile?.id).toBe("pr-locked");
    await expect(
      t.services.auth.selectProfile(auth, { profileId: "pr-other" }, charge),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    // Only the two submitted PINs were credential checks.
    await t.services.auth.selectProfile(auth, { profileId: "pr-kids" }, charge);
    expect(charged).toBe(2);
    const cleared = await t.services.auth.clearProfile(auth);
    expect(cleared.activeProfile).toBeNull();
  });

  it("signs out one device or all of them, ending their streams", async () => {
    const t = await createTestServices();
    const one = await memberViewer(t);
    const two = await memberDevice(t, "member@example.com", one.profile.id);
    const three = await memberDevice(t, "member@example.com", one.profile.id);
    const accountId = one.session.accountId;
    await t.services.playback.start(one, { titleId: "t-orbit" });
    await t.services.playback.start(two, { titleId: "t-orbit" });
    expect(await t.gate.list(accountId)).toHaveLength(2);

    await t.services.auth.logout(await authOf(t, one.token));
    expect(await t.services.auth.authenticate(one.token)).toBeNull();
    expect(await t.gate.list(accountId)).toHaveLength(1);

    await t.services.auth.logoutAll(await authOf(t, three.token));
    expect(await t.services.auth.authenticate(two.token)).toBeNull();
    expect(await t.services.auth.authenticate(three.token)).toBeNull();
    expect(await t.gate.list(accountId)).toHaveLength(0);
  });

  it("never signs every visitor out of the shared demo account", async () => {
    const t = await createTestServices();
    const one = await demoViewer(t);
    const two = await demoViewer(t);
    await expect(t.services.auth.logoutAll(await authOf(t, one.token))).rejects.toMatchObject({
      code: "demo_account_protected",
    });
    await expect(
      t.services.account.revokeDevice(await authOf(t, one.token), two.session.id),
    ).rejects.toMatchObject({ code: "demo_account_protected" });
    // Signing this device out stays possible.
    await t.services.account.revokeDevice(await authOf(t, one.token), one.session.id);
    expect(await t.services.auth.authenticate(one.token)).toBeNull();
    expect(await t.services.auth.authenticate(two.token)).not.toBeNull();
  });
});

describe("account and membership", () => {
  /** An account with milestone 1's simulated membership (as the demo account has). */
  async function simulatedMember() {
    const t = await createTestServices();
    const now = t.clock.now();
    const accountId = "acc-m1";
    await t.deps.repos.accounts.createWithSession({
      account: {
        id: accountId,
        email: "m1@example.com",
        passwordHash: "x",
        createdAt: now,
        updatedAt: now,
      },
      subscription: {
        accountId,
        planId: "basic",
        startedAt: now,
        currentPeriodEnd: now + 30 * 24 * 3600_000,
        canceledAt: null,
        card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2031 },
        updatedAt: now,
      },
      session: {
        id: "ses-m1",
        tokenHash: "hash-m1",
        accountId,
        activeProfileId: null,
        deviceLabel: "Test",
        deviceType: "desktop",
        persistent: true,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 3600_000,
      },
    });
    return { t, accountId };
  }

  it("charges nothing for milestone 1's simulated membership: no plan change, no restart", async () => {
    const { t, accountId } = await simulatedMember();
    await expect(
      t.services.account.changePlan(accountId, { planId: "premium" }),
    ).rejects.toMatchObject({ code: "checkout_state_conflict" });
    expect((await t.services.account.getAccount(accountId)).plan?.id).toBe("basic");

    const canceled = await t.services.account.cancel(accountId);
    expect(canceled.subscription.status).toBe("canceling");
    expect(canceled.subscription.canceledAt).not.toBeNull();
    const resumed = await t.services.account.resume(accountId);
    expect(resumed.subscription).toMatchObject({ status: "active", canceledAt: null });

    await t.services.account.cancel(accountId);
    t.clock.advance(31 * 24 * 3600_000);
    expect((await t.services.account.getAccount(accountId)).subscription?.status).toBe("ended");
    await expect(t.services.account.resume(accountId)).rejects.toMatchObject({
      code: "checkout_state_conflict",
    });
  });

  it("renews milestone 1's simulated membership by itself", async () => {
    const { t, accountId } = await simulatedMember();
    t.clock.advance(95 * 24 * 3600_000);
    const { subscription } = await t.services.account.getAccount(accountId);
    expect(subscription?.status).toBe("active");
    expect(Date.parse(subscription?.currentPeriodEnd ?? "")).toBeGreaterThan(t.clock.now());
  });

  it("leaves a provider membership to billing", async () => {
    const t = await createTestServices();
    const viewer = await memberViewer(t);
    await expect(
      t.services.account.changePlan(viewer.session.accountId, { planId: "premium" }),
    ).rejects.toMatchObject({ code: "checkout_state_conflict" });
  });

  it("changes email and password with the current password; a new password signs out other devices", async () => {
    const t = await createTestServices();
    const viewer = await memberViewer(t);
    const other = await memberDevice(t, "member@example.com", viewer.profile.id);
    await t.services.playback.start(other, { titleId: "t-orbit" });
    const auth = await authOf(t, viewer.token);
    let charged = 0;
    const charge = async () => {
      charged += 1;
    };

    await expect(
      t.services.account.updateAccount(
        auth,
        { currentPassword: "nope", email: "x@example.com" },
        charge,
      ),
    ).rejects.toMatchObject({ code: "current_password_invalid" });
    expect(charged).toBe(1);
    await t.services.auth.signup({ email: "taken@example.com", password: "long-enough" }, client);
    await expect(
      t.services.account.updateAccount(
        auth,
        { currentPassword: MEMBER_PASSWORD, email: "taken@example.com" },
        charge,
      ),
    ).rejects.toMatchObject({ code: "email_already_registered" });

    const updated = await t.services.account.updateAccount(
      auth,
      {
        currentPassword: MEMBER_PASSWORD,
        email: "renamed@example.com",
        newPassword: "a-new-password",
      },
      charge,
    );
    expect(updated.account.email).toBe("renamed@example.com");
    expect(updated.account.isDemo).toBeUndefined();
    expect(await t.services.auth.authenticate(viewer.token)).not.toBeNull();
    expect(await t.services.auth.authenticate(other.token)).toBeNull();
    expect(await t.gate.list(viewer.session.accountId)).toHaveLength(0);
    await expect(
      t.services.auth.login(
        { email: "renamed@example.com", password: MEMBER_PASSWORD },
        client,
        openLogin,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await t.services.auth.login(
      { email: "renamed@example.com", password: "a-new-password" },
      client,
      openLogin,
    );
  });

  it("keeps the demo account's sign-in details and membership", async () => {
    const t = await createTestServices();
    const auth = await authOf(t, (await demoViewer(t)).token);
    const refused: Array<() => Promise<unknown>> = [
      () =>
        t.services.account.updateAccount(
          auth,
          { currentPassword: "webflix-demo", newPassword: "taken-over-1" },
          uncharged,
        ),
      () => t.services.account.changePlan(DEMO_ACCOUNT, { planId: "basic" }),
      () => t.services.account.cancel(DEMO_ACCOUNT),
    ];
    for (const call of refused) {
      await expect(call()).rejects.toMatchObject({ code: "demo_account_protected" });
    }
    const details = await t.services.account.getAccount(DEMO_ACCOUNT);
    expect(details.account).toMatchObject({ email: "demo@webflix.dev", isDemo: true });
    expect(details.subscription?.status).toBe("active");
  });

  it("lists and revokes devices", async () => {
    const t = await createTestServices();
    const one = await memberViewer(t);
    const two = await memberDevice(t, "member@example.com", one.profile.id);
    const auth = await authOf(t, one.token);
    const devices = await t.services.account.listDevices(auth);
    expect(devices.items).toHaveLength(2);
    expect(devices.items.filter((device) => device.current).map((device) => device.id)).toEqual([
      one.session.id,
    ]);
    expect(devices.items.find((device) => device.current)?.label).toBe("Chrome on macOS");
    await t.services.account.revokeDevice(auth, two.session.id);
    expect(await t.services.auth.authenticate(two.token)).toBeNull();
    await expect(t.services.account.revokeDevice(auth, two.session.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("profiles", () => {
  it("creates up to five profiles; kids profiles are capped at 7+", async () => {
    const t = await createTestServices();
    const me = await memberViewer(t);
    const auth = await authOf(t, me.token);
    const kid = await t.services.profiles.create(
      auth,
      { name: "Little One", avatarId: "av-robot", isKids: true, maturityCeiling: "18+" },
      uncharged,
    );
    expect(kid).toMatchObject({
      isKids: true,
      maturityCeiling: "7+",
      isLocked: false,
      avatar: { name: "Robot" },
    });
    // A kids profile puts parental controls in use: more profiles need the password.
    expect((await t.services.profiles.list(me.session.accountId)).parentalControls).toBe(true);
    const add = (name: string, avatarId = "av-fox") =>
      t.services.profiles.create(
        auth,
        { name, avatarId, currentPassword: MEMBER_PASSWORD },
        uncharged,
      );
    for (const name of ["Third", "Fourth", "Fifth"]) await add(name);
    await expect(add("Sixth")).rejects.toMatchObject({ code: "profile_limit_reached" });
    await expect(add("Bad", "av-nope")).rejects.toMatchObject({ code: "not_found" });
    const list = await t.services.profiles.list(me.session.accountId);
    expect(list.items).toHaveLength(5);
    expect(list.maxProfiles).toBe(5);
  });

  it("requires the account password to loosen a profile or change its PIN", async () => {
    const t = await createTestServices();
    const me = await memberViewer(t);
    const auth = await authOf(t, me.token);
    const kids = await t.services.profiles.create(
      auth,
      { name: "Kids", avatarId: "av-robot", isKids: true },
      uncharged,
    );
    const update = (profileId: string, input: Parameters<typeof t.services.profiles.update>[2]) =>
      t.services.profiles.update(auth, profileId, input, uncharged);
    await expect(update(kids.id, { isKids: false, maturityCeiling: "18+" })).rejects.toMatchObject({
      code: "password_required",
    });
    await expect(update(me.profile.id, { pin: "4321" })).rejects.toMatchObject({
      code: "password_required",
    });
    await expect(
      update(me.profile.id, { pin: "4321", currentPassword: "not-the-password" }),
    ).rejects.toMatchObject({ code: "current_password_invalid" });
    // Turning off "kids" lifts kids-only restrictions even when the ceiling stays at 7+.
    await expect(update(kids.id, { isKids: false })).rejects.toMatchObject({
      code: "password_required",
    });
    expect(
      await update(kids.id, { isKids: false, currentPassword: MEMBER_PASSWORD }),
    ).toMatchObject({ isKids: false, maturityCeiling: "7+" });

    const lowered = await update(me.profile.id, {
      maturityCeiling: "13+",
      name: "Me Too",
      settings: { autoplayPreviews: false },
    });
    expect(lowered).toMatchObject({
      name: "Me Too",
      maturityCeiling: "13+",
      settings: { autoplayPreviews: false, autoplayNextEpisode: true },
    });
    const locked = await update(me.profile.id, { pin: "4321", currentPassword: MEMBER_PASSWORD });
    expect(locked.isLocked).toBe(true);
    const unlocked = await update(me.profile.id, { pin: null, currentPassword: MEMBER_PASSWORD });
    expect(unlocked.isLocked).toBe(false);
  });

  it("a new PIN sends the profile's other devices back to the gate and ends their streams", async () => {
    const t = await createTestServices();
    const me = await memberViewer(t);
    const auth = await authOf(t, me.token);
    const shared = await t.services.profiles.create(
      auth,
      { name: "Shared", avatarId: "av-owl" },
      uncharged,
    );
    const tablet = await memberDevice(t, "member@example.com", shared.id);
    const phone = await memberDevice(t, "member@example.com", me.profile.id, "Mobile Safari");
    await t.services.playback.start(tablet, { titleId: "t-orbit" });
    await t.services.playback.start(phone, { titleId: "t-orbit" });
    expect(await t.gate.list(me.session.accountId)).toHaveLength(2);

    await t.services.profiles.update(
      auth,
      shared.id,
      { pin: "2580", currentPassword: MEMBER_PASSWORD },
      uncharged,
    );
    // The tablet must enter the new PIN; the phone, on another profile, keeps watching.
    expect((await authOf(t, tablet.token)).profile).toBeNull();
    expect((await authOf(t, phone.token)).profile?.id).toBe(me.profile.id);
    expect((await t.gate.list(me.session.accountId)).map((lease) => lease.deviceId)).toEqual([
      phone.session.id,
    ]);
    // Removing a lock locks nobody out.
    const back = await authOf(t, tablet.token);
    await t.services.auth.selectProfile(back, { profileId: shared.id, pin: "2580" }, uncharged);
    await t.services.profiles.update(
      auth,
      shared.id,
      { pin: null, currentPassword: MEMBER_PASSWORD },
      uncharged,
    );
    expect((await authOf(t, tablet.token)).profile?.id).toBe(shared.id);
  });

  it("deletes profiles but never the last one", async () => {
    const t = await createTestServices();
    const me = await memberViewer(t);
    const auth = await authOf(t, me.token);
    const other = await t.services.profiles.create(
      auth,
      { name: "Other", avatarId: "av-owl" },
      uncharged,
    );
    await t.services.profiles.remove(auth, other.id, {}, uncharged);
    await expect(
      t.services.profiles.remove(auth, me.profile.id, {}, uncharged),
    ).rejects.toMatchObject({ code: "profile_last_remaining" });
    await expect(t.services.profiles.remove(auth, other.id, {}, uncharged)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("keeps the demo account's profiles; their settings stay adjustable", async () => {
    const t = await createTestServices();
    const auth = await authOf(t, (await demoViewer(t)).token);
    const refused: Array<() => Promise<unknown>> = [
      () => t.services.profiles.create(auth, { name: "X", avatarId: "av-fox" }, uncharged),
      () => t.services.profiles.remove(auth, "pr-kids", {}, uncharged),
      () => t.services.profiles.update(auth, "pr-demo", { name: "Mine" }, uncharged),
      () => t.services.profiles.update(auth, "pr-demo", { avatarId: "av-owl" }, uncharged),
      () =>
        t.services.profiles.update(
          auth,
          "pr-kids",
          { isKids: false, currentPassword: "webflix-demo" },
          uncharged,
        ),
    ];
    for (const call of refused) {
      await expect(call()).rejects.toMatchObject({ code: "demo_account_protected" });
    }
    const tuned = await t.services.profiles.update(
      auth,
      "pr-demo",
      { settings: { autoplayPreviews: false } },
      uncharged,
    );
    expect(tuned.settings.autoplayPreviews).toBe(false);
  });

  it("groups avatars for the picker", async () => {
    const t = await createTestServices();
    const catalog = await t.services.profiles.listAvatars();
    expect(
      catalog.groups.map((group) => [group.id, group.avatars.map((avatar) => avatar.id)]),
    ).toEqual([
      ["ag-classics", ["av-fox", "av-owl"]],
      ["ag-kids", ["av-robot"]],
    ]);
    // Packaged avatar images carry their content version.
    expect(catalog.groups[0]?.avatars[0]?.imageUrl).toBe("/cdn/img/avatars/av-fox.webp?v=fox001");
  });
});
