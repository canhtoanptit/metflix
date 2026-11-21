import type { Page } from "@playwright/test";
import { catalogCards, createProfile, findPlayableTitle, selectProfile } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import {
  CLIENT_HEADERS,
  createAccount,
  expectAccessible,
  secondDevice,
  waitForPlayback,
} from "./member-support.ts";

/**
 * Every refusal a member can actually hit on the watch page, each with its designed screen and
 * a way forward. Stream limits, revoked sessions and plan downgrades are produced for real with
 * two browser contexts (two devices); an expired media token and an ended membership, which
 * take hours or a database edit to happen for real, are injected as the exact responses the
 * API gives.
 */

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

const pause = (page: Page) => page.keyboard.press("k");

test("too many screens: lists the active streams, then plays once a screen is free", async ({
  newDevice,
}) => {
  const first = await newDevice();
  const account = await createAccount(first.request, { plan: "basic", tag: "limit" });
  const movie = await findPlayableTitle(first.request, "movie");
  const series = await findPlayableTitle(first.request, "series");
  const a = await first.newPage();
  await a.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(a, 0.5);

  const second = await newDevice();
  await secondDevice(second, account);
  const b = await second.newPage();
  await b.goto(`/watch/${series.id}`);
  const status = b.getByTestId("watch-status-stream-limit");
  await expect(status).toBeVisible();
  await expect(b.getByRole("heading", { name: "Too many people are watching" })).toBeFocused();
  await expect(status).toContainText("Your Basic plan streams on one screen at a time");
  await expect(status.getByRole("listitem")).toHaveCount(1);
  await expect(status.getByRole("listitem")).toContainText(`Watching ${movie.name}`);
  await expect(status.getByRole("link", { name: "Change plan" })).toBeVisible();
  await expectAccessible(b);

  // Still busy: trying again keeps the screen.
  await b.getByRole("button", { name: "Try again" }).click();
  await expect(status).toBeVisible();

  // The other device leaves (its slot is released): now it plays.
  await a.mouse.move(400, 300);
  await a.getByRole("button", { name: /^Back/ }).first().click();
  await expect(a).not.toHaveURL(/\/watch/);
  await b.getByRole("button", { name: "Try again" }).click();
  await waitForPlayback(b, 0.5);
});

