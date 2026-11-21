import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Helpers for the browse journeys. They run against a real API in any mode (BASE_URL), signed
 * in to the seeded demo account through the shared, read-only session of the `demo` fixture
 * (fixtures.ts); specs that change data use a fresh account instead (api.ts).
 */

/** A browse row (carousel region) by its title. */
export function row(page: Page, title: string | RegExp): Locator {
  return page.getByRole("region", { name: title });
}

/** Cards fully on the row's current page. */
export function visibleCards(slider: Locator): Locator {
  return slider.locator("li.wf-slider__item:not([inert])");
}

/** Move the mouse to the centre of a locator in a few steps (real pointer events). */
export async function pointAt(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}

/** Park the mouse somewhere inert (top-left of the billboard) and let previews close. */
export async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(4, 160, { steps: 2 });
  await expect(page.getByTestId("hover-preview")).toHaveCount(0);
}

/** Bring a row into view below the fixed navigation, without leaving it at the very top. */
export async function showRow(page: Page, slider: Locator): Promise<void> {
  await slider.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  // Scrolling holds previews off for a moment; let it settle.
  await page.waitForTimeout(350);
}

export function previewOf(page: Page): Locator {
  return page.getByTestId("hover-preview");
}

/** The first card's link on a row's current page (not the row's "Explore all" header link). */
export function firstCard(slider: Locator): Locator {
  return visibleCards(slider).first().locator("a");
}

/**
 * Hide development chrome (the mock/dev toolbar the dev server adds) so checks see the product
 * only; production builds do not have it.
 */
export async function hideDevChrome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = '[data-testid="dev-toolbar"]{display:none!important}';
    document.addEventListener("DOMContentLoaded", () => document.head.append(style));
  });
}

/**
 * Wait until every finite animation (entrance fades, the overlay or preview growing) has
 * finished: colour contrast and geometry are only meaningful on what is finally painted.
 */
export async function waitForAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
}
