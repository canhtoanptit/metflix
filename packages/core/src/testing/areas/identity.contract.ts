import { describe, expect, it } from "vitest";
import type { IdentityAccount, LinkedIdentityRecord } from "../../areas/identity/repository.ts";
import { type Repositories, UniqueViolationError } from "../../repositories/ports.ts";
import type { SessionRecord } from "../../repositories/records.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface IdentityRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

const T0 = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function account(id: string, overrides: Partial<IdentityAccount> = {}): IdentityAccount {
  return {
    id,
    email: `${id}@example.test`,
    passwordHash: "$pbkdf2-sha256$i=1$c2FsdA$aGFzaA",
    emailVerifiedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function session(
  id: string,
  accountId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    tokenHash: `hash-${id}`,
    accountId,
    activeProfileId: null,
    deviceLabel: "Test",
    deviceType: "desktop",
    persistent: true,
    createdAt: T0,
    lastSeenAt: T0,
    expiresAt: T0 + 24 * HOUR,
    ...overrides,
  };
}

function identity(
  accountId: string,
  provider: LinkedIdentityRecord["provider"],
  subject: string,
  overrides: Partial<LinkedIdentityRecord> = {},
): LinkedIdentityRecord {
  return {
    provider,
    subject,
    accountId,
    issuer: `https://issuer.test/${provider}`,
    emailAtLink: `${accountId}@example.test`,
    createdAt: T0,
    lastUsedAt: T0,
    ...overrides,
  };
}

async function rejectsWith(promise: Promise<unknown>, field: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UniqueViolationError);
  expect((error as UniqueViolationError).field).toBe(field);
}

/**
 * Contract of the identity area's repository (`repos.identity`), run against memory, SQLite,
 * PostgreSQL and D1: accounts without a membership and without a password, linked identities and
 * the rule that keeps one way to sign in, the account-holder proof on sessions, single-use email
 * tokens bound to the address they were sent to, the outbox, suppressions and claims.
 */
