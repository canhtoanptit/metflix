/**
 * The staff console's browser specs (admin-*.spec.ts): where the console is, signing in as a
 * development staff persona through the real issuer page, and members made through the member
 * API to act on (a fresh account per spec, never the shared demo account's data).
 *
 *   ADMIN_URL      the console (default `${BASE_URL}/admin/`: the deployments serve it there)
 *   ADMIN_API_URL  where the member API and the fake payment form answer, for setting up members
 *                  (default: the console's origin; a dev console on its own Vite port proxies only
 *                  the staff API and the issuer, so point this at the API there)
 */
import {
  type APIRequestContext,
  expect,
  type Page,
  request as playwrightRequest,
} from "@playwright/test";
import { CLIENT_HEADERS, firstAvatarId, PASSWORD, sendPatiently, uniqueEmail } from "./api.ts";

const baseURL = process.env.BASE_URL ?? "http://localhost:5173";

export const ADMIN_URL = new URL(process.env.ADMIN_URL ?? "/admin/", baseURL).href.replace(
  /\/?$/,
  "/",
);
export const ADMIN_API_URL = process.env.ADMIN_API_URL ?? new URL(ADMIN_URL).origin;

/** A path inside the console (`members` → `/admin/members`). */
export function adminPath(path = ""): string {
  return new URL(path.replace(/^\//, ""), ADMIN_URL).href;
}

export type StaffPersona =
  | "staff-support"
  | "staff-billing"
  | "staff-content"
  | "staff-experiments"
  | "staff-admin"
  | "staff-no-role";

/**
 * Open the console at `path` and sign in as `persona` at the development issuer, the way staff
 * do: the console's sign-in screen, the issuer's persona page, back to the same path.
 */
export async function signInToConsole(page: Page, persona: StaffPersona, path = ""): Promise<void> {
  await page.goto(adminPath(path));
  // A fresh browser has no issuer session: the silent attempt comes back to "Sign in".
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dev-idp\/staff\//);
  await page.locator(`input[name="persona"][value="${persona}"]`).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(new RegExp(escapeRegExp(new URL(adminPath(path)).pathname)));
  if (persona !== "staff-no-role") {
    // The console's frame (at every width: the navigation itself is in a menu on phones).
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A request context on the member API (its own cookie jar: one member). */
export function memberApi(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({ baseURL: ADMIN_API_URL });
}

export interface Member {
  api: APIRequestContext;
  email: string;
  accountId: string;
  holderProfileId: string;
}

/** A new account without a membership, signed in, with an account-holder profile selected. */
export async function createMember(tag: string): Promise<Member> {
  const api = await memberApi();
  const email = uniqueEmail(`admin-${tag}`);
  const signup = await sendPatiently("sign up", () =>
    api.post("/api/v1/auth/signup", {
      headers: CLIENT_HEADERS,
      data: { email, password: PASSWORD },
    }),
  );
  expect(signup.status(), `sign up: ${await signup.text()}`).toBe(201);
  const session = (await signup.json()) as { account: { id: string } };
  const profile = await api.post("/api/v1/profiles", {
    headers: CLIENT_HEADERS,
    data: { name: "Holder", avatarId: await firstAvatarId(api) },
  });
  expect(profile.status(), `create profile: ${await profile.text()}`).toBe(201);
  const holderProfileId = ((await profile.json()) as { id: string }).id;
  const select = await sendPatiently("select profile", () =>
    api.put("/api/v1/session/profile", {
      headers: CLIENT_HEADERS,
      data: { profileId: holderProfileId },
    }),
  );
  expect(select.status(), `select profile: ${await select.text()}`).toBe(200);
  return { api, email, accountId: session.account.id, holderProfileId };
}

/** Another profile, locked with a PIN. */
export async function addLockedProfile(member: Member, name: string): Promise<string> {
  const created = await member.api.post("/api/v1/profiles", {
    headers: CLIENT_HEADERS,
    data: { name, avatarId: await firstAvatarId(member.api), currentPassword: PASSWORD },
  });
  expect(created.status(), `create profile: ${await created.text()}`).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const locked = await member.api.patch(`/api/v1/profiles/${id}`, {
    headers: CLIENT_HEADERS,
    data: { pin: "4826", currentPassword: PASSWORD },
  });
  expect(locked.status(), `lock profile: ${await locked.text()}`).toBe(200);
  return id;
}

async function confirmAtProvider(
  member: Member,
  clientSecret: string,
  card?: string,
): Promise<string> {
  const response = await member.api.post("/_pay/api/confirm", {
    headers: { "content-type": "application/json" },
    data: { clientSecret, ...(card ? { card } : {}) },
  });
  expect(response.status(), `fake provider confirm: ${await response.text()}`).toBe(200);
  return ((await response.json()) as { status: string }).status;
}

interface MembershipView {
  status: string;
  trialEndsAt: string | null;
}

async function membershipOf(member: Member): Promise<MembershipView> {
  const account = await member.api.get("/api/v1/account");
  expect(account.status(), `account: ${await account.text()}`).toBe(200);
  return ((await account.json()) as { membership: MembershipView }).membership;
}

/**
 * A trial membership through the two-step checkout with a card that never had a trial (a
 * labelled test card of the fake provider).
 */
export async function startTrial(member: Member): Promise<MembershipView> {
  const started = await member.api.post("/api/v1/billing/checkout", {
    headers: CLIENT_HEADERS,
    data: { planId: "standard" },
  });
  expect(started.status(), `start checkout: ${await started.text()}`).toBe(201);
  const checkout = (await started.json()) as { id: string; clientSecret: string };
  const label = `visa:e2e-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  expect(await confirmAtProvider(member, checkout.clientSecret, label)).toBe("succeeded");
  const confirmed = await member.api.post(`/api/v1/billing/checkout/${checkout.id}/confirm`, {
    headers: CLIENT_HEADERS,
  });
  expect(confirmed.status(), `confirm checkout: ${await confirmed.text()}`).toBe(200);
  const answer = (await confirmed.json()) as { status: string; clientSecret: string | null };
  if (answer.status === "requires_payment" && answer.clientSecret) {
    await confirmAtProvider(member, answer.clientSecret);
  }
  await expect
    .poll(async () => (await membershipOf(member)).status, { timeout: 20_000 })
    .toMatch(/^(trialing|active)$/);
  return membershipOf(member);
}

export interface PaidInvoice {
  id: string;
  number: string | null;
  amountPaid: { amountMinor: number; currency: string };
}

/** A paid membership with a paid invoice: a trial converted on the fake provider's test clock. */
export async function paidMember(tag: string): Promise<Member & { invoice: PaidInvoice }> {
  const member = await createMember(tag);
  const membership = await startTrial(member);
  if (membership.status === "trialing" && membership.trialEndsAt) {
    const clock = await member.api.post("/api/v1/diagnostics/billing/clock", {
      headers: CLIENT_HEADERS,
      data: { seconds: 1 },
    });
    expect(clock.status(), `read the clock: ${await clock.text()}`).toBe(200);
    const now = Date.parse(((await clock.json()) as { now: string }).now);
    const seconds = Math.ceil((Date.parse(membership.trialEndsAt) - now) / 1000) + 2 * 3600;
    const moved = await member.api.post("/api/v1/diagnostics/billing/clock", {
      headers: CLIENT_HEADERS,
      data: { seconds: Math.max(1, seconds) },
    });
    expect(moved.status(), `advance the clock: ${await moved.text()}`).toBe(200);
  }
  let invoice: PaidInvoice | undefined;
  await expect
    .poll(
      async () => {
        const response = await member.api.get("/api/v1/billing/invoices");
        const page = (await response.json()) as {
          items: Array<PaidInvoice & { amountRefunded: { amountMinor: number } }>;
        };
        invoice = page.items.find(
          (item) => item.amountPaid.amountMinor > 0 && item.amountRefunded.amountMinor === 0,
        );
        return invoice !== undefined;
      },
      { timeout: 30_000, message: "a paid invoice" },
    )
    .toBe(true);
  if (!invoice) throw new Error("no paid invoice");
  return { ...member, invoice };
}

/** Ask for the account's deletion (a fresh proof first): scheduled after the cooling-off period. */
export async function scheduleDeletion(member: Member): Promise<void> {
  const elevated = await member.api.post("/api/v1/session/elevation", {
    headers: CLIENT_HEADERS,
    data: { password: PASSWORD },
  });
  expect(elevated.status(), `elevate: ${await elevated.text()}`).toBe(200);
  const requested = await member.api.post("/api/v1/account/deletion", { headers: CLIENT_HEADERS });
  expect(requested.status(), `request deletion: ${await requested.text()}`).toBe(202);
}

/**
 * A staff access token for `persona` without a browser (clean-up after a spec): the console's
 * own flow, authorisation code with PKCE as `webflix-admin`, against the development issuer.
 */
export async function staffToken(persona: StaffPersona): Promise<string> {
  const { createHash, randomBytes } = await import("node:crypto");
  const origin = new URL(ADMIN_URL).origin;
  const api = await playwrightRequest.newContext({ baseURL: origin });
  try {
    const discovery = (await (
      await api.get("/dev-idp/staff/.well-known/openid-configuration")
    ).json()) as { authorization_endpoint: string; token_endpoint: string };
    const verifier = randomBytes(32).toString("base64url");
    const redirectUri = `${origin}${new URL(ADMIN_URL).pathname}auth/callback`;
    const authorize = new URL(discovery.authorization_endpoint);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: "webflix-admin",
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state: randomBytes(16).toString("base64url"),
      nonce: randomBytes(16).toString("base64url"),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "login",
    })) {
      authorize.searchParams.set(name, value);
    }
    const page = await (await api.get(authorize.href, { maxRedirects: 0 })).text();
    const form =
      /<form method="post" action="([^"]*)"[^>]*data-dev-idp="sign-in"[^>]*>([\s\S]*?)<\/form>/.exec(
        page,
      );
    if (!form) throw new Error("the staff issuer did not show its sign-in page");
    const decodeHtml = (value: string) =>
      value
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    const fields = new URLSearchParams();
    for (const input of (form[2] ?? "").matchAll(
      /<input type="hidden" name="([^"]*)" value="([^"]*)">/g,
    )) {
      fields.append(decodeHtml(input[1] ?? ""), decodeHtml(input[2] ?? ""));
    }
    fields.set("action", "continue");
    fields.set("persona", persona);
    const answer = await api.post(decodeHtml(form[1] ?? ""), {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: fields.toString(),
      maxRedirects: 0,
    });
    const code = new URL(answer.headers().location ?? "", origin).searchParams.get("code");
    if (!code) throw new Error(`the staff issuer returned no code (${answer.status()})`);
    const token = await api.post(discovery.token_endpoint, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: "webflix-admin",
        code_verifier: verifier,
      }).toString(),
    });
    const json = (await token.json()) as { access_token?: string };
    if (!json.access_token) throw new Error(`the token endpoint refused (${token.status()})`);
    return json.access_token;
  } finally {
    await api.dispose();
  }
}

/** Call the staff API as `persona` (clean-up): `method path` with an optional JSON body. */
export async function staffCall(
  persona: StaffPersona,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const token = await staffToken(persona);
  const api = await playwrightRequest.newContext({ baseURL: new URL(ADMIN_URL).origin });
  try {
    const response = await api.fetch(`/api/admin/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Webflix-Client": "web",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await response.text();
    return { status: response.status(), json: text ? (JSON.parse(text) as unknown) : null };
  } finally {
    await api.dispose();
  }
}
