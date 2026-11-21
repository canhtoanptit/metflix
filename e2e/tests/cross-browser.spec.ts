import type { Page } from "@playwright/test";
import { createAccount, DEMO, findPlayableTitle } from "./api.ts";
import { row, visibleCards } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";
import { videoState } from "./member-support.ts";

/**
 * The cross-browser subset: the journeys every engine must get right, run by the chromium,
 * firefox and webkit projects (playwright.config.ts). The full suite runs on Chromium only.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** Which playback path the page took, and how far the video got. */
async function playbackState(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    return {
      // hls.js feeds the element through MediaSource (a blob: URL); native HLS loads the playlist.
      engine: !video ? null : video.currentSrc.startsWith("blob:") ? "mse" : "native",
      time: video?.currentTime ?? 0,
      paused: video?.paused ?? true,
      width: video?.videoWidth ?? 0,
    };
  });
}

async function expectPlaying(page: Page): Promise<void> {
  // Engines that refuse autoplay get the player's own Play button: press it, as a member would.
  const refused = page.locator(".wfp-autoplay").getByRole("button", { name: "Play" });
  try {
    await expect
      .poll(
        async () => {
          if (await refused.isVisible()) await refused.click();
          return (await playbackState(page)).time;
        },
        { timeout: 45_000, intervals: [250] },
      )
      .toBeGreaterThan(1.5);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nvideo element: ${JSON.stringify(await videoState(page))}`,
    );
  }
  expect((await playbackState(page)).paused).toBe(false);
  // Real frames were decoded, not just a clock moving.
  expect((await playbackState(page)).width).toBeGreaterThan(0);
}

test("landing: the hero, and a known email continues to sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const capture = page.getByRole("form", { name: /start your membership or sign back in/ }).first();
  await capture.getByLabel("Email address").fill(DEMO.email);
  await capture.getByRole("button", { name: "Get started" }).click();
  await expect(page).toHaveURL(/\/login\?email=demo%40webflix\.dev/);
  await expect(page.getByRole("form", { name: "Sign in" }).getByLabel("Email address")).toHaveValue(
    DEMO.email,
  );
});

test("sign in with the form, choose a profile, arrive home", async ({ page, newDevice }) => {
  const setup = await newDevice();
  const account = await createAccount(setup.request, { tag: "xb-signin" });
  await page.goto("/login");
  const form = page.getByRole("form", { name: "Sign in" });
  await form.getByLabel("Email address").fill(account.email);
  await form.getByLabel("Password", { exact: true }).fill(account.password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/profiles/);
  await page.getByRole("button", { name: /^Sam/ }).click();
  await expect(page).toHaveURL(/\/browse/);
  await expect(page.getByRole("button", { name: "Profile menu for Sam" })).toBeVisible();
});

test.describe("on the demo account", () => {
  test.use({ demo: "Alex" });

  test("browse home: billboard, then rows of cards", async ({ page }) => {
    await page.goto("/browse");
    await expect(page.getByRole("region", { name: /^Featured: / })).toBeVisible();
    const trending = row(page, "Trending Now");
    await trending.scrollIntoViewIfNeeded();
    await expect(visibleCards(trending).first()).toBeVisible();
    expect(await visibleCards(trending).count()).toBeGreaterThan(2);
  });

  test("a card opens the detail overlay; Escape closes it", async ({ page }) => {
    await page.goto("/browse");
    const trending = row(page, "Trending Now");
    await trending.scrollIntoViewIfNeeded();
    const card = visibleCards(trending).nth(1).locator("a");
    await card.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/[?&]title=/);
    await expect(dialog.getByRole("heading", { name: "More Like This" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test("playback starts and plays real frames", async ({ page }) => {
  // A fresh account, a discovery probe and up to 45 s for the first frames.
  test.slow();
  const request = page.context().request;
  await createAccount(request, { tag: "xb-play" });
  const movie = await findPlayableTitle(request, "movie");
  await page.goto(`/watch/${movie.id}?t=0`);
  await expectPlaying(page);
  // Every engine here has MediaSource, so the player streams through hls.js.
  expect((await playbackState(page)).engine).toBe("mse");
});

test("without MediaSource (as on iPhone) playback uses the browser's own HLS", async ({
  page,
  browserName,
}) => {
  const native = await page.evaluate(
    () => document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "",
  );
  test.skip(!native, `${browserName} has no native HLS: it only plays HLS through MediaSource`);
  test.slow();
  const request = page.context().request;
  await createAccount(request, { tag: "xb-native" });
  const movie = await findPlayableTitle(request, "movie");
  // Take MediaSource away before the app starts, so the player must choose native playback.
  await page.addInitScript(() => {
    for (const name of ["MediaSource", "ManagedMediaSource", "WebKitMediaSource"]) {
      Reflect.deleteProperty(window, name);
    }
  });
  await page.goto(`/watch/${movie.id}?t=0`);
  await expectPlaying(page);
  expect((await playbackState(page)).engine).toBe("native");
});
