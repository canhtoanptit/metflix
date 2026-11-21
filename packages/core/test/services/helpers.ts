import { MOCK_CARDS, type PlanId } from "@webflix/contracts";
import type { AuthContext, ChargeCredentialCheck, Viewer } from "../../src/index.ts";
import type { TestServices } from "../../src/testing/index.ts";

export const DEMO_ACCOUNT = "demo-account";
export const MEMBER_PASSWORD = "long-enough";

/** A credential check that costs nothing (the HTTP layer charges a rate limit instead). */
export const uncharged: ChargeCredentialCheck = async () => {};
/** A sign-in from a browser the account does not know, with nothing charged. */
export const openLogin = { chargeEmail: uncharged };

export const APPROVED_CARD = {
  method: "card" as const,
  cardNumber: MOCK_CARDS.approved,
  expMonth: 12,
  expYear: 2031,
  cvc: "123",
  nameOnCard: "Test Viewer",
};

/** Sign in to the demo account and bind a profile, as the HTTP layer would. */
export async function demoViewer(
  t: TestServices,
  profileId = "pr-demo",
  userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0 Safari/537.36",
): Promise<Viewer & { token: string }> {
  const issued = await t.services.auth.login(
    { email: "demo@webflix.dev", password: "webflix-demo" },
    { userAgent },
    openLogin,
  );
  const auth = await t.services.auth.authenticate(issued.token);
  if (!auth) throw new Error("login did not produce a session");
  await t.deps.repos.sessions.setActiveProfile(auth.session.id, auth.session.accountId, profileId);
  const bound = await t.services.auth.authenticate(issued.token);
  if (!bound?.profile) throw new Error(`profile ${profileId} not bound`);
  return { session: bound.session, profile: bound.profile, token: issued.token };
}

/** Sign up a fresh member and bind a new profile without parental controls ("Me"). */
export async function memberViewer(
  t: TestServices,
  options: { email?: string; planId?: PlanId; userAgent?: string } = {},
): Promise<Viewer & { token: string }> {
  const email = options.email ?? "member@example.com";
  const client = {
    userAgent:
      options.userAgent ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0 Safari/537.36",
  };
  const issued = await t.services.auth.signup(
    {
      email,
      password: MEMBER_PASSWORD,
      planId: options.planId ?? "standard",
      payment: APPROVED_CARD,
    },
    client,
  );
  const auth = await authOf(t, issued.token);
  const profile = await t.services.profiles.create(
    auth,
    { name: "Me", avatarId: "av-fox" },
    uncharged,
  );
  await t.services.auth.selectProfile(auth, { profileId: profile.id }, uncharged);
  const bound = await authOf(t, issued.token);
  if (!bound.profile) throw new Error("profile not bound");
  return { session: bound.session, profile: bound.profile, token: issued.token };
}

/** Another device signed in to an existing member account, on `profileId`. */
export async function memberDevice(
  t: TestServices,
  email: string,
  profileId: string,
  userAgent = "Mozilla/5.0 (iPad; CPU OS 18_0) Safari/604.1",
): Promise<Viewer & { token: string }> {
  const issued = await t.services.auth.login(
    { email, password: MEMBER_PASSWORD },
    { userAgent },
    openLogin,
  );
  await t.services.auth.selectProfile(await authOf(t, issued.token), { profileId }, uncharged);
  const bound = await authOf(t, issued.token);
  if (!bound.profile) throw new Error("profile not bound");
  return { session: bound.session, profile: bound.profile, token: issued.token };
}

export async function authOf(t: TestServices, token: string): Promise<AuthContext> {
  const auth = await t.services.auth.authenticate(token);
  if (!auth) throw new Error("not authenticated");
  return auth;
}

/** Every title id that appears anywhere on a browse page (rows and billboard). */
export function titleIdsOf(page: {
  billboard: { title: { id: string } } | null;
  rows: { items: unknown[] }[];
}): string[] {
  const ids: string[] = page.billboard ? [page.billboard.title.id] : [];
  for (const row of page.rows) {
    for (const item of row.items) {
      const record = item as { id?: string; title?: { id: string } };
      ids.push(record.title?.id ?? record.id ?? "");
    }
  }
  return ids;
}