test("signed out from another device: playback stops with a way to sign back in", async ({
  newDevice,
}) => {
  const first = await newDevice();
  const account = await createAccount(first.request, { tag: "revoke" });
  const movie = await findPlayableTitle(first.request, "movie");
  const second = await newDevice();
  await secondDevice(second, account);
  const b = await second.newPage();
  await b.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(b, 0.5);

  // From the first device's account page.
  const a = await first.newPage();
  await a.goto("/account/devices");
  const otherDevice = a
    .getByRole("region", { name: "Signed-in devices" })
    .getByRole("listitem")
    .filter({ hasNotText: "This device" });
  await otherDevice.getByRole("button", { name: /^Sign out/ }).click();
  await a.getByRole("alertdialog").getByRole("button", { name: "Sign out device" }).click();
  await expect(a.getByText(/was signed out/).first()).toBeVisible();

  // A pause reports at once (the player sends at most one event report every 2 s).
  const status = b.getByTestId("watch-status-signed-out");
  await expect
    .poll(
      async () => {
        await b.waitForTimeout(2_100);
        if (await status.isVisible()) return true;
        await pause(b);
        return status.isVisible();
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toBe(true);
  await expect(b.getByRole("dialog", { name: "You've been signed out" })).toBeVisible();
  await b.getByRole("button", { name: "Sign in again" }).click();
  await expect(b).toHaveURL(new RegExp(`/login\\?redirect=%2Fwatch%2F${movie.id}`));
});

test("a plan downgrade ends the newest stream; it can resume once there is room", async ({
  newDevice,
}) => {
  const first = await newDevice();
  const account = await createAccount(first.request, { plan: "standard", tag: "downgrade" });
  const movie = await findPlayableTitle(first.request, "movie");
  const series = await findPlayableTitle(first.request, "series");
  const a = await first.newPage();
  await a.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(a, 0.5);
  const second = await newDevice();
  await secondDevice(second, account);
  const b = await second.newPage();
  await b.goto(`/watch/${series.id}?t=0`);
  await waitForPlayback(b, 0.3);

  const change = await first.request.put("/api/v1/account/subscription", {
    headers: CLIENT_HEADERS,
    data: { planId: "basic" },
  });
  expect(change.ok()).toBe(true);
  const ended = b.getByTestId("watch-status-ended-elsewhere");
  await expect
    .poll(
      async () => {
        await b.waitForTimeout(2_100);
        if (await ended.isVisible()) return true;
        await pause(b);
        return ended.isVisible();
      },
      { timeout: 20_000, intervals: [500] },
    )
    .toBe(true);
  await expect(b.getByRole("button", { name: "Resume watching" })).toBeFocused();

  // Device A stops watching (leaving frees its screen); B resumes where it was.
  await a.goto("/browse");
  await b.getByRole("button", { name: "Resume watching" }).click();
  await waitForPlayback(b, 0.3);
  await expect(b.getByTestId("watch-status-stream-limit")).toHaveCount(0);
});

test("maturity: a kids profile is told why, and can switch profile", async ({ page }) => {
  const request = page.context().request;
  await createAccount(request, { tag: "maturity" });
  // A title above the kids ceiling, from the adult profile's own catalogue.
  const title = (await catalogCards(request)).find(
    (card) => !["ALL", "7+"].includes(card.maturity),
  );
  if (!title) throw new Error("no title rated above 7+ in the catalogue");
  await selectProfile(request, await createProfile(request, { name: "Kids", isKids: true }));
  await page.goto(`/watch/${title.id}`);
  const status = page.getByTestId("watch-status-maturity");
  await expect(status).toBeVisible();
  await expect(status).toContainText("Kids' profile only shows titles rated 7+ and under");
  await expectAccessible(page);
  await status.getByRole("link", { name: "Switch profile" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/profiles\\?redirect=${encodeURIComponent(`/watch/${title.id}`)}`),
  );
});

test("an unknown title gets a way back to browsing", async ({ page }) => {
  await createAccount(page.context().request, { tag: "missing" });
  await page.goto("/watch/t-does-not-exist");
  await expect(page.getByTestId("watch-status-not-found")).toBeVisible();
  await page.getByRole("button", { name: "Browse Webflix" }).click();
  await expect(page).toHaveURL(/\/browse/);
});

test("an ended membership offers to restart it", async ({ page }) => {
  await createAccount(page.context().request, { tag: "lapsed" });
  const movie = await findPlayableTitle(page.context().request, "movie");
  await page.route("**/api/v1/playback/sessions", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 402,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "urn:webflix:problem:subscription_required",
            title: "An active membership is required",
            status: 402,
            code: "subscription_required",
            subscriptionStatus: "ended",
          }),
        })
      : route.continue(),
  );
  await page.goto(`/watch/${movie.id}`);
  await expect(page.getByTestId("watch-status-membership")).toBeVisible();
  await page.getByRole("link", { name: "Restart membership" }).click();
  await expect(page).toHaveURL(/\/account\/plan/);
});

test("an expired media token is renewed in place, at the same position", async ({ page }) => {
  await createAccount(page.context().request, { tag: "token" });
  const movie = await findPlayableTitle(page.context().request, "movie");
  const creates: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/playback/sessions") && request.method() === "POST") {
      creates.push(JSON.parse(request.postData() ?? "{}"));
    }
  });
  // A slow link keeps segments loading while the video plays; then the first session's token
  // "expires": the media origin answers exactly what it answers past a token's 6-hour lifetime.
  let firstToken: string | null = null;
  let expired = false;
  await page.route("**/media/**", async (route) => {
    const token = new URL(route.request().url()).pathname.split("/")[2] ?? "";
    firstToken ??= token;
    if (token === firstToken && expired) {
      return route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "urn:webflix:problem:media_token_expired",
          title: "Media token expired",
          status: 403,
          code: "media_token_expired",
        }),
      });
    }
    if (/\/seg_\d+\.m4s$/.test(route.request().url())) {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return route.continue();
  });
  await page.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(page, 3);
  expired = true;
  await expect.poll(() => creates.length, { timeout: 30_000 }).toBe(2);
  expect(creates[1]?.titleId).toBe(movie.id);
  const resumedAt = Number(creates[1]?.startPositionSec);
  expect(resumedAt).toBeGreaterThan(3);
  await waitForPlayback(page, resumedAt + 1);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("losing the network mid-play says so, then recovers by itself", async ({ page, context }) => {
  await createAccount(context.request, { tag: "offline" });
  const movie = await findPlayableTitle(context.request, "movie");
  await page.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(page, 1);
  await context.setOffline(true);
  await pause(page); // the pause heartbeat fails
  await expect(page.getByRole("status").filter({ hasText: "Connection lost" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole("status").filter({ hasText: "Connection lost" })).toHaveCount(0);
  await pause(page);
  await waitForPlayback(page, 2);
});
