/**
 * The identity area's security properties at the service level (memory repositories, manual
 * clock): accounts without a password can never be entered with one, whatever the hasher says;
 * the OpenID callback processes a response at most once even when the issuer would redeem a code
 * twice; email tokens are single-use, hashed, short-lived and bound to their address; nothing a
 * request answers depends on whether an address has an account; sign-in outcomes are events.
 */
import { DEMO_ACCOUNT_EMAIL } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { sendTemplatedEmail } from "../../src/areas/identity/email.ts";
import { createIdentityService } from "../../src/areas/identity/service.ts";
import type { AreaSeams, ServerEventInput } from "../../src/areas/module.ts";
import { sha256Hex, utf8Encode } from "../../src/encoding.ts";
import type { AuthContext, IdentityProvider, PasswordHasher, Services } from "../../src/index.ts";
import { createServices } from "../../src/index.ts";
import { MemoryIdentityProvider } from "../../src/memory/index.ts";
import { createAuthService } from "../../src/services/auth.ts";
import { createProfileService } from "../../src/services/profiles.ts";
import { createTestServices, type TestServices } from "../../src/testing/index.ts";
import { MEMBER_PASSWORD, memberViewer, openLogin, uncharged } from "./helpers.ts";

const client = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0" };

/** A hasher that says yes to everything: the guards, not the hasher, must keep accounts shut. */
const permissive: PasswordHasher = {
  algorithm: "permissive",
  supports: () => true,
  hash: async (password) => `$permissive$${password}`,
  verify: async () => ({ valid: true, needsRehash: false }),
};

/** A Google stand-in for the in-memory issuer, offered by the services under test. */
function offerGoogle(t: TestServices): MemoryIdentityProvider {
  const google = new MemoryIdentityProvider({ id: "google", clock: t.clock });
  t.deps.identityProviders.google = google;
  return google;
}

async function drain(t: TestServices): Promise<void> {
  await t.queue.drain();
}

/** Federated sign-up through start and callback, as the HTTP layer drives them. */
async function federatedSignUp(t: TestServices, google: MemoryIdentityProvider, email: string) {
  const start = await t.services.identity.startOidc({
    provider: "google",
    intent: "signin",
    returnTo: "/",
    auth: null,
  });
  const response = google.complete(start.location, { email, emailVerified: true });
  const done = await t.services.identity.completeOidc({
    provider: "google",
    response,
    transaction: start.transaction ?? undefined,
    client,
  });
  expect(done.outcome).toBe("signed-up");
  const auth = await t.services.auth.authenticate(done.session?.token);
  if (!auth) throw new Error("no session");
  return { auth, token: done.session?.token ?? "" };
}

