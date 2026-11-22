import { createAccount } from "./api.ts";
import {
  browsePageResponse,
  cardOf,
  describeEvents,
  eventsUntil,
  expectedPlaces,
  grantConsent,
  type StoredEvent,
} from "./browse-personal-support.ts";
import { pointAt, previewOf, row, visibleCards } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The positions the web reports are the whole value of its behaviour data: the ranker's
 * correction for position bias credits an impression only when a title-open with the same
 * `rowRank` and `rank` follows it (services/recs/README.md, "Dataset rules"). These specs load a
 * known page from the server, browse it the way people do (a scroll, a hover, a click), read
 * back what the server received through the dev API's diagnostics route, and hold every
 * reported position against what was on screen.
 *
 * They need a deployment with the diagnostics surface (`WEBFLIX_ENV` other than production) and
 * consent that can be granted (any mode but `off`). The exploration spec also needs
 * `WEBFLIX_RECS_EXPLORE_SHARE=1` (local deployments default to 0): it skips with that reason
 * otherwise.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** Cards per page at this width (the 2/3/4/5/6 scale: six from 1400 px). */
const PER_PAGE = 6;

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at position ${index + 1}`);
  return item;
}

function impressions(events: StoredEvent[]): StoredEvent[] {
  return events.filter((event) => event.type === "impression");
}

test("impressions and the title-open that follows carry the place the member saw", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const account = await createAccount(request, { tag: "ranks", profileName: "Robin" });
  await grantConsent(request);

  const served = browsePageResponse(page);
  await page.goto("/browse");
  const server = await served;
  const places = expectedPlaces(server);
  const policy = server.policy ?? null;
  expect(server.billboard, "a home page with a billboard").not.toBeNull();

  // The page on screen is the server's, in its order: module numbers start after the billboard.
  const drawn = page.locator("[data-row-rank]");
  await expect(drawn.first()).toBeVisible();
  const firstRows = [...places.values()].slice(0, 4);
  for (const [index, { row: serverRow, rowRank }] of firstRows.entries()) {
    await expect(drawn.nth(index)).toHaveAttribute("data-row-rank", String(rowRank));
    await expect(
      drawn.nth(index).locator(`section[aria-roledescription="carousel"]`),
    ).toHaveAttribute("id", `row-${serverRow.id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`);
  }

  // A second with the top of the page in view, then a scroll to the fourth row.
  await page.waitForTimeout(1500);
  const target = firstRows[3];
  if (!target) throw new Error("the home page has fewer than four rows");
  const targetRow = page.locator(`#row-${target.row.id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`);
  await targetRow.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -200));
  await page.waitForTimeout(1600);

  // Hover the third card of that row, then open its details from the preview.
  const card = visibleCards(targetRow).nth(2);
  await pointAt(page, card);
  await expect(previewOf(page)).toBeVisible();
  await previewOf(page)
    .getByRole("button", { name: /^More info about/ })
    .click();
  await expect(page.getByTestId("title-overlay")).toBeVisible();
  const openedId = cardOf(itemAt(target.row.items, 2)).id;

  const events = await eventsUntil(request, account.profileId, (all) =>
    all.some((event) => event.type === "title.open"),
  );
  const shown = impressions(events);
  const log = describeEvents(events);

  // Every impression: the home surface, the page's policy, a place that was on screen.
  expect(shown.length, log).toBeGreaterThan(3);
  for (const event of shown) {
    expect(event.context.surface, log).toBe("home");
    expect(event.context.policy, log).toEqual(policy);
    if (event.context.rowId === "home:billboard") {
      expect([event.context.rowRank, event.context.rank], log).toEqual([1, 1]);
      expect(event.payload.titleId, log).toBe(server.billboard?.title.id);
      continue;
    }
    const place = places.get(event.context.rowId ?? "");
    expect(place, `an impression on a row the page did not have\n${log}`).toBeDefined();
    if (!place) continue;
    expect(event.context.rowRank, log).toBe(place.rowRank);
    const rank = event.context.rank ?? 0;
    // Only cards of the page that was showing (the peeking next card is less than half shown).
    expect(rank, log).toBeGreaterThanOrEqual(1);
    expect(rank, log).toBeLessThanOrEqual(PER_PAGE);
    const item = place.row.items[rank - 1];
    expect(item && cardOf(item).id, `the card at rank ${rank} of ${place.row.id}\n${log}`).toBe(
      event.payload.titleId,
    );
  }
  // The billboard, the first row and the row scrolled to were all seen; nothing twice.
  expect(
    shown.some((event) => event.context.rowId === "home:billboard"),
    log,
  ).toBe(true);
  expect(
    shown.some((event) => event.context.rowRank === firstRows[0]?.rowRank),
    log,
  ).toBe(true);
  expect(
    shown.some((event) => event.context.rowId === target.row.id),
    log,
  ).toBe(true);
  const keys = shown.map((event) => `${event.context.rowId}#${event.context.rank}`);
  expect(new Set(keys).size, `an impression counted twice\n${log}`).toBe(keys.length);

  // The open: that exact card, its place, after its impression.
  const opens = events.filter((event) => event.type === "title.open");
  expect(opens, log).toHaveLength(1);
  const open = opens[0] as StoredEvent;
  expect(open.payload.titleId, log).toBe(openedId);
  expect(open.context, log).toMatchObject({
    surface: "home",
    rowId: target.row.id,
    rowRank: target.rowRank,
    rank: 3,
    policy,
  });
  const before = shown.find(
    (event) =>
      event.context.rowId === target.row.id &&
      event.context.rank === 3 &&
      event.payload.titleId === openedId,
  );
  expect(before, `the opened card's impression\n${log}`).toBeDefined();
  expect((before as StoredEvent).occurredAt <= open.occurredAt, log).toBe(true);

  // Row views: one per row seen, with the kind and place the page gave it.
  for (const event of events.filter((candidate) => candidate.type === "row.view")) {
    if (event.payload.rowKind === "billboard") {
      expect(event.context, log).toMatchObject({ rowId: "home:billboard", rowRank: 1 });
      continue;
    }
    const place = places.get(event.context.rowId ?? "");
    expect(place, log).toBeDefined();
    expect(event.payload.rowKind, log).toBe(place?.row.kind);
    expect(event.context.rowRank, log).toBe(place?.rowRank);
    expect(event.context.rank, log).toBeNull();
  }
});

