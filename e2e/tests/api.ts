/**
 * The suite's own HTTP helpers: accounts, sign-in and profile selection through the API.
 *
 * Every call that a rate limit can refuse (sign-up and sign-in are limited per client address,
 * profile selection per account) waits out a `429` the way a well-behaved client does, and
 * extends the running test's timeout by that wait. So the suite passes under strict limits
 * (k8s by default) and right after the conformance suite exhausted this address's budget;
 * it just takes longer.
 */
import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
  type Response,
  test,
} from "@playwright/test";

export const CLIENT_HEADERS = { "X-Webflix-Client": "web", "content-type": "application/json" };
export const DEMO = { email: "demo@webflix.dev", password: "webflix-demo" } as const;
export const PASSWORD = "correct horse battery";

/** Give up after this many refusals in a row (a limit that never recovers is a failure). */
const MAX_RATE_LIMIT_RETRIES = 6;

function retryAfterMs(response: APIResponse, body: string): number {
  const header = Number(response.headers()["retry-after"]);
  let seconds = Number.isFinite(header) && header > 0 ? header : Number.NaN;
  if (!Number.isFinite(seconds)) {
    try {
      seconds = Number((JSON.parse(body) as { retryAfterSec?: number }).retryAfterSec);
    } catch {
      seconds = Number.NaN;
    }
  }
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000 + 250;
}

/** Inside a test, give it the time a rate-limit wait costs. Outside one there is no budget. */
function extendTimeout(ms: number): void {
  try {
    const info = test.info();
    if (info.timeout > 0) info.setTimeout(info.timeout + ms);
  } catch {
    // Not inside a test (a script or a worker-scoped fixture): nothing to extend.
  }
}

/** Send a request, waiting out `429 rate_limited` answers (Retry-After) before trying again. */
export async function sendPatiently(
  what: string,
  send: () => Promise<APIResponse>,
): Promise<APIResponse> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send();
    if (response.status() !== 429) return response;
    const body = await response.text();
    if (attempt >= MAX_RATE_LIMIT_RETRIES) {
      throw new Error(`${what}: still rate limited after ${attempt + 1} attempts (${body})`);
    }
    const wait = retryAfterMs(response, body);
    extendTimeout(wait);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export interface TestAccount {
  email: string;
  password: string;
  profileId: string;
}