describe("accounts without a password (stored as the empty string)", () => {
  it("never sign in with the password the timing equaliser hashes", async () => {
    const t = await createTestServices();
    const google = offerGoogle(t);
    await federatedSignUp(t, google, "nopass@example.com");
    // The comparison runs against an internal hash of this value for unknown and passwordless
    // accounts alike; only the guard keeps it from opening the account.
    await expect(
      t.services.auth.login(
        { email: "nopass@example.com", password: "webflix-timing-equaliser" },
        client,
        openLogin,
      ),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("stay shut to every password check even when the hasher accepts anything", async () => {
    const t = await createTestServices();
    const google = offerGoogle(t);
    const { auth } = await federatedSignUp(t, google, "nopass@example.com");
    const hostile: Services = createServices({ ...t.deps, passwords: permissive });

    await expect(
      hostile.auth.login({ email: "nopass@example.com", password: "anything" }, client, openLogin),
    ).rejects.toMatchObject({ code: "invalid_credentials" });

    // Every check after sign-in, through every route that takes a password.
    const profile = await hostile.profiles.create(
      auth,
      { name: "Main", avatarId: "av-fox" },
      uncharged,
    );
    const holder: AuthContext = {
      session: { ...auth.session, activeProfileId: profile.id },
      profile: (await t.deps.repos.profiles.get(auth.session.accountId, profile.id)) ?? null,
    };
    await expect(hostile.identity.elevate(holder, "anything")).rejects.toMatchObject({
      code: "password_required",
    });
    await expect(
      hostile.account.updateAccount(
        holder,
        { currentPassword: "anything", newPassword: "a new passphrase" },
        uncharged,
      ),
    ).rejects.toMatchObject({ code: "password_required" });
    await expect(
      hostile.profiles.update(
        holder,
        profile.id,
        { pin: "1234", currentPassword: "anything" },
        uncharged,
      ),
    ).rejects.toMatchObject({ code: "password_required" });
    await hostile.profiles.create(
      holder,
      { name: "Kid", avatarId: "av-fox", isKids: true },
      uncharged,
    );
    await expect(
      hostile.profiles.create(
        holder,
        { name: "Third", avatarId: "av-fox", currentPassword: "anything" },
        uncharged,
      ),
    ).rejects.toMatchObject({ code: "password_required" });
    expect((await hostile.identity.getElevation(holder)).elevatedUntil).toBeNull();
    // Nothing was written: still no password.
    expect(
      (await t.deps.repos.identity.getAccount(auth.session.accountId))?.passwordHash,
    ).toBeNull();
  });

  it("set a first password only with a fresh proof from a linked issuer", async () => {
    const t = await createTestServices();
    const google = offerGoogle(t);
    const { auth } = await federatedSignUp(t, google, "later@example.com");
    const profile = await t.services.profiles.create(
      auth,
      { name: "Main", avatarId: "av-fox" },
      uncharged,
    );
    const holder: AuthContext = {
      session: { ...auth.session, activeProfileId: profile.id },
      profile: (await t.deps.repos.profiles.get(auth.session.accountId, profile.id)) ?? null,
    };
    await expect(
      t.services.account.updateAccount(holder, { newPassword: "a first passphrase" }, uncharged),
    ).rejects.toMatchObject({ code: "password_required" });
    const start = await t.services.identity.startOidc({
      provider: "google",
      intent: "reauth",
      returnTo: "/",
      auth: holder,
    });
    const proof = await t.services.identity.completeOidc({
      provider: "google",
      response: google.complete(start.location, {
        email: "later@example.com",
        emailVerified: true,
      }),
      transaction: start.transaction ?? undefined,
      client,
    });
    expect(proof.outcome).toBe("reauthenticated");
    // getAccount is billing's and needs a membership; the change itself is what matters here.
    await t.services.account
      .updateAccount(holder, { newPassword: "a first passphrase" }, uncharged)
      .catch((error: { code?: string }) => expect(error.code).toBe("unauthenticated"));
    await expect(
      t.services.auth.login(
        { email: "later@example.com", password: "a first passphrase" },
        client,
        openLogin,
      ),
    ).resolves.toMatchObject({ state: { account: { hasPassword: true } } });
  });
});

describe("the OpenID callback", () => {
  it("processes an authorisation response at most once, even if the issuer would redeem it twice", async () => {
    const t = await createTestServices();
    const real = offerGoogle(t);
    const identity = {
      provider: "google" as const,
      issuer: real.issuer,
      subject: "sub-1",
      email: "twice@example.com",
      emailVerified: true,
      name: null,
      authTime: t.clock.now(),
    };
    // An issuer without single-use codes (the development issuer with store "none").
    const lenient: IdentityProvider = {
      ...real,
      id: "google",
      issuer: real.issuer,
      displayName: "Google",
      responseMode: "query",
      reportsAuthTime: true,
      authorizationUrl: (request) => real.authorizationUrl(request),
      redeem: async () => ({ ...identity }),
    };
    t.deps.identityProviders.google = lenient;
    const start = await t.services.identity.startOidc({
      provider: "google",
      intent: "signin",
      returnTo: "/",
      auth: null,
    });
    const state = new URL(start.location).searchParams.get("state") ?? "";
    const callback = {
      provider: "google" as const,
      response: { code: "any-code", state },
      transaction: start.transaction ?? undefined,
      client,
    };
    expect((await t.services.identity.completeOidc(callback)).outcome).toBe("signed-up");
    const replay = await t.services.identity.completeOidc(callback);
    expect(replay).toMatchObject({ outcome: "failed", session: null });
  });

  it("refuses an expired transaction, even when the issuer would still redeem its code", async () => {
    const t = await createTestServices();
    const real = offerGoogle(t);
    t.deps.identityProviders.google = {
      id: "google",
      issuer: real.issuer,
      displayName: "Google",
      responseMode: "query",
      reportsAuthTime: true,
      authorizationUrl: (request) => real.authorizationUrl(request),
      redeem: async () => ({
        provider: "google",
        issuer: real.issuer,
        subject: "late-sub",
        email: "late@example.com",
        emailVerified: true,
        name: null,
        authTime: t.clock.now(),
      }),
    };
    const start = await t.services.identity.startOidc({
      provider: "google",
      intent: "signin",
      returnTo: "/x",
      auth: null,
    });
    const state = new URL(start.location).searchParams.get("state") ?? "";
    t.clock.advance(10 * 60 * 1000 + 1);
    const done = await t.services.identity.completeOidc({
      provider: "google",
      response: { code: "any-code", state },
      transaction: start.transaction ?? undefined,
      client,
    });
    expect(done.outcome).toBe("failed");
    expect(done.location).toBe("http://localhost:5173/x?oidc=failed");
    expect(await t.deps.repos.identity.findAccountByEmail("late@example.com")).toBeNull();
  });

  it("never honours an identity for another issuer configured under the same provider name", async () => {
    const t = await createTestServices();
    const development = offerGoogle(t);
    await federatedSignUp(t, development, "same-sub@example.com");
    const linked =
      (await t.deps.repos.identity.findAccountByEmail("same-sub@example.com"))?.id ?? "";
    const [identity] = await t.deps.repos.identity.listIdentities(linked);
    // The real Google, configured later under the same name, asserting the same subject.
    t.deps.identityProviders.google = {
      id: "google",
      issuer: "https://accounts.google.example",
      displayName: "Google",
      responseMode: "query",
      reportsAuthTime: true,
      authorizationUrl: (request) => development.authorizationUrl(request),
      redeem: async () => ({
        provider: "google",
        issuer: "https://accounts.google.example",
        subject: identity?.subject ?? "",
        email: "someone-else@example.com",
        emailVerified: true,
        name: null,
        authTime: t.clock.now(),
      }),
    };
    const start = await t.services.identity.startOidc({
      provider: "google",
      intent: "signin",
      returnTo: "/",
      auth: null,
    });
    const state = new URL(start.location).searchParams.get("state") ?? "";
    const done = await t.services.identity.completeOidc({
      provider: "google",
      response: { code: "c", state },
      transaction: start.transaction ?? undefined,
      client,
    });
    expect(done).toMatchObject({ outcome: "failed", session: null });
  });

  it("emits sign-in and sign-up outcomes without a profile", async () => {
    const t = await createTestServices();
    const google = offerGoogle(t);
    const events: ServerEventInput[] = [];
    const seams: AreaSeams = {
      ...t.services.seams,
      emitServerEvent: async (event) => {
        events.push(event);
      },
    };
    const identity = createIdentityService(t.deps, seams);
    const auth = createAuthService(t.deps, seams);
    const start = await identity.startOidc({
      provider: "google",
      intent: "signin",
      returnTo: "/",
      auth: null,
    });
    await identity.completeOidc({
      provider: "google",
      response: google.complete(start.location, {
        email: "events@example.com",
        emailVerified: true,
      }),
      transaction: start.transaction ?? undefined,
      client,
    });
    await identity.completeOidc({
      provider: "google",
      response: { state: "x" },
      transaction: undefined,
      client,
    });
    await auth.signup({ email: "pw@example.com", password: "long-enough" }, client);
    await auth
      .login({ email: "pw@example.com", password: "wrong" }, client, openLogin)
      .catch(() => undefined);
    await auth.login({ email: "pw@example.com", password: "long-enough" }, client, openLogin);
    expect(events.map((event) => [event.type, event.payload, event.profileId])).toEqual([
      ["auth.signup", { method: "oidc", outcome: "success" }, null],
      ["auth.signin", { method: "oidc", outcome: "failure" }, null],
      ["auth.signup", { method: "password", outcome: "success" }, null],
      ["auth.signin", { method: "password", outcome: "failure" }, null],
      ["auth.signin", { method: "password", outcome: "success" }, null],
    ]);
    expect(events[0]?.accountId).toBeTruthy();
    expect(events[1]?.accountId).toBeNull();
  });
});

describe("email tokens", () => {
  async function resetLink(t: TestServices, email: string): Promise<string> {
    await t.services.identity.requestPasswordReset(email, uncharged);
    await drain(t);
    const message = t.ports.email
      .mailbox(email)
      .findLast((item) => item.template === "reset-password");
    const link = message?.text.match(/https?:\/\/\S+#token=[A-Za-z0-9_-]+/)?.[0];
    if (!link) throw new Error("no reset link");
    return new URL(link).hash.slice("#token=".length);
  }

  it("are stored only as hashes, live 30 minutes, and work once", async () => {
    const t = await createTestServices();
    await t.services.auth.signup({ email: "tok@example.com", password: "long-enough" }, client);
    const token = await resetLink(t, "tok@example.com");
    const hash = await sha256Hex(utf8Encode(token));
    const stored = await t.deps.repos.identity.findLiveToken(hash, "reset_password", t.clock.now());
    expect(stored).toMatchObject({ purpose: "reset_password", email: "tok@example.com" });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored?.expiresAt).toBe(t.clock.now() + 30 * 60 * 1000);

    t.clock.advance(30 * 60 * 1000);
    await expect(
      t.services.identity.confirmPasswordReset(token, "a new passphrase"),
    ).rejects.toMatchObject({
      code: "verification_token_invalid",
    });
    const fresh = await resetLink(t, "tok@example.com");
    await t.services.identity.confirmPasswordReset(fresh, "a new passphrase");
    await expect(
      t.services.identity.confirmPasswordReset(fresh, "another passphrase"),
    ).rejects.toMatchObject({
      code: "verification_token_invalid",
    });
  });

  it("die when the address changes", async () => {
    const t = await createTestServices();
    const issued = await t.services.auth.signup(
      { email: "moving@example.com", password: "long-enough" },
      client,
    );
    const token = await resetLink(t, "moving@example.com");
    await t.deps.repos.identity.changeEmail(
      issued.state.account.id,
      "moved@example.com",
      t.clock.now(),
    );
    await expect(
      t.services.identity.confirmPasswordReset(token, "a new passphrase"),
    ).rejects.toMatchObject({
      code: "verification_token_invalid",
    });
  });

  it("answer a reset request the same way for any address, and send nothing to the demo account", async () => {
    const t = await createTestServices();
    await t.services.auth.signup({ email: "known@example.com", password: "long-enough" }, client);
    const charged: string[] = [];
    const charge = async (address: string) => {
      charged.push(address);
    };
    for (const email of ["known@example.com", "unknown@example.com", DEMO_ACCOUNT_EMAIL]) {
      await expect(
        t.services.identity.requestPasswordReset(email, charge),
      ).resolves.toBeUndefined();
    }
    // Charged per address before anything was looked up, known or not.
    expect(charged).toEqual(["known@example.com", "unknown@example.com", DEMO_ACCOUNT_EMAIL]);
    await drain(t);
    expect(t.ports.email.mailbox("known@example.com").map((item) => item.template)).toContain(
      "reset-password",
    );
    expect(t.ports.email.mailbox("unknown@example.com")).toEqual([]);
    expect(t.ports.email.mailbox(DEMO_ACCOUNT_EMAIL)).toEqual([]);
  });

  it("are not sent to a suppressed address", async () => {
    const t = await createTestServices();
    await t.services.auth.signup({ email: "bounced@example.com", password: "long-enough" }, client);
    await t.deps.repos.identity.suppress({
      address: "bounced@example.com",
      reason: "bounce",
      source: "test",
      createdAt: t.clock.now(),
    });
    await drain(t);
    await t.services.identity.requestPasswordReset("bounced@example.com", uncharged);
    await drain(t);
    expect(t.ports.email.mailbox("bounced@example.com")).toEqual([]);
  });
});

describe("the local mailbox (diagnostics)", () => {
  it("is served outside production only, and only for a sender that keeps what it sent", async () => {
    const t = await createTestServices();
    await t.services.auth.signup({ email: "box@example.com", password: "long-enough" }, client);
    await drain(t);
    const box = await t.services.identity.mailbox({ to: "box@example.com" });
    expect(box.items.map((item) => item.template)).toEqual(["verify-email"]);
    expect(box.items[0]?.links[0]).toMatch(/^http:\/\/localhost:5173\/verify-email#token=/);

    const production = await createTestServices({
      config: {
        WEBFLIX_ENV: "production",
        WEBFLIX_MEDIA_TOKEN_KEYS: "k1:a-production-secret-of-thirty-two-chars",
        WEBFLIX_PSEUDONYM_KEY: "a-production-pseudonym-key-of-32-chars-long",
      },
    });
    await expect(
      production.services.identity.mailbox({ to: "box@example.com" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });

    const smtpLike = await createTestServices();
    smtpLike.deps.email = { send: async () => ({ messageId: "m", deduplicated: false }) };
    const rebuilt = createServices(smtpLike.deps);
    await expect(rebuilt.identity.mailbox({ to: "box@example.com" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("staff support methods (the admin area wires the routes)", () => {
  it("finds members, reads their identity, signs them out, sends a reset, removes a PIN", async () => {
    const t = await createTestServices();
    const google = offerGoogle(t);
    const { auth, token } = await federatedSignUp(t, google, "support@example.com");
    const accountId = auth.session.accountId;
    await t.services.auth.signup(
      { email: "support2@example.com", password: "long-enough" },
      client,
    );

    const found = await t.services.identity.searchMembers({ q: "Support", limit: 1 });
    // Binary order: "2" sorts before "@".
    expect(found.items.map((item) => item.email)).toEqual(["support2@example.com"]);
    expect(found.nextCursor).not.toBeNull();
    const next = await t.services.identity.searchMembers({
      q: "support",
      cursor: found.nextCursor ?? undefined,
      limit: 1,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.email).toBe("support@example.com");
    await expect(
      t.services.identity.searchMembers({ q: "support", cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({
      code: "validation_failed",
    });

    const profile = await t.services.profiles.create(
      auth,
      { name: "Locked", avatarId: "av-fox" },
      uncharged,
    );
    const pinHash = await t.deps.passwords.hash("1234");
    await t.deps.repos.profiles.update(accountId, profile.id, {
      pinHash,
      updatedAt: t.clock.now(),
    });
    const member = await t.services.identity.getMemberIdentity(accountId);
    expect(member).toMatchObject({
      account: {
        email: "support@example.com",
        emailVerified: true,
        hasPassword: false,
        isDemo: false,
      },
      identities: [{ provider: "google", emailAtLink: "support@example.com" }],
      profiles: [{ id: profile.id, locked: true }],
      activeDevices: 1,
    });

    expect(await t.services.identity.removeMemberProfilePin(accountId, profile.id)).toEqual({
      hadPin: true,
    });
    expect(await t.services.identity.removeMemberProfilePin(accountId, profile.id)).toEqual({
      hadPin: false,
    });
    expect(await t.services.identity.sendMemberPasswordReset(accountId)).toEqual({
      email: "support@example.com",
    });
    expect(await t.services.identity.signOutMemberEverywhere(accountId)).toEqual({
      sessionsEnded: 1,
    });
    expect(await t.services.auth.authenticate(token)).toBeNull();
    await drain(t);
    expect(t.ports.email.mailbox("support@example.com").map((item) => item.template)).toContain(
      "reset-password",
    );

    for (const call of [
      () => t.services.identity.signOutMemberEverywhere("demo-account"),
      () => t.services.identity.sendMemberPasswordReset("demo-account"),
      () => t.services.identity.removeMemberProfilePin("demo-account", "pr-demo"),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "demo_account_protected" });
    }
    await expect(t.services.identity.getMemberIdentity("missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("what identity offers the events area's privacy jobs", () => {
  it("sends the data-export-ready email through the templates, once per key, never to a suppressed address", async () => {
    const t = await createTestServices();
    const request = {
      to: "export@example.com",
      template: "data-export-ready" as const,
      data: {
        link: "http://localhost:5173/api/v1/privacy/exports/req-1?token=abc.def",
        expiresAt: "2026-06-22T12:00:00.000Z",
      },
      idempotencyKey: "privacy-export:req-1",
    };
    expect(await sendTemplatedEmail(t.deps, request)).toMatchObject({
      sent: true,
      deduplicated: false,
    });
    expect(await sendTemplatedEmail(t.deps, request)).toMatchObject({
      sent: true,
      deduplicated: true,
    });
    const [message, ...rest] = t.ports.email.mailbox("export@example.com");
    expect(rest).toEqual([]);
    expect(message).toMatchObject({
      template: "data-export-ready",
      subject: "Your Webflix data is ready to download",
    });
    expect(message?.text).toContain(
      "http://localhost:5173/api/v1/privacy/exports/req-1?token=abc.def",
    );
    expect(message?.text).toContain("22 June 2026, 12:00 UTC");

    await t.deps.repos.identity.suppress({
      address: "gone@example.com",
      reason: "bounce",
      source: "test",
      createdAt: t.clock.now(),
    });
    expect(
      await sendTemplatedEmail(t.deps, {
        ...request,
        to: "gone@example.com",
        idempotencyKey: "k2",
      }),
    ).toEqual({
      sent: false,
      reason: "suppressed",
    });
    expect(t.ports.email.mailbox("gone@example.com")).toEqual([]);
    await expect(
      sendTemplatedEmail(t.deps, {
        ...request,
        data: { ...request.data, link: "javascript:alert(1)" },
        idempotencyKey: "k3",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("exports linked identities and the address's verification, and erases what the cascade does not cover", async () => {
    const t = await createTestServices();
    const google = offerGoogle(t);
    const { auth } = await federatedSignUp(t, google, "rights@example.com");
    const accountId = auth.session.accountId;
    const profile = await t.services.profiles.create(
      auth,
      { name: "Main", avatarId: "av-fox" },
      uncharged,
    );
    const at = new Date(t.clock.now()).toISOString();
    const exported = (await t.services.identity.exportAccountData?.(accountId)) as Record<
      string,
      unknown
    >;
    expect(exported).toEqual({
      emailVerified: true,
      emailVerifiedAt: at,
      hasPassword: false,
      linkedIdentities: [
        { provider: "google", emailAtLink: "rights@example.com", linkedAt: at, lastUsedAt: at },
      ],
      profiles: [
        {
          id: profile.id,
          name: "Main",
          avatarId: "av-fox",
          avatar: expect.objectContaining({ id: "av-fox", name: "Fox" }),
          kids: false,
          maturityCeiling: "18+",
          locked: false,
          settings: expect.objectContaining({ autoplayNextEpisode: expect.any(Boolean) }),
          createdAt: at,
        },
      ],
      devices: [
        {
          id: auth.session.id,
          label: "Chrome on macOS",
          type: "desktop",
          signedInAt: at,
          lastSeenAt: at,
          expiresAt: new Date(auth.session.expiresAt).toISOString(),
        },
      ],
    });
    // Never a credential: no hash, PIN or token anywhere in it.
    expect(JSON.stringify(exported)).not.toMatch(/hash|pin"|token/i);
    expect(await t.services.identity.exportAccountData?.("missing")).toBeNull();

    await t.deps.repos.identity.suppress({
      address: "rights@example.com",
      reason: "complaint",
      source: "test",
      createdAt: t.clock.now(),
    });
    await t.deps.repos.identity.recordEmail({
      id: "m-1",
      idempotencyKey: "k-1",
      to: "rights@example.com",
      from: "no-reply@webflix.dev",
      template: "welcome",
      subject: "Welcome",
      html: "<p>hi</p>",
      text: "hi",
      status: "sent",
      providerMessageId: null,
      createdAt: t.clock.now(),
      sentAt: t.clock.now(),
    });
    await t.services.identity.eraseAccountData?.(accountId);
    expect(await t.deps.repos.identity.isSuppressed("rights@example.com")).toBe(false);
    expect(await t.deps.repos.identity.listMailbox("rights@example.com", 0, 10)).toEqual([]);
  });
});

describe("a profile that becomes restricted", () => {
  it("queues its behaviour for erasure once, when it becomes restricted, and not otherwise", async () => {
    const t = await createTestServices();
    const forgotten: Array<{ accountId: string; profileId: string }> = [];
    const profiles = createProfileService(t.deps, {
      forgetProfileBehaviour: async (input) => {
        forgotten.push(input);
      },
    });
    const viewer = await memberViewer(t, { email: "family@example.com" });
    const accountId = viewer.session.accountId;
    const auth = { session: viewer.session, profile: viewer.profile };
    const teen = await profiles.create(auth, { name: "Teen", avatarId: "av-fox" }, uncharged);

    await profiles.update(auth, teen.id, { name: "Teenager" }, uncharged);
    expect(forgotten).toEqual([]);
    await profiles.update(auth, teen.id, { maturityCeiling: "13+" }, uncharged);
    expect(forgotten).toEqual([{ accountId, profileId: teen.id }]);
    // Already restricted: lowering further, or loosening again, queues nothing more.
    await profiles.update(auth, teen.id, { maturityCeiling: "7+" }, uncharged);
    await profiles.update(
      auth,
      teen.id,
      { maturityCeiling: "18+", currentPassword: MEMBER_PASSWORD },
      uncharged,
    );
    expect(forgotten).toHaveLength(1);

    const other = await profiles.create(
      auth,
      { name: "Other", avatarId: "av-fox", currentPassword: MEMBER_PASSWORD },
      uncharged,
    );
    await profiles.update(auth, other.id, { isKids: true }, uncharged);
    expect(forgotten).toEqual([
      { accountId, profileId: teen.id },
      { accountId, profileId: other.id },
    ]);
    // A profile created restricted has no history to forget.
    await profiles.create(
      auth,
      { name: "Little", avatarId: "av-fox", isKids: true, currentPassword: MEMBER_PASSWORD },
      uncharged,
    );
    expect(forgotten).toHaveLength(2);
  });
});
