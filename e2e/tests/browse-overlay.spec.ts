import type { Page } from "@playwright/test";
import { row, visibleCards } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

test.use({ viewport: { width: 1440, height: 900 }, demo: "Alex" });

/** A series with at least two seasons, from the profile's own catalogue. */
async function seriesWithSeasons(page: Page): Promise<{ id: string; name: string }> {
  const response = await page.request.get("/api/v1/browse/genre/drama?type=series&limit=50");
  const genre = (await response.json()) as {
    items: Array<{ id: string; name: string; seasonCount: number | null }>;
  };
  const found = genre.items.find((item) => (item.seasonCount ?? 0) >= 2);
  if (!found) throw new Error("no multi-season series in the catalogue");
  return found;
}

test("opens from a card, Back closes it, Forward reopens it, the page never scrolls", async ({
  page,
}) => {
  await page.goto("/browse");
  const trending = row(page, "Trending Now");
  await trending.scrollIntoViewIfNeeded();
  const scrollY = await page.evaluate(() => window.scrollY);
  await visibleCards(trending).nth(1).locator("a").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]title=t-/);
  await expect(dialog.getByRole("heading", { name: "More Like This" })).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  await page.goForward();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollY)).toBeLessThan(4);
});

test("a shared link opens the title; Escape closes it into the home page", async ({ page }) => {
  const series = await seriesWithSeasons(page);
  await page.goto(`/title/${series.id}`);
  const dialog = page.getByRole("dialog", { name: series.name });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveTitle(`${series.name} · Webflix`);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/browse$/);
});

test("series: the season selector lists that season's episodes", async ({ page }) => {
  const series = await seriesWithSeasons(page);
  await page.goto(`/browse?title=${series.id}`);
  const dialog = page.getByRole("dialog", { name: series.name });
  const episodes = dialog
    .getByRole("list")
    .filter({ has: page.getByRole("link", { name: /^Episode 1, / }) });
  await expect(dialog.getByRole("heading", { name: "Episodes" })).toBeVisible();
  const season = dialog.getByRole("combobox", { name: "Season" });
  const before = await season.textContent();
  await season.click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible();
  const target = (await options.allTextContents()).find((text) => text !== before);
  const number = target?.match(/Season (\d+)/)?.[1];
  if (!target || !number) throw new Error("only one season");
  await page.getByRole("option", { name: target }).click();
  await expect(season).toHaveText(target);
  // The list follows the selection (it loads): its first link is that season's first episode.
  await expect(episodes.getByRole("link").first()).toHaveAttribute(
    "href",
    new RegExp(`episode=e-.*-s${number}e1$`),
  );
});

test("More Like This stacks: Back returns to the first title", async ({ page }) => {
  const series = await seriesWithSeasons(page);
  await page.goto(`/browse?title=${series.id}`);
  const dialog = page.getByRole("dialog", { name: series.name });
  await expect(dialog).toBeVisible();
  const similar = dialog.getByRole("heading", { name: "More Like This" });
  await similar.scrollIntoViewIfNeeded();
  const firstSimilar = dialog.locator("section[aria-labelledby=detail-similar] a").first();
  const otherName = (await firstSimilar.locator(".sr-only").textContent()) ?? "";
  await firstSimilar.click();
  await expect(page.getByRole("dialog", { name: otherName.trim() })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog", { name: series.name })).toBeVisible();
});

test("keyboard: focus starts inside, stays inside, and Escape restores it to the card", async ({
  page,
}) => {
  await page.goto("/browse");
  const trending = row(page, "Trending Now");
  await trending.scrollIntoViewIfNeeded();
  const link = visibleCards(trending).first().locator("a");
  await link.focus();
  const name = await link.evaluate(
    (element) => element.querySelector(".sr-only")?.textContent ?? "",
  );
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let step = 0; step < 25; step += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  // Escape dismisses the innermost layer first: a focused control's tooltip (WCAG 1.4.13),
  // then the overlay.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  if (await dialog.isVisible()) await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(":focus")).toHaveAccessibleName(new RegExp(`^${name}(,|$)`));
});

test("Play goes to the watch page with the title (and the episode to resume)", async ({ page }) => {
  await page.goto("/browse");
  const resume = row(page, /^Continue Watching/)
    .getByRole("link")
    .first();
  await resume.click();
  const dialog = page.getByRole("dialog");
  const play = dialog.getByRole("link", { name: /^(Play|Resume)/ }).first();
  await expect(play).toHaveAttribute("href", /^\/watch\/t-[^?]+(\?episode=e-.+)?$/);
});
