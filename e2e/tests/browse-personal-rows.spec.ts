import type { APIRequestContext, Page } from "@playwright/test";
import { CLIENT_HEADERS, createAccount, createProfile, selectProfile } from "./api.ts";
import {
  browsePageResponse,
  cardOf,
  expectedPlaces,
  type ServerPage,
} from "./browse-personal-support.ts";
import { row, visibleCards } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/**
 * What the server now sends the home page, presented so it belongs: the personal row, curated
 * collections, titles staff made unavailable, and the pages the rule engine builds when there is
 * no model for the profile (a new profile, a kids profile, no run imported, the store slow).
 *
 * The personal row needs a recommendation run imported that holds the demo profile Alex (the
 * spec skips without one); the collection and availability specs need the development staff
 * issuer (they skip without it) and put back what they change.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** A staff access token from the development issuer's job client (dev deployments only). */
async function staffToken(request: APIRequestContext): Promise<string | null> {
  const response = await request.post("/dev-idp/staff/token", {
    headers: {
      Authorization: `Basic ${Buffer.from("webflix-jobs:dev-only-jobs-client-secret").toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    data: "grant_type=client_credentials",
  });
  if (!response.ok()) return null;
  return ((await response.json()) as { access_token?: string }).access_token ?? null;
}

function staffHeaders(token: string) {
  return { ...CLIENT_HEADERS, Authorization: `Bearer ${token}` };
}

/** Distinct title ids the profile can see, from genre pages (beyond any one row). */
async function titleIds(request: APIRequestContext, count: number): Promise<string[]> {
  const genres = (await (await request.get("/api/v1/genres")).json()) as {
    items: Array<{ slug: string }>;
  };
  const ids: string[] = [];
  for (const genre of genres.items) {
    const page = (await (await request.get(`/api/v1/browse/genre/${genre.slug}`)).json()) as {
      items?: Array<{ id: string }>;
    };
    for (const item of page.items ?? []) if (!ids.includes(item.id)) ids.push(item.id);
    if (ids.length >= count) break;
  }
  return ids.slice(0, count);
}

function sliderOf(page: Page, rowId: string) {
  return page.locator(`#row-${rowId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`);
}

test.describe("the demo profile Alex", () => {
  test.use({ demo: "Alex" });

  test("the personal row carries the profile's picture beside the server's title", async ({
    page,
  }) => {
    const served = browsePageResponse(page);
    await page.goto("/browse");
    const server = await served;
    const picks = server.rows.find((candidate) => candidate.kind === "top-picks");
    test.skip(
      !picks,
      "no Top Picks for Alex: import a recommendation run that holds this profile (services/recs, node apps/api/src/recs.ts import)",
    );
    if (!picks) return;
    // A trained run's page, or the demo run's (docs/RECOMMENDATIONS.md, "A demo run").
    expect(server.policy?.id).toMatch(/^(learned|demo):/);
    await expect(page.locator("main")).toHaveAttribute("data-policy", server.policy?.id ?? "");

    const slider = row(page, picks.title);
    await expect(slider).toBeVisible();
    // Named exactly as the server titled it; the picture is decoration beside it.
    await expect(slider).toHaveAccessibleName(picks.title);
    const heading = slider.getByRole("heading", { level: 2 });
    await expect(heading.locator('[aria-hidden="true"]').first()).toBeVisible();
    // In the model's order.
    const hrefs = await visibleCards(slider)
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    expect(hrefs.map((href) => new URL(href, "http://x").searchParams.get("title"))).toEqual(
      picks.items.slice(0, hrefs.length).map((item) => cardOf(item).id),
    );
    // Where the server put it: right after Continue Watching when there is one.
    const places = expectedPlaces(server);
    await expect(page.locator('[data-row-kind="top-picks"]')).toHaveAttribute(
      "data-row-rank",
      String(places.get(picks.id)?.rowRank),
    );
  });
});

test("a curated collection reads as one, in its curated order; withdrawn, its row just ends", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const token = await staffToken(request);
  test.skip(!token, "no development staff issuer here (WEBFLIX_ENV production or a real issuer)");
  if (!token) return;
  await createAccount(request, { tag: "collection" });
  const ids = await titleIds(request, 26);
  expect(ids.length).toBeGreaterThan(20);
  const name = `Editors' picks ${Date.now().toString(36)}`;
  const created = await request.post("/api/admin/v1/editorial/collections", {
    headers: staffHeaders(token),
    data: {
      name,
      description: "A browser spec's collection",
      view: "home",
      position: 3,
      titleIds: ids,
      status: "published",
      reason: "e2e: a curated row to present",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const collection = (await created.json()) as { id: string };
  const rowId = `home:collection:${collection.id}`;
  let withdrawn = false;
  try {
    const served = browsePageResponse(page);
    await page.goto("/browse");
    const server: ServerPage = await served;
    const curated = server.rows.find((candidate) => candidate.id === rowId);
    expect(curated, "the published collection is a row of the page").toBeDefined();
    if (!curated) return;

    const slider = sliderOf(page, rowId);
    await slider.scrollIntoViewIfNeeded();
    await expect(slider.getByTestId("collection-mark")).toHaveText(/Collection/);
    await expect(slider).toHaveAccessibleName(`Collection: ${name}`);
    const hrefs = await visibleCards(slider)
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    const shown = hrefs.map((href) => new URL(href, "http://x").searchParams.get("title"));
    expect(shown).toEqual(curated.items.slice(0, shown.length).map((item) => cardOf(item).id));
    // The curated order is the editors' (what the rules allow of it).
    expect(
      shown.every(
        (id, index) => index === 0 || ids.indexOf(id ?? "") > ids.indexOf(shown[index - 1] ?? ""),
      ),
    ).toBe(true);

    // Staff withdraw it while it is on screen; paging on past its first page asks for a row
    // that is gone. The row stops where it is, and nothing about it is reported as an error.
    const deleted = await request.delete(`/api/admin/v1/editorial/collections/${collection.id}`, {
      headers: staffHeaders(token),
      data: { reason: "e2e: withdrawn while shown" },
    });
    expect(deleted.status(), await deleted.text()).toBeLessThan(300);
    withdrawn = true;
    const gone = page.waitForResponse((response) => {
      const path = decodeURIComponent(new URL(response.url()).pathname);
      return path === `/api/v1/browse/rows/${rowId}`;
    });
    await slider.hover();
    const next = slider.getByRole("button", { name: "More titles" });
    for (let step = 0; step < 3; step += 1) {
      await next.click();
      await expect(slider).toHaveAttribute("data-state", "idle");
    }
    expect((await gone).status()).toBe(404);
    await page.waitForTimeout(600);
    // No toast about it (the not-found copy), and the row keeps what it showed.
    await expect(page.getByText("This page or title isn't available.")).toHaveCount(0);
    await expect(visibleCards(slider).first()).toBeVisible();

    // The next visit has no such row, and no empty one in its place.
    const again = browsePageResponse(page);
    await page.reload();
    const after = await again;
    expect(after.rows.some((candidate) => candidate.id === rowId)).toBe(false);
    await expect(page.locator("[data-row-kind]").first()).toBeVisible();
    await expect(sliderOf(page, rowId)).toHaveCount(0);
  } finally {
    if (!withdrawn) {
      await request.delete(`/api/admin/v1/editorial/collections/${collection.id}`, {
        headers: staffHeaders(token),
        data: { reason: "e2e: clean up" },
      });
    }
  }
});

test("a title staff made unavailable leaves browse, and a link to it says so plainly", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const token = await staffToken(request);
  test.skip(!token, "no development staff issuer here (WEBFLIX_ENV production or a real issuer)");
  if (!token) return;
  await createAccount(request, { tag: "unavailable" });
  // A title from deep in the catalogue, so other specs' pages are not disturbed.
  const candidates = await titleIds(request, 60);
  const titleId = candidates.at(-1);
  if (!titleId) throw new Error("no titles");
  const set = (available: boolean) =>
    request.put(`/api/admin/v1/titles/${titleId}/availability`, {
      headers: staffHeaders(token),
      data: { available, reason: available ? "e2e: put back" : "e2e: withdrawn" },
    });
  expect((await set(false)).status()).toBeLessThan(300);
  try {
    // Gone from what the server answers, and its link answers not_found.
    await expect
      .poll(async () => (await request.get(`/api/v1/titles/${titleId}`)).status())
      .toBe(404);
    const home = (await (await request.get("/api/v1/browse?view=home")).json()) as ServerPage;
    expect(JSON.stringify(home)).not.toContain(`"${titleId}"`);

    await page.goto(`/browse?title=${titleId}`);
    const overlay = page.getByTestId("title-overlay");
    await expect(overlay.getByText("This title isn't available")).toBeVisible();
    await expect(overlay.getByText(/It may have left Webflix/)).toBeVisible();
    const back = overlay.getByRole("button", { name: "Back to browsing" });
    await expect(back).toBeVisible();
    await back.click();
    await expect(overlay).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Featured: / })).toBeVisible();
    await expect(page).not.toHaveURL(/title=/);
  } finally {
    await set(true);
  }
});

test("with no model for the profile, the rule engine's page: no personal row, no empty row, nothing left loading", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  await createAccount(request, { tag: "cold-start", profileName: "Noor" });
  const kidsId = await createProfile(request, { name: "Pip", isKids: true });

  // The store slow: the page takes a while to come, its skeletons hold the place meanwhile.
  await page.route(/\/api\/v1\/browse\?/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  for (const who of ["new", "kids"] as const) {
    if (who === "kids") await selectProfile(request, kidsId);
    const served = browsePageResponse(page);
    await page.goto("/browse");
    await expect(page.locator("main[aria-busy='true']")).toBeVisible();
    const server = await served;
    expect(server.policy?.id, `${who}: the rule engine's page`).toBe("rules");
    expect(server.rows.some((candidate) => candidate.kind === "top-picks")).toBe(false);
    await expect(page.locator("[data-row-kind]").first()).toBeVisible();
    await expect(page.locator('[data-row-kind="top-picks"]')).toHaveCount(0);
    if (who === "kids") await expect(page.getByTestId("kids-greeting")).toBeVisible();

    // Down to the end of the page: every row drawn has cards, and no placeholder stays.
    for (let step = 0; step < 30; step += 1) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(80);
    }
    await expect(page.locator("main [aria-busy='true']")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator("main[aria-busy='true']")).toHaveCount(0);
    const rows = page.locator("[data-row-kind]");
    const count = await rows.count();
    expect(count).toBeGreaterThan(3);
    for (let index = 0; index < count; index += 1) {
      await expect(rows.nth(index).locator("li.wf-slider__item a").first()).toBeAttached();
    }
  }
});