test("a card that leaves the screen and comes back is a new appearance; one that stays is not", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const account = await createAccount(request, { tag: "appearances" });
  await grantConsent(request);
  const served = browsePageResponse(page);
  await page.goto("/browse");
  const server = await served;
  await expect(page.getByRole("region", { name: /^Featured: / })).toBeVisible();
  const billboardId = server.billboard?.title.id;

  // Seen, then re-rendered in place (a hover, a preview, a second's wait): one appearance.
  await page.waitForTimeout(1500);
  await page.mouse.move(700, 300, { steps: 3 });
  await page.waitForTimeout(800);
  // Scrolled away entirely, then back: a second appearance.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);

  const events = await eventsUntil(
    request,
    account.profileId,
    (all) =>
      impressions(all).filter((event) => event.context.rowId === "home:billboard").length >= 2,
  );
  const billboardSeen = impressions(events).filter(
    (event) => event.context.rowId === "home:billboard",
  );
  expect(billboardSeen.map((event) => event.payload.titleId)).toEqual([billboardId, billboardId]);
  // Two appearances, so two views of the module, never more.
  const views = events.filter(
    (event) => event.type === "row.view" && event.payload.rowKind === "billboard",
  );
  expect(views.length, describeEvents(events)).toBe(2);
});

test("on an exploration page the order shown and the ranks reported agree", async ({ page }) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const account = await createAccount(request, { tag: "explore" });
  await grantConsent(request);
  const served = browsePageResponse(page);
  await page.goto("/browse");
  const server = await served;
  test.skip(
    !server.policy?.explore,
    "this deployment shows no exploration pages: start the API with WEBFLIX_RECS_EXPLORE_SHARE=1 (local modes default to 0)",
  );
  const places = expectedPlaces(server);

  // Every module is where the (shuffled) page put it, and every card in its row's order.
  const drawn = page.locator("[data-row-rank]");
  await expect(drawn.first()).toBeVisible();
  const firstRows = [...places.values()].slice(0, 3);
  for (const [index, { row: serverRow, rowRank }] of firstRows.entries()) {
    const element = drawn.nth(index);
    await expect(element).toHaveAttribute("data-row-rank", String(rowRank));
    const names = await visibleCards(element)
      .locator("a")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    const expected = serverRow.items.slice(0, names.length).map((item) => cardOf(item).id);
    expect(names.map((href) => new URL(href ?? "", "http://x").searchParams.get("title"))).toEqual(
      expected,
    );
  }

  // Open the second card of the first row from the keyboard.
  await page.waitForTimeout(1500);
  const first = firstRows[0];
  if (!first) throw new Error("no rows");
  const firstRow = page.locator(`#row-${first.row.id.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`);
  await visibleCards(firstRow).first().locator("a").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("title-overlay")).toBeVisible();

  const events = await eventsUntil(request, account.profileId, (all) =>
    all.some((event) => event.type === "title.open"),
  );
  const log = describeEvents(events);
  for (const event of impressions(events)) {
    expect(event.context.policy, log).toEqual(server.policy);
    if (event.context.rowId === "home:billboard") continue;
    const place = places.get(event.context.rowId ?? "");
    expect(event.context.rowRank, log).toBe(place?.rowRank);
    const item = place?.row.items[(event.context.rank ?? 0) - 1];
    expect(item && cardOf(item).id, log).toBe(event.payload.titleId);
  }
  const open = events.find((event) => event.type === "title.open");
  expect(open?.context, log).toMatchObject({
    rowId: first.row.id,
    rowRank: first.rowRank,
    rank: 2,
    policy: server.policy,
  });
  expect(open?.payload.titleId).toBe(cardOf(itemAt(first.row.items, 1)).id);
});

