/**
 * <PreviewPlayer> on the playground's browse mock-up: billboard (progressive MP4) and hover
 * cards (HLS). Screenshots land in `.cache/screenshots/desktop/`.
 */
import { expect, test } from "@playwright/test";
import { shot } from "./helpers.ts";

const isPlaying = (selector: string) => {
  const video = document.querySelector<HTMLVideoElement>(`${selector} video`);
  return !!video && !video.paused && video.currentTime > 0.2;
};

test.describe("preview player", () => {
  test("billboard fades in, mutes by default, pauses off-screen", async ({ page }, info) => {
    await page.goto("/?page=preview");
    const billboard = page.locator(".pv-billboard .wfp-preview");
    await expect(billboard).toHaveAttribute("data-ready", "", { timeout: 10_000 });
    await page.waitForFunction(isPlaying, ".pv-billboard");
    expect(await billboard.locator("video").evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
    await page.waitForTimeout(700);
    await shot(page, info, "30-preview-billboard");

    await page.getByRole("button", { name: "Unmute" }).click();
    expect(await billboard.locator("video").evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
    await expect(page.getByRole("button", { name: "Mute" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.mouse.wheel(0, 1400);
    await page.waitForFunction(
      () => document.querySelector<HTMLVideoElement>(".pv-billboard video")?.paused === true,
    );
    await page.mouse.wheel(0, -1400);
    await page.waitForFunction(isPlaying, ".pv-billboard");
  });

  test("hover card plays its HLS preview only while hovered", async ({ page }, info) => {
    await page.goto("/?page=preview");
    const card = page.locator(".pv-card").first();
    await expect(card.locator(".wfp-preview")).not.toHaveAttribute("data-ready", "");
    await card.hover();
    await expect(card.locator(".wfp-preview")).toHaveAttribute("data-ready", "", {
      timeout: 10_000,
    });
    await page.waitForTimeout(600);
    await shot(page, info, "31-preview-hover-card");
    await page.mouse.move(5, 5);
    await page.waitForFunction(
      () => document.querySelector<HTMLVideoElement>(".pv-card video")?.paused === true,
    );
  });

  test("reduced motion keeps the poster", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/?page=preview");
    await page.waitForTimeout(2000);
    const video = page.locator(".pv-billboard video");
    expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await expect(page.locator(".pv-billboard .wfp-preview")).not.toHaveAttribute("data-ready", "");
    await expect(page.locator(".pv-billboard .wfp-preview__poster")).toBeVisible();
  });
});
