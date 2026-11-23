import type { Profile } from "@webflix/contracts";
import type { Environment, TestAccount } from "../env.ts";
import { check, equal, problem, rejects, succeeds } from "../expect.ts";
import type { Agent, HttpResult } from "../http.ts";
import { lockedProfile, SMOKE_PIN, selectProfileRaw } from "../limits.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF } from "./util.ts";

/**
 * Who may do what (docs/BACKEND.md, "Privileges"): a kids profile may switch profile and nothing
 * else; adding a profile while parental controls are in use needs the password; a locked
 * profile is changed or deleted only with its PIN or the password; account management needs a
 * profile without parental controls. Each path below undid parental controls before.
 */

interface Household {
  account: TestAccount;
  parent: Profile;
  kids: Profile;
  locked: Profile;
  /** A second device on the kids profile. */
  kid: Agent;
}

async function household(env: Environment, tag: string): Promise<Household> {
  const account = await env.bareSignup(tag);
  const parent = await env.createProfile(account.agent, { name: "Parent" });
  const kids = await env.createProfile(account.agent, { name: "Kid", isKids: true });
  const locked = await lockedProfile(env, account, "Private");
  const kid = await env.login(account, `${tag}-kid`);
  await env.selectProfile(kid, kids.id);
  return { account, parent, kids, locked, kid };
}

