/**
 * Helpers for the billing journeys (docs/BLUEPRINT-M2.md §5) against a running mode whose
 * payment provider is the fake (`/_pay`): accounts created without payment, memberships set up
 * through the provider's JSON confirmation (as the conformance suite does), the account's own
 * test clock, and a watch on every request that could carry card data.
 *
 * Test cards are the fake's (packages/payments-fake `FAKE_CARDS`); a labelled card
 * (`visa:<label>`) behaves like the test card with a fingerprint of its own, so it has never had
 * a trial (one trial per account and per card fingerprint, deployment-wide).
 */
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { CLIENT_HEADERS, firstAvatarId, PASSWORD, sendPatiently, uniqueEmail } from "./api.ts";

export { PASSWORD } from "./api.ts";

/** A card that never had a trial: `<test card>:<unique label>`. */
export function freshCard(card: "visa" | "mastercard" | "charge-declined" | "challenge" = "visa") {
  return `${card}:e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The billing config, or the reason a spec cannot run against this target. */
export async function requireFakeProvider(request: APIRequestContext): Promise<void> {
  const config = (await (await request.get("/api/v1/billing/config")).json()) as {
    provider: string;
  };
  test.skip(
    config.provider !== "fake",
    `the billing journeys drive the fake provider's form; this target's provider is ${config.provider}`,
  );
}

export interface BareAccount {
  email: string;
  password: string;
}

/** A new account, signed in on `request`, with no membership (sign-up step 1 through the API). */
export async function createBareAccount(
  request: APIRequestContext,
  tag: string,
): Promise<BareAccount> {
  const email = uniqueEmail(tag);
  const response = await sendPatiently("sign up", () =>
    request.post("/api/v1/auth/signup", {
      headers: CLIENT_HEADERS,
      data: { email, password: PASSWORD },
    }),
  );
  expect(response.status(), `sign up: ${await response.text()}`).toBe(201);
  return { email, password: PASSWORD };
}

/** One profile, selected (account pages and watching need one). */
export async function addProfile(request: APIRequestContext, name = "Sam"): Promise<string> {
  const response = await request.post("/api/v1/profiles", {
    headers: CLIENT_HEADERS,
    data: { name, avatarId: await firstAvatarId(request) },
  });
  expect(response.status(), `create profile: ${await response.text()}`).toBe(201);
  const id = ((await response.json()) as { id: string }).id;
  const select = await sendPatiently("select profile", () =>
    request.put("/api/v1/session/profile", { headers: CLIENT_HEADERS, data: { profileId: id } }),
  );
  expect(select.status(), `select profile: ${await select.text()}`).toBe(200);
  return id;
}

/** What the provider's form does in the browser, as JSON (packages/payments-fake). */
export async function confirmAtProvider(
  request: APIRequestContext,
  clientSecret: string,
  card?: string,
): Promise<void> {
  const send = (body: object) =>
    request.post("/_pay/api/confirm", { data: { clientSecret, ...body } });
  let outcome = (await (await send(card ? { card } : {})).json()) as { status: string };
  if (outcome.status === "requires_action") {
    outcome = (await (await send({ challenge: "complete" })).json()) as { status: string };
  }
  expect(outcome.status, `the provider's confirmation with ${card ?? "the card on file"}`).toBe(
    "succeeded",
  );
}

interface CheckoutAnswer {
  id: string;
  status: string;
  clientSecret: string | null;
  trial: { days: number } | null;
}

/** A membership through the API (the two-step checkout), as the conformance suite starts one. */
export async function subscribe(
  request: APIRequestContext,
  options: { planId: "basic" | "standard" | "premium"; card: string },
): Promise<CheckoutAnswer> {
  const start = await request.post("/api/v1/billing/checkout", {
    headers: CLIENT_HEADERS,
    data: { planId: options.planId },
  });
  expect(start.status(), `start checkout: ${await start.text()}`).toBe(201);
  const started = (await start.json()) as CheckoutAnswer;
  await confirmAtProvider(request, started.clientSecret ?? "", options.card);
  const confirm = await request.post(`/api/v1/billing/checkout/${started.id}/confirm`, {
    headers: CLIENT_HEADERS,
  });
  expect(confirm.status(), `confirm checkout: ${await confirm.text()}`).toBe(200);
  let checkout = (await confirm.json()) as CheckoutAnswer;
  if (checkout.status === "requires_payment") {
    await confirmAtProvider(request, checkout.clientSecret ?? "");
  }
  await expect
    .poll(
      async () => {
        const current = await request.get(`/api/v1/billing/checkout/${started.id}`);
        checkout = (await current.json()) as CheckoutAnswer;
        return checkout.status;
      },
      { message: "the checkout completes", timeout: 20_000 },
    )
    .toBe("complete");
  return checkout;
}

/** A card whose trial is spent: a throwaway account takes its one trial first. */
export async function spentCard(request: APIRequestContext): Promise<string> {
  const card = freshCard("visa");
  await createBareAccount(request, "spend-trial");
  const checkout = await subscribe(request, { planId: "basic", card });
  expect(checkout.trial, "a card that never had a trial got one").not.toBeNull();
  return card;
}

