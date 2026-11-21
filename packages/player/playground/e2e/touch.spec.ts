/**
 * Touch verification (Pixel 7, portrait and landscape): tap to toggle the controls, double tap
 * to seek, bottom-sheet menus, captions, moments and the end screen in the touch layout.
 * Screenshots land in `.cache/screenshots/mobile-portrait|mobile-landscape/`.
 */
import { expect, type Page, test } from "@playwright/test";
import { events, openPlayer, seekTo, shot, videoState } from "./helpers.ts";

async function tapAt(page: Page, xRatio: number, yRatio: number) {
  const box = await page.locator(".wfp-root").boundingBox();
  if (!box) throw new Error("no player");
  await page.touchscreen.tap(box.x + box.width * xRatio, box.y + box.height * yRatio);
}

/** Reveal the controls with a tap on empty picture (the centre holds the play button). */
async function revealControls(page: Page) {
  if ((await page.locator(".wfp-root").getAttribute("data-controls")) === "hidden") {
    await tapAt(page, 0.5, 0.25);
  }
  await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "shown");
}

async function waitHidden(page: Page) {
  await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "hidden", {
    timeout: 8000,
  });
}

test.describe("player (touch)", () => {
  test("touch layout, tap toggles controls, double tap seeks", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-layout", "touch");
    await seekTo(page, 47);
    await waitHidden(page);
    await shot(page, info, "01-playing-controls-hidden");

    await tapAt(page, 0.5, 0.25);
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "shown");
    await expect(page.locator(".wfp-center")).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, info, "02-controls-shown");
    await tapAt(page, 0.5, 0.25);
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "hidden");

    const before = (await videoState(page)).t;
    await tapAt(page, 0.85, 0.5);
    await page.waitForTimeout(90);
    await tapAt(page, 0.85, 0.5);
    await expect(page.locator(".wfp-feedback--seek")).toBeVisible();
    await page.waitForTimeout(90);
    await tapAt(page, 0.85, 0.5);
    await expect(page.locator(".wfp-feedback--seek")).toContainText("+20s");
    await shot(page, info, "03-double-tap-seek");
    await expect.poll(async () => (await videoState(page)).t).toBeGreaterThan(before + 17);
    // A seek streak does not toggle the controls.
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "hidden");

    // Centre transport buttons.
    await revealControls(page);
    await page.getByRole("button", { name: "Pause" }).first().tap();
    await expect.poll(async () => (await videoState(page)).paused).toBe(true);
    await page.waitForTimeout(300);
    await shot(page, info, "04-paused-controls");
  });

  test("bottom-sheet menus and captions", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await seekTo(page, 64.5);
    await revealControls(page);
    await page.getByRole("button", { name: "Audio & Subtitles" }).tap();
    const sheet = page.getByRole("menu", { name: "Audio & Subtitles" });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, info, "05-sheet-audio-subtitles");
    await sheet
      .getByRole("group", { name: "Subtitles" })
      .getByRole("menuitemradio", { name: "English" })
      .tap();
    await sheet.getByRole("button", { name: "Close" }).tap();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".wfp-cue")).toContainText("This line is long enough");
    await waitHidden(page);
    await shot(page, info, "06-captions-wrapping");

    await revealControls(page);
    await page.getByRole("button", { name: "Playback speed" }).tap();
    await page.waitForTimeout(400);
    await shot(page, info, "07-sheet-speed");
    await page.getByRole("menuitemradio", { name: "1.25×" }).tap();
    await expect.poll(async () => (await videoState(page)).rate).toBe(1.25);
    await page.getByRole("button", { name: "Close" }).tap();

    await page.getByRole("button", { name: "Episodes" }).tap();
    const episodes = page.getByRole("dialog", { name: "Episodes" });
    await expect(episodes.getByRole("button", { name: /The Ledger/ })).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, info, "08-sheet-episodes");
    await episodes.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(episodes).toHaveCount(0);
  });

  test("skip intro, next-episode countdown and end screen", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode&countdown=8");
    await seekTo(page, 23);
    await expect(page.getByRole("button", { name: "Skip Intro" })).toBeVisible();
    await waitHidden(page);
    await shot(page, info, "09-skip-intro");
    await seekTo(page, 130);
    await expect(page.getByRole("group", { name: "Next Episode" })).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(1500);
    await shot(page, info, "10-next-episode-countdown");
    await page.getByRole("button", { name: /Play Next Episode/ }).tap();
    await expect
      .poll(async () => (await events(page, "next-episode")).map((e) => e.detail))
      .toEqual([{ id: "kestrel-s1e2", reason: "user" }]);

    await openPlayer(page, "scenario=last-episode");
    await seekTo(page, 77);
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-endscreen", "credits");
    await page.waitForTimeout(900);
    await shot(page, info, "11-endscreen");
  });

  test("paused-state overlay", async ({ page }, info) => {
    await openPlayer(page, "scenario=movie");
    await seekTo(page, 40);
    await revealControls(page);
    await page.getByRole("button", { name: "Pause" }).first().tap();
    await expect(page.locator(".wfp-paused")).toHaveAttribute("data-visible", "", {
      timeout: 12_000,
    });
    await page.waitForTimeout(800);
    await shot(page, info, "12-paused-overlay");
  });
});
