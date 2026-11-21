import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { firstCard, hideDevChrome, waitForAnimations } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/** axe (WCAG 2.2 AA, including colour contrast) on the browse screens with real artwork. */

test.use({ demo: "Alex" });

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude('[data-testid="dev-toolbar"]')
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes
        .map((node) => node.target.join(" "))
        .slice(0, 4)
        .join(" | ")}`,
  );
}

const SCREENS: Array<[string, string]> = [
  ["home", "/browse"],
  ["series", "/browse/series"],
  ["new & popular", "/browse/new-popular"],
  ["genre", "/browse/genre/drama"],
  ["my list", "/my-list"],
  ["search results", "/search?q=the"],
  ["search, no results", "/search?q=zzqxv"],
];

for (const width of [1440, 390]) {
  test.describe(`${width}px`, () => {
    test.use({
      viewport: { width, height: width < 500 ? 844 : 900 },
      hasTouch: width < 500,
      isMobile: width < 500,
    });

    for (const [name, path] of SCREENS) {
      test(`${name} has no WCAG 2.2 AA violations`, async ({ page }) => {
        await hideDevChrome(page);
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        expect(await axe(page)).toEqual([]);
      });
    }

    test("the detail overlay has no WCAG 2.2 AA violations", async ({ page }) => {
      await hideDevChrome(page);
      await page.goto("/browse");
      const trending = page.getByRole("region", { name: "Trending Now" });
      await trending.scrollIntoViewIfNeeded();
      await firstCard(trending).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await waitForAnimations(page);
      expect(await axe(page)).toEqual([]);
    });
  });
}

test("the hover preview has no WCAG 2.2 AA violations", async ({ page }) => {
  await hideDevChrome(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/browse");
  const trending = page.getByRole("region", { name: "Trending Now" });
  await trending.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  await page.waitForTimeout(400);
  await trending.locator("li.wf-slider__item:not([inert])").nth(2).hover();
  await expect(page.getByTestId("hover-preview")).toBeVisible();
  await waitForAnimations(page);
  expect(await axe(page)).toEqual([]);
});