export interface MembershipView {
  status: string;
  planId: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
}

export async function membershipOf(request: APIRequestContext): Promise<MembershipView> {
  const session = (await (await request.get("/api/v1/session")).json()) as {
    membership: MembershipView;
  };
  return session.membership;
}

/** Move the account's test clock to `extraSec` past `instant` (provider time), never back. */
export async function advancePast(
  request: APIRequestContext,
  instant: string,
  extraSec: number,
): Promise<void> {
  const read = await request.post("/api/v1/diagnostics/billing/clock", {
    headers: CLIENT_HEADERS,
    data: { seconds: 1 },
  });
  expect(read.status(), `read the test clock: ${await read.text()}`).toBe(200);
  const now = Date.parse(((await read.json()) as { now: string }).now);
  const seconds = Math.max(1, Math.ceil((Date.parse(instant) - now) / 1000) + extraSec);
  const moved = await request.post("/api/v1/diagnostics/billing/clock", {
    headers: CLIENT_HEADERS,
    data: { seconds },
  });
  expect(moved.status(), `move the test clock: ${await moved.text()}`).toBe(200);
}

/** Collection happens about an hour after a renewal invoice is drafted. */
export const RENEWAL_SETTLE_SEC = 2 * 3600;

/** The fake provider's test card numbers (Stripe's documented test numbers, docs/STRIPE.md §6). */
const TEST_CARD_NUMBERS = [
  "4242424242424242",
  "5555555555554444",
  "4000000000000002",
  "4000000000009995",
  "4000000000000069",
  "4000000000000127",
  "4000000000000119",
  "4000000000009987",
  "4000000000000341",
  "4000002760003184",
  "4000002500003155",
];

/**
 * Card data may only ever go to the provider: record every request body that carries a test card
 * number, a labelled test card (`visa:e2e-…`) or a card field, with where it went. The fake's form
 * posts `card` and `number`; milestone 1's bodies carried `cardNumber`, `cvc` and the expiry.
 */
export function watchCardData(page: Page): () => Array<{ url: string; body: string }> {
  const seen: Array<{ url: string; body: string }> = [];
  page.context().on("request", (request) => {
    const body = request.postData() ?? "";
    if (!body) return;
    const url = new URL(request.url());
    const decoded = safeDecode(body.replaceAll("+", " "));
    const digits = decoded.replace(/[\s-]/g, "");
    const cardLike =
      TEST_CARD_NUMBERS.some((number) => digits.includes(number)) ||
      /\b[a-z-]+:e2e-\d+/.test(decoded) ||
      /(^|[&{,])\s*"?(card|number|cardNumber|cvc|expMonth|expYear)"?\s*[=:]/.test(body);
    if (cardLike) seen.push({ url: `${url.origin}${url.pathname}`, body: body.slice(0, 200) });
  });
  return () => seen;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every card-carrying request went to the provider's form, none to Webflix's API. */
export function expectCardDataOnlyAtProvider(seen: Array<{ url: string; body: string }>): void {
  const elsewhere = seen.filter((entry) => !new URL(entry.url).pathname.startsWith("/_pay/"));
  expect(elsewhere, "requests carrying card data outside the provider's form").toEqual([]);
}

/** A title the profile can play (the first movie of the home rows). */
export async function aMovie(request: APIRequestContext): Promise<{ id: string; name: string }> {
  const response = await request.get("/api/v1/browse?view=home");
  const page = (await response.json()) as {
    billboard: { title: { id: string; name: string; type: string } } | null;
    rows: Array<{
      items: Array<
        | { id: string; name: string; type: string }
        | { title: { id: string; name: string; type: string } }
      >;
    }>;
  };
  const cards = [
    ...(page.billboard ? [page.billboard.title] : []),
    ...page.rows.flatMap((row) => row.items.map((item) => ("title" in item ? item.title : item))),
  ];
  const movie = cards.find((card) => card.type === "movie");
  if (!movie) throw new Error("no movie in the catalogue");
  return movie;
}

/** Press Tab until `target` has focus (the keyboard alone), failing after a sane number of stops. */
export async function tabTo(page: Page, target: Locator, max = 40): Promise<void> {
  for (let stop = 0; stop < max; stop += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`could not reach ${target} with the Tab key`);
}

/** Ask for the account's deletion through the API (a fresh proof first, as the server needs). */
export async function scheduleDeletion(request: APIRequestContext): Promise<string> {
  const proof = await request.post("/api/v1/session/elevation", {
    headers: CLIENT_HEADERS,
    data: { password: PASSWORD },
  });
  expect(proof.status(), `elevation: ${await proof.text()}`).toBe(200);
  const asked = await request.post("/api/v1/account/deletion", { headers: CLIENT_HEADERS });
  expect(asked.status(), `request deletion: ${await asked.text()}`).toBe(202);
  return ((await asked.json()) as { scheduledFor: string }).scheduledFor;
}