test("a change of experiment assignment is never served a page cached under the old one", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const request = page.context().request;
  const token = await staffToken(request);
  test.skip(!token, "no development staff issuer here (WEBFLIX_ENV production or a real issuer)");
  if (!token) return;
  await createAccount(request, { tag: "assignment" });
  // The page's clock is the test's: the session goes stale (five minutes) while a page cached
  // a minute earlier is still fresh (two), the moment that tells the two apart.
  await page.clock.install();
  const seriesPages: string[] = [];
  page.on("request", (sent) => {
    const url = new URL(sent.url());
    if (url.pathname === "/api/v1/browse" && url.searchParams.get("view") === "series") {
      if (!url.searchParams.has("cursor")) seriesPages.push(sent.url());
    }
  });
  await page.goto("/browse");
  await expect(page.locator("[data-row-kind]").first()).toBeVisible();

  // An experiment of its own, in a layer of its own, for every profile.
  const key = `e2e-browse-${Date.now().toString(36)}`;
  const definition = {
    key,
    name: `Browse cache check ${key}`,
    description: "Created by a browser spec; completed when it ends.",
    unit: "profile",
    layer: key,
    allocation: { start: 0, end: 10_000 },
    targeting: { percentage: 100, plans: [], countries: [], audience: "all" },
    variants: [
      { name: "control", weight: 1 },
      { name: "treatment", weight: 1 },
    ],
    control: "control",
    primaryMetric: "qualified_plays",
    secondaryMetrics: [],
    alpha: 0.05,
    power: 0.8,
    minimumDetectableEffect: 0.05,
    startsAt: null,
    endsAt: null,
    srmThreshold: 0.001,
    reason: "e2e: an assignment change for the browse cache",
  };
  const created = await request.post("/api/admin/v1/experiments", {
    headers: staffHeaders(token),
    data: definition,
  });
  expect(created.status(), await created.text()).toBe(201);
  try {
    const started = await request.put(`/api/admin/v1/experiments/${key}/status`, {
      headers: staffHeaders(token),
      data: { status: "running", reason: "e2e: start" },
    });
    expect(started.status(), await started.text()).toBe(200);
    // Live from the instant the staff API states (at once in dev; a minute ahead elsewhere).
    const { statusChangeAt } = (await started.json()) as { statusChangeAt: string | null };
    const liveIn = statusChangeAt ? Date.parse(statusChangeAt) - Date.now() + 2000 : 0;
    if (liveIn > 0) {
      test.setTimeout(120_000 + liveIn);
      await new Promise((resolve) => setTimeout(resolve, liveIn));
    }
    // An instance reads the definitions again within 30 s: the assignment arrives by then.
    let variant: string | undefined;
    await expect
      .poll(
        async () => {
          const state = (await (await request.get("/api/v1/session")).json()) as {
            experiments?: Record<string, string>;
          };
          variant = state.experiments?.[key];
          return variant;
        },
        { timeout: 40_000, intervals: [500, 1000, 2000] },
      )
      .toBeTruthy();

    // Four minutes on, Series is visited (cached now); a minute later the session is stale.
    await page.clock.fastForward("04:00");
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Series" })
      .click();
    await expect(page).toHaveURL(/\/browse\/series$/);
    await expect(page.locator("[data-row-kind]").first()).toBeVisible();
    expect(seriesPages).toHaveLength(1);
    await page.clock.fastForward("01:05");

    // Back to the tab: the stale session is read again and brings the assignment. The Series
    // page cached a minute ago is still fresh, yet it was made under the old assignment: it is
    // fetched again, not shown from the cache.
    const session = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/session",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    const refreshed = (await (await session).json()) as { experiments?: Record<string, string> };
    expect(refreshed.experiments?.[key]).toBe(variant);
    await expect.poll(() => seriesPages.length).toBe(2);
    await expect(page.locator("[data-row-kind]").first()).toBeVisible();
  } finally {
    await request.put(`/api/admin/v1/experiments/${key}/status`, {
      headers: staffHeaders(token),
      data: { status: "completed", reason: "e2e: done" },
    });
  }
});