export function describeIdentityRepositoryContract(
  name: string,
  factory: HarnessFactory<IdentityRepositoryHarness>,
): void {
  describe(`IdentityRepository contract: ${name}`, () => {
    const h = useHarness(factory);
    const repo = () => h().repos.identity;

    async function create(
      id: string,
      overrides: Partial<IdentityAccount> = {},
      link?: LinkedIdentityRecord,
    ) {
      await repo().createAccount({
        account: account(id, overrides),
        session: session(`s-${id}`, id),
        identity: link ?? null,
      });
    }

    describe("accounts", () => {
      it("creates an account without a membership, its session and an optional identity", async () => {
        await create(
          "acc-1",
          { passwordHash: null, emailVerifiedAt: T0 },
          identity("acc-1", "google", "sub-1"),
        );
        expect(await repo().getAccount("acc-1")).toEqual(
          account("acc-1", { passwordHash: null, emailVerifiedAt: T0 }),
        );
        expect(await repo().findAccountByEmail("acc-1@example.test")).toMatchObject({
          id: "acc-1",
        });
        expect((await repo().getSession("s-acc-1", T0))?.session.accountId).toBe("acc-1");
        expect(await repo().findIdentity("google", "sub-1")).toEqual(
          identity("acc-1", "google", "sub-1"),
        );
        // No membership: milestone 1's join reads nothing (billing serves `none`).
        expect(await h().repos.accounts.get("acc-1")).toBeNull();
        expect(await h().repos.accounts.emailExists("acc-1@example.test")).toBe(true);
      });

      it("never hands out the stored empty string as a password hash", async () => {
        await create("acc-1", { passwordHash: null });
        expect((await repo().getAccount("acc-1"))?.passwordHash).toBeNull();
        expect((await repo().findAccountByEmail("acc-1@example.test"))?.passwordHash).toBeNull();
      });

      it("reads milestone 1 accounts (with a membership and a password)", async () => {
        await h().repos.accounts.createWithSession({
          account: {
            id: "acc-m1",
            email: "m1@example.test",
            passwordHash: "$h$1",
            createdAt: T0,
            updatedAt: T0,
          },
          subscription: {
            accountId: "acc-m1",
            planId: "basic",
            startedAt: T0,
            currentPeriodEnd: T0 + 30 * 24 * HOUR,
            canceledAt: null,
            card: null,
            updatedAt: T0,
          },
          session: session("s-m1", "acc-m1"),
        });
        expect(await repo().getAccount("acc-m1")).toEqual({
          id: "acc-m1",
          email: "m1@example.test",
          passwordHash: "$h$1",
          emailVerifiedAt: null,
          createdAt: T0,
          updatedAt: T0,
        });
        expect(await repo().getAccount("acc-missing")).toBeNull();
      });

      it("reads an account with its subscription row or none, and the session bootstrap in one call", async () => {
        await create("acc-1", { passwordHash: null, emailVerifiedAt: T0 });
        expect(await repo().loadBootstrap("acc-1")).toEqual({
          account: account("acc-1", { passwordHash: null, emailVerifiedAt: T0 }),
          subscription: null,
          profiles: [],
        });
        const subscription = {
          accountId: "acc-m1",
          planId: "premium" as const,
          startedAt: T0,
          currentPeriodEnd: T0 + 30 * 24 * HOUR,
          canceledAt: null,
          card: { brand: "visa" as const, last4: "4242", expMonth: 12, expYear: 2031 },
          updatedAt: T0,
        };
        await h().repos.accounts.createWithSession({
          account: {
            id: "acc-m1",
            email: "m1@example.test",
            passwordHash: "$h$1",
            createdAt: T0,
            updatedAt: T0,
          },
          subscription,
          session: session("s-m1", "acc-m1"),
        });
        for (const [id, at] of [
          ["pr-b", T0 + 2],
          ["pr-a", T0 + 1],
        ] as const) {
          await h().repos.profiles.createWithinLimit(
            {
              id,
              accountId: "acc-m1",
              name: id,
              avatarId: "av-missing",
              isKids: false,
              maturityCeiling: "18+",
              pinHash: null,
              settings: {
                autoplayNextEpisode: true,
                autoplayPreviews: true,
                subtitleLanguage: null,
              },
              createdAt: at,
              updatedAt: at,
            },
            5,
          );
        }
        expect(await repo().getAccountWithSubscription("acc-1")).toEqual({
          account: account("acc-1", { passwordHash: null, emailVerifiedAt: T0 }),
          subscription: null,
        });
        expect(await repo().getAccountWithSubscription("acc-m1")).toEqual({
          account: {
            id: "acc-m1",
            email: "m1@example.test",
            passwordHash: "$h$1",
            emailVerifiedAt: null,
            createdAt: T0,
            updatedAt: T0,
          },
          subscription,
        });
        expect(await repo().getAccountWithSubscription("acc-missing")).toBeNull();
        const loaded = await repo().loadBootstrap("acc-m1");
        expect(loaded?.account).toMatchObject({
          id: "acc-m1",
          passwordHash: "$h$1",
          emailVerifiedAt: null,
        });
        expect(loaded?.subscription).toEqual(subscription);
        expect(loaded?.profiles.map((profile) => profile.id)).toEqual(["pr-a", "pr-b"]);
        expect(loaded?.profiles[0]).toEqual(await h().repos.profiles.get("acc-m1", "pr-a"));
        expect(await repo().loadBootstrap("acc-missing")).toBeNull();
      });

      it("refuses a taken address or a taken identity, and writes nothing", async () => {
        await create("acc-1", {}, identity("acc-1", "google", "sub-1"));
        await rejectsWith(create("acc-2", { email: "acc-1@example.test" }), "email");
        await rejectsWith(create("acc-3", {}, identity("acc-3", "google", "sub-1")), "identity");
        expect(await repo().getAccount("acc-2")).toBeNull();
        expect(await repo().getAccount("acc-3")).toBeNull();
        expect(await repo().getSession("s-acc-3", T0)).toBeNull();
      });

      it("changes the address and forgets that the old one was verified", async () => {
        await create("acc-1", { emailVerifiedAt: T0 });
        await create("acc-2");
        await repo().changeEmail("acc-1", "new@example.test", T0 + 1);
        expect(await repo().getAccount("acc-1")).toMatchObject({
          email: "new@example.test",
          emailVerifiedAt: null,
          updatedAt: T0 + 1,
        });
        await rejectsWith(repo().changeEmail("acc-1", "acc-2@example.test", T0 + 2), "email");
      });

      it("marks an address verified only while the account still has it, keeping the first time", async () => {
        await create("acc-1");
        expect(await repo().markEmailVerified("acc-1", "other@example.test", T0 + 1)).toBe(false);
        expect((await repo().getAccount("acc-1"))?.emailVerifiedAt).toBeNull();
        expect(await repo().markEmailVerified("acc-1", "acc-1@example.test", T0 + 2)).toBe(true);
        expect(await repo().markEmailVerified("acc-1", "acc-1@example.test", T0 + 3)).toBe(true);
        expect((await repo().getAccount("acc-1"))?.emailVerifiedAt).toBe(T0 + 2);
      });
    });

    describe("linked identities", () => {
      it("links one identity per provider, keyed by (provider, subject) across accounts", async () => {
        await create("acc-1");
        await create("acc-2");
        expect(await repo().linkIdentity(identity("acc-1", "google", "sub-1"))).toBe(true);
        expect(await repo().linkIdentity(identity("acc-1", "google", "sub-2"))).toBe(false);
        await rejectsWith(repo().linkIdentity(identity("acc-2", "google", "sub-1")), "identity");
        expect(
          await repo().linkIdentity(identity("acc-1", "apple", "sub-1", { createdAt: T0 + 5 })),
        ).toBe(true);
        expect(await repo().findIdentity("google", "sub-2")).toBeNull();
        expect((await repo().listIdentities("acc-1")).map((entry) => entry.provider)).toEqual([
          "google",
          "apple",
        ]);
        expect(await repo().listIdentities("acc-2")).toEqual([]);
        await repo().touchIdentity("google", "sub-1", T0 + 9);
        expect((await repo().findIdentity("google", "sub-1"))?.lastUsedAt).toBe(T0 + 9);
      });

      it("never unlinks the last way to sign in", async () => {
        await create("acc-1", { passwordHash: null }, identity("acc-1", "google", "g-1"));
        expect(await repo().unlinkIdentity("acc-1", "apple")).toBe("not_found");
        expect(await repo().unlinkIdentity("acc-1", "google")).toBe("last");
        expect(await repo().findIdentity("google", "g-1")).not.toBeNull();
        await repo().linkIdentity(identity("acc-1", "apple", "a-1"));
        expect(await repo().unlinkIdentity("acc-1", "google")).toBe("unlinked");
        expect(await repo().unlinkIdentity("acc-1", "apple")).toBe("last");

        await create("acc-2", {}, identity("acc-2", "google", "g-2"));
        expect(await repo().unlinkIdentity("acc-2", "google")).toBe("unlinked");
        expect(await repo().listIdentities("acc-2")).toEqual([]);
      });
    });

    describe("sessions: the account-holder proof", () => {
      it("reads live sessions with their proof and sets it only on the account's live session", async () => {
        await create("acc-1");
        await create("acc-2");
        expect(await repo().getSession("s-acc-1", T0)).toEqual({
          session: session("s-acc-1", "acc-1"),
          elevatedUntil: null,
        });
        expect(await repo().elevateSession("s-acc-1", "acc-2", T0 + 300_000, T0)).toBe(false);
        expect(await repo().elevateSession("s-acc-1", "acc-1", T0 + 300_000, T0)).toBe(true);
        expect((await repo().getSession("s-acc-1", T0))?.elevatedUntil).toBe(T0 + 300_000);
        const expiry = T0 + 24 * HOUR;
        expect(await repo().getSession("s-acc-1", expiry)).toBeNull();
        expect(await repo().elevateSession("s-acc-1", "acc-1", expiry + 1, expiry)).toBe(false);
        expect(await repo().countSessions("acc-1", T0)).toBe(1);
        expect(await repo().countSessions("acc-1", expiry)).toBe(0);
      });
    });

    describe("email tokens", () => {
      const token = (
        hash: string,
        accountId: string,
        purpose: "verify_email" | "reset_password",
        extra = {},
      ) => ({
        tokenHash: hash,
        accountId,
        purpose,
        email: `${accountId}@example.test`,
        expiresAt: T0 + HOUR,
        usedAt: null,
        createdAt: T0,
        ...extra,
      });

      it("finds a token only while unused, unexpired, of its purpose and for the current address", async () => {
        await create("acc-1");
        await repo().createToken(token("t-1", "acc-1", "verify_email"));
        expect(await repo().findLiveToken("t-1", "verify_email", T0)).toEqual(
          token("t-1", "acc-1", "verify_email"),
        );
        expect(await repo().findLiveToken("t-1", "reset_password", T0)).toBeNull();
        expect(await repo().findLiveToken("t-1", "verify_email", T0 + HOUR)).toBeNull();
        expect(await repo().findLiveToken("t-unknown", "verify_email", T0)).toBeNull();
        await repo().changeEmail("acc-1", "moved@example.test", T0);
        expect(await repo().findLiveToken("t-1", "verify_email", T0)).toBeNull();
      });

      it("verifies the address with a token at most once", async () => {
        await create("acc-1");
        await repo().createToken(token("t-1", "acc-1", "verify_email"));
        await repo().createToken(token("t-r", "acc-1", "reset_password"));
        expect(await repo().consumeVerificationToken("t-r", T0)).toBeNull();
        expect(await repo().consumeVerificationToken("t-1", T0 + 5)).toBe("acc-1");
        expect((await repo().getAccount("acc-1"))?.emailVerifiedAt).toBe(T0 + 5);
        expect(await repo().consumeVerificationToken("t-1", T0 + 6)).toBeNull();
        expect(await repo().findLiveToken("t-r", "reset_password", T0)).not.toBeNull();
      });

      it("refuses an expired verification token or one for a previous address, changing nothing", async () => {
        await create("acc-1");
        await repo().createToken(token("t-old", "acc-1", "verify_email", { expiresAt: T0 }));
        expect(await repo().consumeVerificationToken("t-old", T0)).toBeNull();
        await repo().createToken(token("t-moved", "acc-1", "verify_email"));
        await repo().changeEmail("acc-1", "moved@example.test", T0);
        expect(await repo().consumeVerificationToken("t-moved", T0)).toBeNull();
        expect((await repo().getAccount("acc-1"))?.emailVerifiedAt).toBeNull();
      });

      it("resets a password at most once: new hash, verified address, every device out, stale identities and links gone", async () => {
        await create("acc-1", { passwordHash: null }, identity("acc-1", "google", "g-1"));
        await repo().linkIdentity(
          identity("acc-1", "apple", "a-1", { emailAtLink: "attacker@example.test" }),
        );
        await h().repos.sessions.create(session("s-other", "acc-1"));
        await create("acc-2");
        await repo().createToken(token("t-1", "acc-1", "reset_password"));
        await repo().createToken(token("t-2", "acc-1", "reset_password"));

        const reset = await repo().completePasswordReset({
          tokenHash: "t-1",
          passwordHash: "$new$",
          now: T0 + 7,
        });
        expect(reset).toEqual({
          accountId: "acc-1",
          email: "acc-1@example.test",
          unlinked: ["apple"],
        });
        expect(await repo().getAccount("acc-1")).toMatchObject({
          passwordHash: "$new$",
          emailVerifiedAt: T0 + 7,
          updatedAt: T0 + 7,
        });
        expect(await repo().countSessions("acc-1", T0 + 7)).toBe(0);
        expect(await repo().countSessions("acc-2", T0 + 7)).toBe(1);
        expect((await repo().listIdentities("acc-1")).map((entry) => entry.provider)).toEqual([
          "google",
        ]);
        // The other open link died with it; the token itself cannot be used again.
        expect(await repo().findLiveToken("t-2", "reset_password", T0 + 8)).toBeNull();
        expect(
          await repo().completePasswordReset({
            tokenHash: "t-1",
            passwordHash: "$x$",
            now: T0 + 8,
          }),
        ).toBeNull();
        expect(
          await repo().completePasswordReset({
            tokenHash: "t-2",
            passwordHash: "$x$",
            now: T0 + 8,
          }),
        ).toBeNull();
        expect((await repo().getAccount("acc-1"))?.passwordHash).toBe("$new$");
      });

      it("changes nothing for an expired reset token or one sent to a previous address", async () => {
        await create("acc-1");
        await repo().createToken(token("t-old", "acc-1", "reset_password", { expiresAt: T0 }));
        expect(
          await repo().completePasswordReset({ tokenHash: "t-old", passwordHash: "$x$", now: T0 }),
        ).toBeNull();
        await repo().createToken(token("t-moved", "acc-1", "reset_password"));
        await repo().changeEmail("acc-1", "moved@example.test", T0);
        expect(
          await repo().completePasswordReset({
            tokenHash: "t-moved",
            passwordHash: "$x$",
            now: T0,
          }),
        ).toBeNull();
        expect(
          await repo().completePasswordReset({ tokenHash: "t-none", passwordHash: "$x$", now: T0 }),
        ).toBeNull();
        expect((await repo().getAccount("acc-1"))?.passwordHash).toBe(
          account("acc-1").passwordHash,
        );
        expect(await repo().countSessions("acc-1", T0)).toBe(1);
      });
    });

    describe("email outbox and suppressions", () => {
      const entry = (id: string, overrides = {}) => ({
        id,
        idempotencyKey: `key-${id}`,
        to: "Member@Example.test",
        from: "Webflix <no-reply@webflix.dev>",
        template: "verify-email",
        subject: "Verify",
        html: "<p>hi</p>",
        text: "hi",
        status: "sent" as const,
        providerMessageId: null,
        createdAt: T0,
        sentAt: T0,
        ...overrides,
      });

      it("records a message once per idempotency key and reads the mailbox back", async () => {
        expect(await repo().recordEmail(entry("m-1"))).toEqual({ created: true, id: "m-1" });
        expect(await repo().recordEmail(entry("m-2", { idempotencyKey: "key-m-1" }))).toEqual({
          created: false,
          id: "m-1",
        });
        await repo().recordEmail(entry("m-3", { createdAt: T0 + 2 }));
        await repo().recordEmail(entry("m-4", { createdAt: T0 + 3, html: null, text: null }));
        await repo().recordEmail(entry("m-5", { to: "other@example.test" }));
        expect(
          (await repo().listMailbox("member@example.test", 0, 10)).map((item) => item.id),
        ).toEqual(["m-1", "m-3"]);
        expect(
          (await repo().listMailbox("MEMBER@example.test", T0 + 1, 10)).map((item) => item.id),
        ).toEqual(["m-3"]);
        expect(await repo().listMailbox("member@example.test", 0, 1)).toHaveLength(1);
      });

      it("suppresses an address once, case-insensitively", async () => {
        expect(await repo().isSuppressed("bounce@example.test")).toBe(false);
        const suppression = {
          address: "Bounce@Example.test",
          reason: "bounce" as const,
          source: "resend",
          createdAt: T0,
        };
        await repo().suppress(suppression);
        await repo().suppress({ ...suppression, reason: "complaint" });
        expect(await repo().isSuppressed("bounce@example.test")).toBe(true);
        expect(await repo().isSuppressed("BOUNCE@EXAMPLE.TEST")).toBe(true);
      });

      it("forgets an address: its messages and its suppression", async () => {
        await repo().recordEmail(entry("m-1"));
        await repo().recordEmail(entry("m-2", { to: "other@example.test" }));
        await repo().suppress({
          address: "member@example.test",
          reason: "bounce",
          source: "resend",
          createdAt: T0,
        });
        await repo().forgetAddress("MEMBER@example.test");
        expect(await repo().listMailbox("member@example.test", 0, 10)).toEqual([]);
        expect(await repo().listMailbox("other@example.test", 0, 10)).toHaveLength(1);
        expect(await repo().isSuppressed("member@example.test")).toBe(false);
      });
    });

    describe("claims and cleanup", () => {
      it("claims a key once while the claim lives, again after it expired", async () => {
        expect(await repo().hasClaim("oidc:1", T0)).toBe(false);
        expect(await repo().claim("oidc:1", T0 + 1000, T0)).toBe(true);
        expect(await repo().hasClaim("oidc:1", T0 + 999)).toBe(true);
        expect(await repo().hasClaim("oidc:1", T0 + 1000)).toBe(false);
        expect(await repo().claim("oidc:1", T0 + 1000, T0 + 999)).toBe(false);
        expect(await repo().claim("oidc:2", T0 + 1000, T0)).toBe(true);
        expect(await repo().claim("oidc:1", T0 + 5000, T0 + 1000)).toBe(true);
        expect(await repo().claim("oidc:1", T0 + 5000, T0 + 4000)).toBe(false);
      });

      it("deletes expired claims and spent or expired tokens, a bounded batch at a time", async () => {
        await create("acc-1");
        await repo().claim("c-old", T0, T0 - 1);
        await repo().claim("c-live", T0 + HOUR, T0);
        for (const [hash, expiresAt] of [
          ["t-expired", T0],
          ["t-live", T0 + HOUR],
          ["t-used", T0 + HOUR],
        ] as const) {
          await repo().createToken({
            tokenHash: hash,
            accountId: "acc-1",
            purpose: "verify_email",
            email: "acc-1@example.test",
            expiresAt,
            usedAt: null,
            createdAt: T0,
          });
        }
        await repo().consumeVerificationToken("t-used", T0);
        expect(await repo().deleteExpired(T0, 100)).toBe(3);
        expect(await repo().claim("c-live", T0 + HOUR, T0 + 1)).toBe(false);
        expect(await repo().findLiveToken("t-live", "verify_email", T0)).not.toBeNull();
        expect(await repo().deleteExpired(T0, 100)).toBe(0);
      });
    });

    describe("staff support", () => {
      it("finds accounts by address prefix or id, in address order, with a keyset", async () => {
        for (const id of ["acc-b", "acc-a", "acc-c"])
          await create(id, { email: `sam.${id}@example.test` });
        await create("acc-x", { email: "other@example.test" });
        const first = await repo().searchAccounts("Sam.", null, 2);
        expect(first.map((entry) => entry.id)).toEqual(["acc-a", "acc-b"]);
        const last = first.at(-1);
        expect(last).toBeDefined();
        if (!last) return;
        const next = await repo().searchAccounts("sam.", { email: last.email, id: last.id }, 2);
        expect(next.map((entry) => entry.id)).toEqual(["acc-c"]);
        expect((await repo().searchAccounts("acc-x", null, 5)).map((entry) => entry.id)).toEqual([
          "acc-x",
        ]);
        expect(await repo().searchAccounts("nobody", null, 5)).toEqual([]);
      });
    });
  });
}
