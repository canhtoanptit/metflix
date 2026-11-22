import type { Page } from "@playwright/test";
import { findPlayableTitle } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import { CLIENT_HEADERS, createAccount, secondDevice, videoState } from "./member-support.ts";

/**
 * Watch-page screens every engine must lay out and drive correctly: the blocking overlay over
 * the whole viewport, and the post-play moment. Run by the chromium, firefox and webkit
 * projects; each journey works on its own fresh account.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** Playing, pressing the player's own Play where an engine refuses autoplay. */
async function playing(page: Page): Promise<void> {
  const refused = page.locator(".wfp-autoplay").getByRole("button", { name: "Play" });
  try {
    await expect
      .poll(
        async () => {
          if (await refused.isVisible()) {
            await refused.focus();
            await refused.press("Enter");
          }
          return page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
        },
        { timeout: 45_000, intervals: [250] },
      )
      .toBeGreaterThan(0.5);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nvideo element: ${JSON.stringify(await videoState(page))}`,
    );
  }
}

test("signed out everywhere: the whole screen says so, nothing clipped, within one heartbeat", async ({
  page,
  newDevice,
}) => {
  test.slow();
  const owner = await newDevice();
  const account = await createAccount(owner.request, { tag: "xb-signout" });
  const movie = await findPlayableTitle(owner.request, "movie");
  await secondDevice(page.context(), account);
  await page.goto(`/watch/${movie.id}?t=0`);
  await playing(page);

  const out = await owner.request.post("/api/v1/auth/logout-all", { headers: CLIENT_HEADERS });
  expect(out.status()).toBe(204);
  const dialog = page.getByRole("dialog", { name: "You've been signed out" });
  await expect(dialog).toBeVisible({ timeout: 35_000 });

  // The overlay covers the viewport, and its action (with room for the focus ring) is inside it.
  const overlay = await dialog.boundingBox();
  expect(overlay).toMatchObject({ x: 0, y: 0, width: 1440, height: 900 });
  const action = page.getByRole("button", { name: "Sign in again" });
  await expect(action).toBeVisible();
  const clipped = await action.evaluate((button) => {
    const box = button.getBoundingClientRect();
    for (let node = button.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflow === "visible" && style.overflowY === "visible") continue;
      const clip = node.getBoundingClientRect();
      if (box.top - 4 < clip.top || box.bottom + 4 > clip.bottom) return true;
      if (box.left - 4 < clip.left || box.right + 4 > clip.right) return true;
    }
    return false;
  });
  expect(clipped).toBe(false);
});

test("post-play: one recommendation leads, with full-size ratings below", async ({ page }) => {
  test.slow();
  await createAccount(page.context().request, { tag: "xb-postplay" });
  const movie = await findPlayableTitle(page.context().request, "movie");
  await page.goto(`/watch/${movie.id}?t=0`);
  await playing(page);
  await page.evaluate(() => {
    const video = document.querySelector("video");
    if (video) video.currentTime = Math.max(0, video.duration - 2);
  });
  // The innermost region holding a "Play …" button: the lead recommendation.
  const lead = page
    .getByRole("region")
    .filter({ has: page.getByRole("button", { name: /^Play / }) })
    .filter({ hasNot: page.getByRole("region") });
  await expect(lead).toBeVisible({ timeout: 30_000 });
  await expect(lead.getByRole("button", { name: "Cancel" })).toBeVisible();
  // From the keyboard (Playwright's WebKit misses pointer clicks on this host: see
  // member-cross-browser.spec.ts).
  await lead.getByRole("button", { name: "Cancel" }).focus();
  await lead.getByRole("button", { name: "Cancel" }).press("Enter");
  await expect(lead.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  for (const label of ["Not for me", "I like this", "Love this!"]) {
    const button = page.getByRole("button", { name: label });
    await expect(button).toBeVisible();
    // Labelled, full-size controls: at least the 44 px touch target.
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
