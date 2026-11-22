import type { Page, Request } from "@playwright/test";
import { apiResponse, escapeRegExp, findPlayableTitle } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import {
  CLIENT_HEADERS,
  createAccount,
  expectAccessible,
  videoState,
  waitForPlayback,
} from "./member-support.ts";

/**
 * The watch page against the real API: session creation, heartbeats, resume, URL handling,
 * episode switches and leaving. Uses packaged media when the API has it (subtitles, markers,
 * trick-play), and the external fallback stream otherwise.
 */

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

function playbackRequests(page: Page) {
  const seen: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/v1/playback/sessions")) return;
    const raw = request.postData();
    seen.push({
      method: request.method(),
      path: url.pathname.replace("/api/v1/playback/sessions", ""),
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    });
  });
  return seen;
}

const seek = (page: Page, seconds: number) =>
  page.evaluate((value) => {
    const video = document.querySelector("video");
    if (video) video.currentTime = value;
  }, seconds);

test("plays, reports progress, and leaving saves the position for Continue Watching", async ({
  page,
}) => {
  await createAccount(page.context().request, { tag: "watch" });
  const movie = await findPlayableTitle(page.context().request, "movie", { minDurationSec: 90 });
  const requests = playbackRequests(page);
  await page.goto("/browse");
  await page.goto(`/watch/${movie.id}?t=40`);
  await waitForPlayback(page, 41);

  // `t` is consumed: the URL now says what is playing, without the start offset.
  await expect(page).toHaveURL(new RegExp(`/watch/${movie.id}$`));
  expect(requests[0]).toMatchObject({
    method: "POST",
    path: "",
    body: { titleId: movie.id, startPositionSec: 40 },
  });

  // Pausing reports right away (no need to wait for the 30 s cadence).
  await page.keyboard.press("k");
  await expect
    .poll(() => requests.some((r) => r.path.endsWith("/heartbeat") && r.body?.state === "paused"))
    .toBe(true);
  await page.keyboard.press("k");
  await waitForPlayback(page, 42);

  // Back to where we came from: one release carries the final position and frees the slot, and
  // nothing is reported for the session after it (a late heartbeat would be refused).
  await page.mouse.move(400, 300);
  await page.getByRole("button", { name: /^Back/ }).first().click();
  await expect(page).toHaveURL(/\/browse/);
  const release = requests.findIndex((r) => r.method === "DELETE");
  expect(release).toBeGreaterThan(-1);
  expect(Number(requests[release]?.body?.positionSec)).toBeGreaterThan(41);
  expect(requests.slice(release + 1).some((r) => r.path.endsWith("/heartbeat"))).toBe(false);

  const continueWatching = await (
    await page.context().request.get("/api/v1/continue-watching")
  ).json();
  expect(continueWatching.items[0].title.id).toBe(movie.id);
  expect(continueWatching.items[0].progress.positionSec).toBeGreaterThan(41);

  // Coming back resumes there.
  await page.goto(`/watch/${movie.id}`);
  await waitForPlayback(page, 1);
  const position = await page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  expect(position).toBeGreaterThan(40);
});

test("series: the episode is written to the URL (replaced, not pushed) and next episode plays", async ({
  page,
}) => {
  await createAccount(page.context().request, { tag: "series" });
  const series = await findPlayableTitle(page.context().request, "series", { minEpisodes: 2 });
  const [first, second] = series.episodes;
  const requests = playbackRequests(page);
  await page.goto("/browse");
  await page.goto(`/watch/${series.id}?t=0`);
  await waitForPlayback(page, 0.3);
  await expect(page).toHaveURL(new RegExp(`/watch/${series.id}\\?episode=${first?.id}$`));
  const length = await page.evaluate(() => history.length);

  // The control bar's Next Episode records this episode's position, then starts the next.
  await page.mouse.move(400, 300);
  await page.getByRole("button", { name: "Next Episode" }).first().click();
  await expect(page).toHaveURL(new RegExp(`episode=${second?.id}$`));
  await waitForPlayback(page, 0.3);
  expect(await page.evaluate(() => history.length)).toBe(length);
  const creates = requests.filter((r) => r.method === "POST" && r.path === "");
  expect(creates.at(-1)?.body).toEqual({ titleId: series.id, episodeId: second?.id });
  const before = requests.indexOf(creates.at(-1) as (typeof requests)[number]);
  expect(requests.slice(0, before).some((r) => r.path.endsWith("/heartbeat"))).toBe(true);

  // Back leaves the watch page entirely (no trail of episodes in history).
  await page.goBack();
  await expect(page).toHaveURL(/\/browse/);
});

test("series: the next episode starts by itself after the countdown (profile autoplay on)", async ({
  page,
}) => {
  await createAccount(page.context().request, { tag: "autoplay" });
  const series = await findPlayableTitle(page.context().request, "series", { minEpisodes: 2 });
  const [first, second] = series.episodes;
  await page.goto(`/watch/${series.id}?episode=${first?.id}&t=0`);
  await waitForPlayback(page, 0.3);
  const session = await (await page.context().request.get("/api/v1/session")).json();
  test.skip(
    !session.activeProfile.settings.autoplayNextEpisode,
    "autoplay is off for this profile",
  );
  const duration = await page.evaluate(() => document.querySelector("video")?.duration ?? 0);
  await seek(page, Math.max(0, duration - 8));
  await expect(page).toHaveURL(new RegExp(`episode=${second?.id}$`), { timeout: 30_000 });
  await waitForPlayback(page, 0.3);
});

