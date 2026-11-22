import type { Page } from "@playwright/test";
import { type CatalogCard, catalogCards, escapeRegExp } from "./api.ts";
import { previewOf, waitForAnimations } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Preview clips by kind, with the target's real media (docs/DESIGN_SYSTEM.md): `motion` (key art
 * set in motion, silent) plays on the billboard and the detail hero but never in a hover card,
 * which keeps its still; a clip with sound, and only such a clip, gets a sound control.
 */
test.use({ viewport: { width: 1440, height: 900 }, demo: "Alex" });

async function byKind(page: Page): Promise<{ motion?: CatalogCard; footage?: CatalogCard }> {
  const cards = await catalogCards(page.request);
  return {
    motion: cards.find((card) => card.preview?.kind === "motion"),
    footage: cards.find(
      (card) => card.preview && card.preview.kind !== "motion" && card.preview.hasAudio !== false,
    ),
  };
}

/** Starting a clip: 20 s, scaled like every budget by E2E_CPU_THROTTLE. */
const playBudget = () => 20_000 * Math.max(1, Number(process.env.E2E_CPU_THROTTLE ?? 1) || 1);

const soundControl = (page: Page) => page.getByRole("button", { name: /^Turn sound (on|off)$/ });

/** Hover the title's card on its search results, and return its preview. */
async function hoverCard(page: Page, title: CatalogCard) {
  await page.goto(`/search?q=${encodeURIComponent(title.name)}`);
  const results = page.getByRole("list", { name: `Results for ${title.name}` });
  const card = results
    .getByRole("link", { name: new RegExp(`^${escapeRegExp(title.name)}`) })
    .first();
  await expect(card).toBeVisible();
  await card.hover();
  await expect(previewOf(page)).toHaveAttribute("data-title-id", title.id);
  await waitForAnimations(page);
  return previewOf(page);
}

/** The detail overlay's hero video, once it is actually playing. */
async function heroPlaying(page: Page, title: CatalogCard) {
  await page.goto(`/browse?title=${title.id}`);
  const dialog = page.getByRole("dialog", { name: title.name });
  await expect(dialog).toBeVisible();
  await expect
    .poll(
      () =>
        dialog
          .locator("video")
          .evaluateAll((videos) =>
            videos.some((video) => (video as HTMLVideoElement).currentTime > 0.3),
          ),
      { timeout: playBudget() },
    )
    .toBe(true);
  return dialog;
}

test("a motion-art title: its hover card keeps the still, and nothing offers sound", async ({
  page,
}) => {
  const { motion } = await byKind(page);
  test.skip(!motion, "this target has no motion-art preview");
  if (!motion) return;

  // Record any video the hover card mounts while it is open.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __previewVideos: seen });
    new MutationObserver(() => {
      for (const video of document.querySelectorAll("[data-testid=hover-preview] video")) {
        seen.push((video as HTMLVideoElement).currentSrc || "video");
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const preview = await hoverCard(page, motion);
  // Longer than the card's clip delay: a footage card would be playing by now.
  await page.waitForTimeout(2500);
  expect(
    await page.evaluate(() => (window as unknown as { __previewVideos: string[] }).__previewVideos),
  ).toEqual([]);
  await expect(preview.locator("img").first()).toBeVisible();
  await expect(soundControl(page)).toHaveCount(0);

  // The detail hero plays the motion art, silently: still no sound control.
  const dialog = await heroPlaying(page, motion);
  await expect(soundControl(page)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /sound/i })).toHaveCount(0);
});

test("a footage title plays with a sound control, in the hover card and the detail hero", async ({
  page,
}) => {
  const { footage } = await byKind(page);
  test.skip(!footage, "this target has no footage preview with sound");
  if (!footage) return;

  const preview = await hoverCard(page, footage);
  await expect
    .poll(
      () =>
        preview
          .locator("video")
          .evaluateAll((videos) =>
            videos.some((video) => (video as HTMLVideoElement).currentTime > 0.3),
          ),
      { timeout: playBudget() },
    )
    .toBe(true);
  await expect(preview.getByRole("button", { name: /^Turn sound (on|off)$/ })).toBeVisible();

  const dialog = await heroPlaying(page, footage);
  await expect(dialog.getByRole("button", { name: /^Turn sound (on|off)$/ })).toBeVisible();
});
