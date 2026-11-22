/**
 * Helpers for the sign-in and account-security journeys (identity-*.spec.ts): the development
 * issuer's page answered the way a member would, the local mailbox's emailed links, and accounts
 * created through a provider. Everything goes through the deployment's public origin, as a
 * browser would; a deployment without the stand-ins (production configuration, a real Google
 * client) skips these journeys with the reason.
 */
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { CLIENT_HEADERS, createProfile, selectProfile, sendPatiently } from "./api.ts";

export type MemberIssuer = "google" | "apple";

/** Skip unless the deployment offers this issuer through the development issuer. */
export async function requireDevIssuer(
  request: APIRequestContext,
  provider: MemberIssuer,
): Promise<string> {
  const offered = await request.get("/api/v1/auth/providers");
  expect(offered.status(), "GET /auth/providers").toBe(200);
  const items = ((await offered.json()) as { items: Array<{ id: string; displayName: string }> })
    .items;
  const item = items.find((candidate) => candidate.id === provider);
  test.skip(!item, `the deployment does not offer ${provider} sign-in`);
  const start = await request.get(`/api/v1/auth/oidc/${provider}/start`, { maxRedirects: 0 });
  const location = start.headers().location ?? "";
  test.skip(
    !location.includes(`/dev-idp/${provider}/`),
    `${provider} sign-in goes to ${location || `a ${start.status()}`}, not the development issuer: a real provider needs a real account`,
  );
  return item?.displayName ?? provider;
}

/** What to answer on the development issuer's sign-in page. */
export interface IssuerAnswer {
  /** An address typed on the page (the issuer mints a stable identity per address). */
  email?: string;
  /** Or one of its personas. */
  persona?: string;
  /** Press Cancel. */
  cancel?: boolean;
  /** Fault names from its catalogue, ticked for this sign-in. */
  faults?: string[];
}

/** Answer the issuer's page (the browser is on it, or on its way there). */
export async function answerIssuer(page: Page, answer: IssuerAnswer): Promise<void> {
  const form = page.locator('form[data-dev-idp="sign-in"]');
  await expect(form).toBeVisible();
  if (answer.email) {
    await form.locator('input[name="persona"][value="__email__"]').check();
    await form.locator('input[name="email"]').fill(answer.email);
  } else if (answer.persona) {
    await form.locator(`input[name="persona"][value="${answer.persona}"]`).check();
  }
  // The fault picker is folded away on the issuer's page.
  if ((answer.faults ?? []).length > 0) await form.locator("details summary").click();
  for (const fault of answer.faults ?? []) {
    await form.locator(`input[name="fault"][value="${fault}"]`).check();
  }
  await form.locator(`button[value="${answer.cancel ? "cancel" : "continue"}"]`).click();
}

/**
 * The newest emailed link of `template` to `email` from the local mailbox, as a same-origin path
 * with its fragment (`/reset-password#token=…`). Mail is sent by a job: wait for it.
 */
export async function emailedLink(
  request: APIRequestContext,
  email: string,
  template: "verify-email" | "reset-password",
  options: { after?: string } = {},
): Promise<string> {
  const path = template === "verify-email" ? "/verify-email" : "/reset-password";
  let found: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/v1/diagnostics/mailbox?to=${encodeURIComponent(email)}`,
        );
        test.skip(response.status() === 404, "the deployment has no local mailbox");
        const box = (await response.json()) as {
          items: Array<{ template: string; links: string[]; createdAt: string; id: string }>;
        };
        const messages = box.items.filter(
          (item) =>
            item.template === template &&
            (options.after === undefined || item.id !== options.after),
        );
        const link = messages.at(-1)?.links.find((candidate) => candidate.includes(path));
        if (link) {
          const url = new URL(link);
          found = `${url.pathname}${url.search}${url.hash}`;
        }
        return found ?? null;
      },
      { message: `a ${template} email to ${email}`, timeout: 15_000 },
    )
    .not.toBeNull();
  return found as string;
}

/** The id of the newest message of `template` to `email` (to wait for a newer one). */
export async function newestMailId(
  request: APIRequestContext,
  email: string,
  template: string,
): Promise<string | undefined> {
  const response = await request.get(`/api/v1/diagnostics/mailbox?to=${encodeURIComponent(email)}`);
  if (!response.ok()) return undefined;
  const box = (await response.json()) as { items: Array<{ template: string; id: string }> };
  return box.items.filter((item) => item.template === template).at(-1)?.id;
}

/**
 * Give an account created through a provider a profile and select it, so Account opens (it
 * needs an active profile). Its membership stays `none`: Security does not depend on it.
 */
export async function giveProfile(request: APIRequestContext, name = "Riley"): Promise<string> {
  const id = await createProfile(request, { name });
  await selectProfile(request, id);
  return id;
}

/** A password account (no membership needed), signed in on `request`, its address unverified. */
export async function passwordAccount(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const signup = await sendPatiently("sign up", () =>
    request.post("/api/v1/auth/signup", { headers: CLIENT_HEADERS, data: { email, password } }),
  );
  expect(signup.status(), `sign up: ${await signup.text()}`).toBe(201);
}