test("the episodes panel switches episodes in place", async ({ page }) => {
  await createAccount(page.context().request, { tag: "panel" });
  const series = await findPlayableTitle(page.context().request, "series", { minEpisodes: 3 });
  const [first, , third] = series.episodes;
  if (!first || !third) throw new Error("a series with three episodes");
  await page.goto(`/watch/${series.id}?episode=${first.id}&t=0`);
  await waitForPlayback(page, 0.3);
  await page.mouse.move(400, 300);
  await page.getByRole("button", { name: "Episodes" }).click();
  const panel = page.getByRole("dialog", { name: /Episodes|Season/ });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: new RegExp(escapeRegExp(third.name)) }).click();
  await expect(page).toHaveURL(new RegExp(`episode=${third.id}$`));
  await waitForPlayback(page, 0.3);
});

/** The post-play moment's lead recommendation (named by the recommended title). */
const leadOf = (page: Page) =>
  page
    .getByRole("region")
    .filter({ has: page.getByRole("button", { name: /^Play / }) })
    .filter({ hasNot: page.getByRole("region") });

test("a film's post-play leads with one recommendation, then ratings and more; picking one replaces history", async ({
  page,
}) => {
  await createAccount(page.context().request, { tag: "endscreen" });
  const movie = await findPlayableTitle(page.context().request, "movie");
  await page.goto("/browse");
  await page.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(page, 0.5);
  const duration = await page.evaluate(() => document.querySelector("video")?.duration ?? 0);
  await seek(page, Math.max(0, duration - 3));

  // The lead: artwork, name, a line of synopsis, and a countdown the member can stop.
  const lead = leadOf(page);
  try {
    await expect(lead).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    // Say what the video was doing: a stuck seek, a stall with data, or just slow.
    throw new Error(
      `${(error as Error).message}\nvideo element: ${JSON.stringify(await videoState(page))}`,
    );
  }
  await expect(lead.getByText(/^Starts in \d+$/)).toBeVisible();
  await expect(lead.getByRole("button", { name: "Cancel" })).toBeVisible();
  // The live region speaks the countdown once; nothing stale from playback is left in it.
  await expect(page.locator("[aria-live]").filter({ hasText: /starts in 10 seconds/ })).toHaveCount(
    1,
  );
  await expect(page.locator("[aria-live]").filter({ hasText: /Skip Intro/ })).toHaveCount(0);

  // Rating is choosing: it stops the countdown for good.
  const rated = apiResponse(page, "PUT", /\/api\/v1\/ratings\//);
  await page.getByRole("button", { name: "I like this" }).click();
  await expect(page.getByRole("button", { name: "I like this" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await rated).ok()).toBe(true);
  await expect(lead.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  const rating = await (await page.context().request.get(`/api/v1/titles/${movie.id}`)).json();
  expect(rating.viewer.rating).toBe("like");
  await expectAccessible(page);

  const more = page.getByRole("region", { name: "More like this" });
  const first = more.getByRole("link").first();
  const href = await first.getAttribute("href");
  await first.click();
  await expect(page).toHaveURL(new RegExp(`${href?.split("?")[0]}`));
  await waitForPlayback(page, 0.3);
  await page.goBack();
  await expect(page).toHaveURL(/\/browse/);
});

test("post-play starts the recommendation after its countdown, unless the profile's autoplay is off", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const account = await createAccount(page.context().request, { tag: "postplay" });
  const movie = await findPlayableTitle(page.context().request, "movie");
  await page.goto("/browse");
  await page.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(page, 0.5);
  let duration = await page.evaluate(() => document.querySelector("video")?.duration ?? 0);
  await seek(page, Math.max(0, duration - 2));
  await expect(leadOf(page)).toBeVisible({ timeout: 20_000 });
  // Untouched: it starts by itself, in place of the film (Back still goes to browse).
  await expect(page).not.toHaveURL(new RegExp(`/watch/${movie.id}`), { timeout: 20_000 });
  await waitForPlayback(page, 0.3);
  await page.goBack();
  await expect(page).toHaveURL(/\/browse/);

  // Autoplay off for this profile: the lead waits for the member.
  const off = await page.context().request.patch(`/api/v1/profiles/${account.profileId}`, {
    headers: CLIENT_HEADERS,
    data: { settings: { autoplayNextEpisode: false } },
  });
  expect(off.ok()).toBe(true);
  await page.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(page, 0.5);
  duration = await page.evaluate(() => document.querySelector("video")?.duration ?? 0);
  await seek(page, Math.max(0, duration - 2));
  const lead = leadOf(page);
  await expect(lead).toBeVisible({ timeout: 20_000 });
  await expect(lead.getByRole("button", { name: /^Play / })).toHaveText("Play");
  await expect(lead.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await page.waitForTimeout(12_000);
  await expect(page).toHaveURL(new RegExp(`/watch/${movie.id}`));
});

test("player preferences are remembered per profile", async ({ page }) => {
  const account = await createAccount(page.context().request, { tag: "prefs" });
  const movie = await findPlayableTitle(page.context().request, "movie", { minDurationSec: 30 });
  await page.goto(`/watch/${movie.id}?t=10`);
  await waitForPlayback(page, 10.5);
  await page.keyboard.press("m");
  await expect
    .poll(() =>
      page.evaluate(
        (key) => localStorage.getItem(key) ?? "",
        `webflix.player.${account.profileId}`,
      ),
    )
    .toContain('"muted":true');
});