/** Unique per call and recognisable in server logs: `e2e.<tag>.<time>.<random>@example.com`. */
export function uniqueEmail(tag: string): string {
  return `e2e.${tag}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

export async function signIn(
  request: APIRequestContext,
  credentials: { email: string; password: string },
  profileId?: string,
): Promise<{ profiles: Array<{ id: string; name: string }> }> {
  const response = await sendPatiently("sign in", () =>
    request.post("/api/v1/auth/login", {
      headers: CLIENT_HEADERS,
      data: { ...credentials, rememberMe: true },
    }),
  );
  expect(response.status(), `sign in: ${await response.text()}`).toBe(200);
  const session = (await response.json()) as { profiles: Array<{ id: string; name: string }> };
  if (profileId) await selectProfile(request, profileId);
  return session;
}

export async function selectProfile(
  request: APIRequestContext,
  profileId: string,
  pin?: string,
): Promise<void> {
  const response = await sendPatiently("select profile", () =>
    request.put("/api/v1/session/profile", {
      headers: CLIENT_HEADERS,
      data: pin ? { profileId, pin } : { profileId },
    }),
  );
  expect(response.status(), `select profile: ${await response.text()}`).toBe(200);
}

export async function firstAvatarId(request: APIRequestContext, group = 0): Promise<string> {
  const avatars = (await (await request.get("/api/v1/avatars")).json()) as {
    groups: Array<{ avatars: Array<{ id: string }> }>;
  };
  const id = avatars.groups[group]?.avatars[0]?.id ?? avatars.groups[0]?.avatars[0]?.id;
  if (!id) throw new Error("no avatars");
  return id;
}

export interface ProfileOptions {
  name: string;
  isKids?: boolean;
  settings?: { autoplayNextEpisode?: boolean; autoplayPreviews?: boolean };
}

export async function createProfile(
  request: APIRequestContext,
  options: ProfileOptions,
): Promise<string> {
  const response = await request.post("/api/v1/profiles", {
    headers: CLIENT_HEADERS,
    data: { avatarId: await firstAvatarId(request), ...options },
  });
  expect(response.status(), `create profile: ${await response.text()}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** A new account without a membership, signed in on `request` (sign-up has no card, §5.1). */
export async function signUp(request: APIRequestContext, email: string): Promise<void> {
  const signup = await sendPatiently("sign up", () =>
    request.post("/api/v1/auth/signup", {
      headers: CLIENT_HEADERS,
      data: { email, password: PASSWORD },
    }),
  );
  expect(signup.status(), `sign up: ${await signup.text()}`).toBe(201);
}

/**
 * Makes the signed-in account a member the one way there is (§5.1): a checkout at the payment
 * provider, the card confirmed through the fake provider's JSON form (`/_pay/api/confirm`, what
 * its page does in the browser). The card is one of its own (`visa:<label>`, never had a trial),
 * so the membership starts with the trial and nothing is charged; `active` then moves the
 * account's test clock past the trial, so it is a paying membership (the first renewal paid),
 * like milestone 1's accounts were. HTTP only. Needs the fake provider (outside production).
 */
export async function becomeMember(
  request: APIRequestContext,
  options: { plan?: "basic" | "standard" | "premium"; active?: boolean } = {},
): Promise<void> {
  const start = await sendPatiently("start checkout", () =>
    request.post("/api/v1/billing/checkout", {
      headers: CLIENT_HEADERS,
      data: { planId: options.plan ?? "standard" },
    }),
  );
  expect(start.status(), `start checkout: ${await start.text()}`).toBe(201);
  const started = (await start.json()) as { id: string; clientSecret: string | null };
  const card = `visa:e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const confirmed = await request.post("/_pay/api/confirm", {
    data: { clientSecret: started.clientSecret, card },
  });
  expect(confirmed.status(), `confirm the card at the provider: ${await confirmed.text()}`).toBe(
    200,
  );
  const confirm = await sendPatiently("confirm checkout", () =>
    request.post(`/api/v1/billing/checkout/${started.id}/confirm`, { headers: CLIENT_HEADERS }),
  );
  expect(confirm.status(), `confirm checkout: ${await confirm.text()}`).toBe(200);
  let status = ((await confirm.json()) as { status: string }).status;
  for (let poll = 0; status !== "complete" && poll < 40; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const current = await request.get(`/api/v1/billing/checkout/${started.id}`);
    status = ((await current.json()) as { status: string }).status;
  }
  expect(status, "the checkout completes").toBe("complete");
  if (options.active !== false) {
    // Past the 7-day trial and the renewal's collection an hour later: a paid, active month.
    const advanced = await request.post("/api/v1/diagnostics/billing/clock", {
      headers: CLIENT_HEADERS,
      data: { seconds: 7 * 86_400 + 2 * 3_600 },
    });
    expect(advanced.status(), `advance the test clock: ${await advanced.text()}`).toBe(200);
  }
}

/**
 * A fresh account, signed in on `request`'s cookie jar, a member (an active, paid membership on
 * `plan`, through a provider checkout: `becomeMember`), with one profile selected. Use one for
 * every spec that changes data: nothing it does can reach another spec.
 */
export async function createAccount(
  request: APIRequestContext,
  options: {
    plan?: "basic" | "standard" | "premium";
    profileName?: string;
    profile?: Omit<ProfileOptions, "name">;
    tag?: string;
  } = {},
): Promise<TestAccount> {
  const email = uniqueEmail(options.tag ?? "member");
  await signUp(request, email);
  // At the profile gate: a checkout needs a profile without restrictions or none at all.
  await becomeMember(request, { plan: options.plan ?? "standard" });
  const profileId = await createProfile(request, {
    name: options.profileName ?? "Sam",
    ...options.profile,
  });
  await selectProfile(request, profileId);
  return { email, password: PASSWORD, profileId };
}

export interface CatalogCard {
  id: string;
  name: string;
  type: "movie" | "series";
  maturity: string;
  preview: { kind?: string; hasAudio?: boolean } | null;
}

/**
 * Titles the active profile can see, from the first batch of home rows. Specs pick what they
 * need from here (a rating, a type) instead of hard-coding catalogue ids.
 */
export async function catalogCards(
  request: APIRequestContext,
  view: "home" | "series" | "movies" | "new-popular" = "home",
): Promise<CatalogCard[]> {
  const response = await request.get(`/api/v1/browse?view=${view}`);
  expect(response.status(), `browse: ${await response.text()}`).toBe(200);
  const page = (await response.json()) as {
    billboard: { title: CatalogCard } | null;
    rows: Array<{ items: Array<CatalogCard | { title: CatalogCard }> }>;
  };
  const cards = new Map<string, CatalogCard>();
  if (page.billboard) cards.set(page.billboard.title.id, page.billboard.title);
  for (const row of page.rows) {
    for (const item of row.items) {
      const card = "title" in item ? item.title : item;
      cards.set(card.id, card);
    }
  }
  return [...cards.values()];
}

/** `text` as a literal inside a regular expression (titles can contain `?`, `.`, `(`). */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PlayableTitle extends CatalogCard {
  /** Season 1's episodes, for series. */
  episodes: Array<{ id: string; number: number; name: string }>;
  /** Of the movie, or of season 1 episode 1. */
  durationSec: number;
}

/**
 * A title of `type` whose stream is packaged on this target (a same-origin `/media/` manifest,
 * not the external fallback), found by starting and stopping playback the way the conformance
 * suite does. Never hard-code which title has media: the content pipeline changes that.
 */
export async function findPlayableTitle(
  request: APIRequestContext,
  type: "movie" | "series",
  options: { minEpisodes?: number; minDurationSec?: number } = {},
): Promise<PlayableTitle> {
  const candidates = (await catalogCards(request)).filter((card) => card.type === type);
  for (const card of candidates.slice(0, 12)) {
    let episodes: PlayableTitle["episodes"] = [];
    if (type === "series") {
      const response = await request.get(`/api/v1/titles/${card.id}/seasons/1/episodes`);
      if (!response.ok()) continue;
      episodes = ((await response.json()) as { items: PlayableTitle["episodes"] }).items;
      if (episodes.length < (options.minEpisodes ?? 1)) continue;
    }
    // Starting playback has a per-account budget: a refusal is waited out, like sign-in.
    const start = await sendPatiently("start a probe playback session", () =>
      request.post("/api/v1/playback/sessions", {
        headers: CLIENT_HEADERS,
        data: { titleId: card.id },
      }),
    );
    if (start.status() !== 201) continue;
    const session = (await start.json()) as {
      id: string;
      manifestUrl: string;
      durationSec: number;
    };
    const stop = await request.delete(`/api/v1/playback/sessions/${session.id}`, {
      headers: { "X-Webflix-Client": "web" },
    });
    expect(stop.status(), `stop the probe session: ${await stop.text()}`).toBe(204);
    const longEnough = session.durationSec >= (options.minDurationSec ?? 0);
    if (session.manifestUrl.startsWith("/media/") && longEnough) {
      return { ...card, episodes, durationSec: session.durationSec };
    }
  }
  throw new Error(`no ${type} with packaged media among the first catalogue rows`);
}

/**
 * The response to the next `method` call whose API path matches `path`. Start waiting before the
 * click: optimistic UI updates at once, so the screen alone never says the server has it.
 */
export function apiResponse(page: Page, method: string, path: RegExp): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method && path.test(new URL(response.url()).pathname),
  );
}