export const privilegeChecks: CheckDefinition[] = [
  {
    id: "privileges.kids-profile",
    area: "profiles",
    title:
      "A kids-profile session cannot add, change or delete other profiles, nor manage the account; it can switch and sign out",
    async run(ctx: CheckContext) {
      const { account, parent, kids, locked, kid } = await household(ctx.env, "priv-kids");
      const avatarId = await ctx.env.avatarId(kid);
      await rejects(
        () => kid.api.createProfile({ body: { name: "Free", avatarId, maturityCeiling: "18+" } }),
        "unrestricted_profile_required",
        "a kids session adds an 18+ profile",
      );
      await rejects(
        () =>
          kid.api.createProfile({
            body: { name: "Free", avatarId, currentPassword: account.password },
          }),
        "unrestricted_profile_required",
        "a kids session adds a profile, even with the password",
      );
      await rejects(
        () => kid.api.updateProfile({ params: { id: parent.id }, body: { name: "Mine" } }),
        "unrestricted_profile_required",
        "a kids session renames another profile",
      );
      await rejects(
        () =>
          kid.api.updateProfile({
            params: { id: kids.id },
            body: { isKids: false, maturityCeiling: "18+", currentPassword: account.password },
          }),
        "unrestricted_profile_required",
        "a kids session turns its own kids setting off, even with the password",
      );
      await rejects(
        () => kid.api.deleteProfile({ params: { id: locked.id } }),
        "unrestricted_profile_required",
        "a kids session deletes the locked profile",
      );
      await rejects(
        () => kid.api.getAccount(),
        "unrestricted_profile_required",
        "a kids session reads the account",
      );
      await rejects(
        () => kid.api.changePlan({ body: { planId: "basic" } }),
        "unrestricted_profile_required",
        "a kids session changes the plan",
      );
      await rejects(
        () => kid.api.cancelMembership(),
        "unrestricted_profile_required",
        "a kids session cancels the membership",
      );
      await rejects(
        () => kid.api.logoutAll(),
        "unrestricted_profile_required",
        "a kids session signs every device out",
      );
      const renamed = await succeeds(
        () =>
          kid.api.updateProfile({
            params: { id: kids.id },
            body: { name: "Robo", settings: { autoplayPreviews: false } },
          }),
        "a kids session renames its own profile",
      );
      equal(renamed.isKids, true, "the kids profile after renaming it");
      const listed = await succeeds(() => kid.api.listProfiles(), "GET /profiles");
      equal(listed.items.length, 3, "profiles after the refused changes");
      equal(listed.parentalControls, true, "parentalControls with a kids profile");
      await succeeds(
        () => kid.api.selectProfile({ body: { profileId: parent.id } }),
        "a kids session switches to an unlocked profile",
      );
      await succeeds(() => kid.api.logout(), "a kids session signs out");
    },
  },
  {
    id: "privileges.gate-and-locked",
    area: "profiles",
    title:
      "At the gate, adding a profile while parental controls are in use needs the password; a locked profile needs its PIN or the password to change or delete",
    async run(ctx: CheckContext) {
      const { account, locked } = await household(ctx.env, "priv-gate");
      const gate = await ctx.env.login(account, "priv-gate-device");
      const avatarId = await ctx.env.avatarId(gate);
      await rejects(
        () => gate.api.createProfile({ body: { name: "Guest", avatarId } }),
        "password_required",
        "adding a profile at the gate without the password",
      );
      const guest = await succeeds(
        () =>
          gate.api.createProfile({
            body: { name: "Guest", avatarId, currentPassword: account.password },
          }),
        "adding a profile at the gate with the password",
      );
      equal(guest.maturityCeiling, "18+", "the new profile's ceiling");
      await rejects(
        () => gate.api.updateProfile({ params: { id: locked.id }, body: { name: "Renamed" } }),
        "profile_unlock_required",
        "renaming a locked profile without its PIN",
      );
      await rejects(
        () =>
          gate.api.updateProfile({ params: { id: locked.id }, body: { maturityCeiling: "7+" } }),
        "profile_unlock_required",
        "lowering a locked profile's ceiling without its PIN",
      );
      const renamed = await succeeds(
        () =>
          gate.api.updateProfile({
            params: { id: locked.id },
            body: { name: "Renamed", currentPin: SMOKE_PIN },
          }),
        "renaming a locked profile with its PIN",
      );
      equal(renamed.name, "Renamed", "the locked profile's new name");
      await rejects(
        () => gate.api.deleteProfile({ params: { id: locked.id } }),
        "profile_unlock_required",
        "deleting a locked profile without its PIN",
      );
      problem(
        await gate.fetch(`${API}/profiles/${locked.id}`, {
          method: "DELETE",
          headers: CSRF,
          body: { currentPin: "12" },
        }),
        "validation_failed",
        "deleting with a PIN that is not 4 digits",
      );
      await succeeds(
        () =>
          gate.api.deleteProfile({ params: { id: locked.id }, body: { currentPin: SMOKE_PIN } }),
        "deleting a locked profile with its PIN",
      );
    },
  },
  {
    id: "privileges.account-holder",
    area: "profiles",
    title:
      "Account management needs an active profile without parental controls: refused at the gate and from a 13+ profile",
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("priv-holder");
      const teen = await ctx.env.createProfile(account.agent, {
        name: "Teen",
        maturityCeiling: "13+",
      });
      const gate = await ctx.env.login(account, "priv-holder-gate");
      await rejects(() => gate.api.getAccount(), "profile_required", "GET /account at the gate");
      await rejects(
        () => gate.api.changePlan({ body: { planId: "basic" } }),
        "profile_required",
        "a plan change at the gate",
      );
      await ctx.env.selectProfile(gate, teen.id);
      await rejects(
        () => gate.api.getAccount(),
        "unrestricted_profile_required",
        "GET /account from a 13+ profile",
      );
      await rejects(
        () => gate.api.setupPaymentMethod(),
        "unrestricted_profile_required",
        "a card change from a 13+ profile",
      );
      const holder = await ctx.env.holder(account, gate);
      const details = await succeeds(() => holder.api.getAccount(), "GET /account as the holder");
      equal(details.account.email, account.email, "the account's email");
    },
  },
  {
    id: "privileges.no-profile",
    area: "profiles",
    title:
      "An account with no profile is its own account holder at the gate: its account, devices, identities and privacy requests; a change needs the password, an export or a deletion a fresh proof; its first profile (a kids one included) ends that",
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const account = await env.bareSignup("no-profile");
      const agent = account.agent;
      const details = await succeeds(() => agent.api.getAccount(), "GET /account (no profile)");
      equal(details.account.email, account.email, "GET /account: the account's email");
      const sessions = await succeeds(
        () => agent.api.listDevices(),
        "GET /account/sessions (no profile)",
      );
      check(
        sessions.items.some((item) => item.current),
        "GET /account/sessions lacks the current device",
        { observed: JSON.stringify(sessions.items).slice(0, 300) },
      );
      const identities = await succeeds(
        () => agent.api.listIdentities(),
        "GET /account/identities (no profile)",
      );
      equal(identities.hasPassword, true, "GET /account/identities: hasPassword");
      const requests = await succeeds(
        () => agent.api.listPrivacyRequests(),
        "GET /privacy/requests (no profile)",
      );
      equal(requests.items.length, 0, "GET /privacy/requests: requests of a new account");

      // Each route's own proof still applies.
      await rejects(
        () => agent.api.updateAccount({ body: { email: env.email("no-profile-moved") } }),
        "password_required",
        "PATCH /account {email} without the password",
      );
      equal(
        (await succeeds(() => agent.api.getAccount(), "GET /account")).account.email,
        account.email,
        "the address after the refused change",
      );
      await rejects(
        () => agent.api.requestDataExport(),
        "reauthentication_required",
        "POST /privacy/export without a fresh proof",
      );
      await rejects(
        () => agent.api.requestAccountDeletion(),
        "reauthentication_required",
        "POST /account/deletion without a fresh proof",
      );
      await succeeds(
        () => agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      await succeeds(() => agent.api.requestDataExport(), "POST /privacy/export with the proof");
      const deletion = await succeeds(
        () => agent.api.requestAccountDeletion(),
        "POST /account/deletion with the proof",
      );
      await succeeds(() => agent.api.cancelAccountDeletion(), "DELETE /account/deletion (keep)");
      equal(deletion.status, "scheduled", "the deletion's status");

      // The first profile, a kids one, ends it: the gate asks for a profile again.
      const kids = await env.createProfile(agent, { name: "Kid", isKids: true });
      await rejects(
        () => agent.api.getAccount(),
        "profile_required",
        "GET /account at the gate once a profile exists",
      );
      await rejects(
        () => agent.api.listDevices(),
        "profile_required",
        "GET /account/sessions at the gate once a profile exists",
      );
      await env.selectProfile(agent, kids.id);
      await rejects(
        () => agent.api.getAccount(),
        "unrestricted_profile_required",
        "GET /account from the kids profile",
      );
      await rejects(
        () => agent.api.listPrivacyRequests(),
        "unrestricted_profile_required",
        "GET /privacy/requests from the kids profile",
      );
    },
  },
  {
    id: "privileges.pin-locks-other-devices",
    area: "profiles",
    title:
      "Setting a PIN sends every other device on that profile back to the gate; devices on other profiles keep going",
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("priv-unbind");
      const holder = await ctx.env.holder(account);
      const shared = await ctx.env.createProfile(holder, { name: "Shared" });
      const tablet = await ctx.env.login(account, "priv-unbind-tablet");
      await ctx.env.selectProfile(tablet, shared.id);
      await succeeds(() => tablet.api.getBrowse(), "browsing on the shared profile");
      await succeeds(
        () =>
          holder.api.updateProfile({
            params: { id: shared.id },
            body: { pin: SMOKE_PIN, currentPassword: account.password },
          }),
        "locking the shared profile from another device",
      );
      await rejects(
        () => tablet.api.getBrowse(),
        "profile_required",
        "the tablet's next request after the PIN was set",
      );
      await succeeds(() => holder.api.getBrowse(), "the device that set the PIN keeps browsing");
      const back = await selectProfileRaw(tablet, shared.id, SMOKE_PIN);
      check(back.status === 200, "the tablet cannot return with the new PIN", {
        expected: "200",
        observed: String(back.status),
        exchange: back.exchange,
      });
    },
  },
  {
    id: "ratelimit.credential-budget",
    area: "ratelimit",
    title:
      "Password checks after sign-in (PATCH /profiles) are limited per account and share the PIN budget",
    timeoutMs: 240_000,
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("priv-oracle");
      const kids = await ctx.env.createProfile(account.agent, { name: "Kid", isKids: true });
      const locked = await lockedProfile(ctx.env, account, "Locked");
      const agent = ctx.agent("priv-oracle", { retryOn429: false });
      for (const [name, value] of account.agent.jar.snapshot()) agent.jar.set(name, value);
      // Wrong passwords for "turn kids off", one at a time, until the account's budget runs out.
      let limited: HttpResult | null = null;
      let attempts = 0;
      while (!limited && attempts < ctx.options.burst + 60) {
        attempts += 1;
        const result = await agent.fetch(`${API}/profiles/${kids.id}`, {
          method: "PATCH",
          headers: CSRF,
          body: { isKids: false, currentPassword: `wrong-${attempts}` },
          retryOn429: false,
        });
        if (result.status === 429) limited = result;
        else problem(result, "current_password_invalid", `wrong password ${attempts}`);
      }
      check(limited, "password guesses on PATCH /profiles/:id are never rate limited", {
        expected: "429 within the documented profile-pin limit (5/min strict, 60/min dev)",
        observed: `${attempts} wrong passwords answered current_password_invalid`,
      });
      problem(limited, "rate_limited", "password guesses over the limit");
      // The budget is the account's, shared with PIN entry: the right PIN waits too.
      const pin = await selectProfileRaw(agent, locked.id, SMOKE_PIN);
      check(pin.status === 429, "PIN entry has its own budget beside password checks", {
        expected: "429 (one budget per account for every PIN and password check)",
        observed: String(pin.status),
        exchange: pin.exchange,
      });
      ctx.note(`limited after ${attempts} wrong passwords; PIN entry limited too`);
    },
  },
  {
    id: "identity.demo-account-protected",
    area: "identity",
    title:
      "The shared demo account keeps its sign-in details, card and profiles (attempts change nothing even where unprotected)",
    tags: ["demo"],
    needs: [needs.demo],
    async run(ctx: CheckContext) {
      const viewer = (await ctx.env.demo()).viewer;
      check(viewer, "demo viewer unavailable");
      const { agent, account } = viewer;
      const details = await succeeds(() => agent.api.getAccount(), "GET /account (demo)");
      equal(details.account.isDemo, true, "account.isDemo on the demo account");
      // Each attempt is one an unprotected server refuses for another reason, so running this
      // against one changes nothing.
      await rejects(
        () =>
          agent.api.updateAccount({
            body: { currentPassword: `${account.password}-not`, email: account.email },
          }),
        "demo_account_protected",
        "changing the demo account's email",
      );
      await rejects(
        () => agent.api.setupPaymentMethod(),
        "demo_account_protected",
        "replacing the demo account's card",
      );
      await rejects(
        () =>
          agent.api.createProfile({
            body: { name: "Visitor", avatarId: "a-smoke-no-such-avatar" },
          }),
        "demo_account_protected",
        "adding a profile to the demo account",
      );
    },
  },
];