test("search reports its query's length and the result opened, never the text", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const account = await createAccount(request, { tag: "search-events" });
  await grantConsent(request);
  const served = browsePageResponse(page);
  await page.goto("/browse");
  const server = await served;
  // A genre the page has a row for: plenty of results.
  const genreRow = server.rows.find((candidate) => candidate.kind === "genre");
  if (!genreRow) throw new Error("the home page has no genre row");
  const query = genreRow.title;

  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("searchbox", { name: /Search titles/ }).fill(query);
  await expect(page).toHaveURL(/\/search\?q=/);
  const results = page.getByRole("list", { name: /^Results for/ });
  await expect(results.getByRole("link").first()).toBeVisible();
  await results.getByRole("link").nth(1).click();
  await expect(page.getByTestId("title-overlay")).toBeVisible();

  const events = await eventsUntil(request, account.profileId, (all) =>
    all.some((event) => event.type === "title.open"),
  );
  const log = describeEvents(events);
  expect(JSON.stringify(events).toLowerCase(), "the query text reached the server").not.toContain(
    query.toLowerCase(),
  );
  const searched = events.filter((event) => event.type === "search.query");
  expect(searched.length, log).toBeGreaterThanOrEqual(1);
  expect(searched.at(-1)?.payload.queryLength).toBe(Array.from(query).length);
  expect(searched.at(-1)?.payload.resultCount as number).toBeGreaterThan(1);
  const click = events.find((event) => event.type === "search.click");
  expect(click?.payload, log).toMatchObject({
    resultRank: 2,
    queryLength: Array.from(query).length,
  });
  const open = events.find((event) => event.type === "title.open");
  expect(open?.context, log).toMatchObject({ surface: "search", rank: 2, rowRank: null });
  expect(open?.payload.titleId).toBe(click?.payload.titleId);
});

test("a list change made in a card's preview reports the card's place", async ({ page }) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  const account = await createAccount(request, { tag: "list-events" });
  await grantConsent(request);
  const served = browsePageResponse(page);
  await page.goto("/browse");
  const server = await served;
  const places = expectedPlaces(server);
  const first = [...places.values()][0];
  if (!first) throw new Error("no rows");
  const slider = row(page, first.row.title);
  await expect(slider).toBeVisible();
  await page.waitForTimeout(600);
  await pointAt(page, visibleCards(slider).nth(1));
  await expect(previewOf(page)).toBeVisible();
  await previewOf(page)
    .getByRole("button", { name: /^Add .* to My List$/ })
    .click();

  const events = await eventsUntil(request, account.profileId, (all) =>
    all.some((event) => event.type === "list.add"),
  );
  const add = events.find((event) => event.type === "list.add");
  expect(add?.payload.titleId).toBe(cardOf(itemAt(first.row.items, 1)).id);
  expect(add?.context, describeEvents(events)).toMatchObject({
    surface: "home",
    rowId: first.row.id,
    rowRank: first.rowRank,
    rank: 2,
    policy: server.policy ?? null,
  });
});

test("a preview's clip reports its start and its end, from the card's place", async ({ page }) => {
  test.setTimeout(120_000);
  const request = page.context().request;
  const account = await createAccount(request, { tag: "preview-events" });
  await grantConsent(request);
  const served = browsePageResponse(page);
  await page.goto("/browse");
  const server = await served;
  // A card on a row's first page whose preview is a clip of the title (most previews are motion
  // art, which keeps its still in a card).
  let target: { rowId: string; rowRank: number; rank: number; titleId: string } | null = null;
  for (const { row: candidate, rowRank } of expectedPlaces(server).values()) {
    const index = candidate.items
      .slice(0, PER_PAGE)
      .findIndex((item) => cardOf(item).preview?.kind === "footage");
    const item = candidate.items[index];
    if (index >= 0 && item) {
      target = { rowId: candidate.id, rowRank, rank: index + 1, titleId: cardOf(item).id };
      break;
    }
  }
  test.skip(!target, "no card with a footage preview on the first rows (content without clips)");
  if (!target) return;

  // The billboard's own clip, when it has one, reports from module 1.
  const billboardClip = server.billboard?.title.preview ?? null;
  if (billboardClip) {
    await eventsUntil(request, account.profileId, (all) =>
      all.some(
        (event) => event.type === "preview.start" && event.context.rowId === "home:billboard",
      ),
    );
  }

  const slider = page.locator(`#row-${target.rowId.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`);
  await slider.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  await page.waitForTimeout(700);
  await pointAt(page, visibleCards(slider).nth(target.rank - 1));
  await expect(previewOf(page)).toHaveAttribute("data-title-id", target.titleId);
  // Wait for the clip to play, then take it to its last moments: it ends as it would.
  const video = previewOf(page).locator("video");
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  await video.evaluate((element: HTMLVideoElement) => {
    element.currentTime = Math.max(0, element.duration - 0.4);
  });
  const events = await eventsUntil(request, account.profileId, (all) =>
    all.some((event) => event.type === "preview.complete"),
  );
  const log = describeEvents(events);
  const place = {
    surface: "home",
    rowId: target.rowId,
    rowRank: target.rowRank,
    rank: target.rank,
    policy: server.policy ?? null,
  };
  const start = events.find(
    (event) => event.type === "preview.start" && event.payload.titleId === target?.titleId,
  );
  expect(start?.context, log).toMatchObject(place);
  const complete = events.find((event) => event.type === "preview.complete");
  expect(complete?.payload.titleId, log).toBe(target.titleId);
  expect(complete?.context, log).toMatchObject(place);
  expect(complete?.payload.watchedSec as number, log).toBeGreaterThan(0);
  expect((start as StoredEvent).occurredAt <= (complete as StoredEvent).occurredAt).toBe(true);
  if (billboardClip) {
    const billboard = events.find(
      (event) => event.type === "preview.start" && event.context.rowId === "home:billboard",
    );
    expect(billboard?.payload.titleId, log).toBe(server.billboard?.title.id);
    expect(billboard?.context, log).toMatchObject({ rowRank: 1, rank: 1, surface: "home" });
  }
});
