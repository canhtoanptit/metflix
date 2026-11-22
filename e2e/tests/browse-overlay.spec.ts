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
    .filter({ has: page.getByRole("link", { name: /^Episode 1: / }) });
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

test("the dialog's one heading level 2 is the title's name", async ({ page }) => {
  const series = await seriesWithSeasons(page);
  await page.goto(`/browse?title=${series.id}`);
  const dialog = page.getByRole("dialog", { name: series.name });
  await expect(dialog.getByRole("heading", { name: "Episodes" })).toBeVisible();
  await expect(dialog.getByRole("heading", { level: 2 })).toHaveCount(1);
  await expect(dialog.getByRole("heading", { level: 2 })).toHaveText(series.name);
});

test("from the billboard, the detail hero carries on with the billboard's clip", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "clip hand-offs are checked in Chromium, the engine of the full suite",
  );
  await page.goto("/browse");
  const billboard = page.getByRole("region", { name: /^Featured: / });
  const clip = billboard.locator("video");
  // A billboard without a preview clip (or previews off) has nothing to continue.
  const playing = await clip
    .waitFor({ state: "attached", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!playing, "this target's billboard has no preview clip");
  await expect
    .poll(() => clip.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 20_000 })
    .toBeGreaterThan(2);
  // Record when, and from where, the hero's clip starts playing.
  await page.evaluate(() => {
    const record: Array<{ at: number; from: number }> = [];
    Object.assign(window, { __hero: record });
    new MutationObserver(() => {
      const video = document.querySelector<HTMLVideoElement>("[data-testid=title-overlay] video");
      if (!video || video.dataset.watched) return;
      video.dataset.watched = "1";
      video.addEventListener("playing", () =>
        record.push({ at: performance.now(), from: video.currentTime }),
      );
    }).observe(document.body, { childList: true, subtree: true });
  });
  const handedOver = await clip.evaluate((video: HTMLVideoElement) => video.currentTime);
  const clickedAt = await page.evaluate(() => performance.now());
  await billboard.getByRole("button", { name: "More info" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __hero: unknown[] }).__hero.length))
    .toBeGreaterThan(0);
  const [first] = await page.evaluate(
    () => (window as unknown as { __hero: Array<{ at: number; from: number }> }).__hero,
  );
  // It continues from where the billboard was (not from the top), straight after the opening.
  expect(first?.from ?? 0).toBeGreaterThanOrEqual(handedOver - 0.25);
  const slowdown = Math.max(1, Number(process.env.E2E_CPU_THROTTLE ?? 1) || 1);
  expect((first?.at ?? 0) - clickedAt).toBeLessThan(1_500 * slowdown);
});

test.describe("phones", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the close button sits on a solid bar once the page scrolls under it", async ({ page }) => {
    const series = await seriesWithSeasons(page);
    await page.goto(`/browse?title=${series.id}`);
    const dialog = page.getByRole("dialog", { name: series.name });
    const bar = dialog.getByTestId("detail-phone-bar");
    await expect(bar).toBeVisible();
    await expect(bar).not.toHaveAttribute("data-solid");
    await expect(dialog.getByRole("heading", { name: /^About / })).toBeAttached();
    await page.getByTestId("title-overlay").evaluate((overlay) => overlay.scrollTo({ top: 600 }));
    await expect(bar).toHaveAttribute("data-solid", "true");
    const close = dialog.getByRole("button", { name: "Close" });
    const [closeBox, barBox] = [await close.boundingBox(), await bar.boundingBox()];
    expect(barBox?.y).toBe(0);
    // Inside the bar: nothing scrolls behind it but the bar's own surface.
    expect((closeBox?.y ?? 0) + (closeBox?.height ?? 0)).toBeLessThanOrEqual(
      (barBox?.y ?? 0) + (barBox?.height ?? 0),
    );
    await expect(bar).toContainText(series.name);
    await close.tap();
    await expect(dialog).toBeHidden();
  });
});

for (const [device, viewport] of [
  ["phone", { width: 390, height: 844 }],
  ["tablet", { width: 834, height: 1112 }],
] as const) {
  test.describe(`More Like This on a ${device}`, () => {
    test.use({ viewport, hasTouch: true });

    test("nothing covers the title treatment baked into the card art", async ({ page }) => {
      const series = await seriesWithSeasons(page);
      await page.goto(`/browse?title=${series.id}`);
      const section = page.locator("section[aria-labelledby=detail-similar]");
      await section.scrollIntoViewIfNeeded();
      await expect(section.locator("li a").first()).toBeVisible();
      const cards = await section.evaluate((root) =>
        [...root.querySelectorAll("li")].map((cell) => {
          const link = cell.querySelector("a");
          const picture = link?.getBoundingClientRect();
          if (!link || !picture) return null;
          // Everything in the card that paints text inside the picture's box (badges, chips,
          // marks: in the link or laid over it), as how far down the picture it reaches.
          const overlays = [...cell.querySelectorAll<HTMLElement>("*")]
            .filter((element) => {
              const box = element.getBoundingClientRect();
              const text = element.textContent?.trim();
              return (
                text &&
                element.children.length === 0 &&
                box.width > 2 &&
                box.height > 2 &&
                box.top < picture.bottom - 1 &&
                box.bottom > picture.top + 1 &&
                getComputedStyle(element).visibility !== "hidden"
              );
            })
            .map((element) => ({
              text: element.textContent?.trim() ?? "",
              bottom: (element.getBoundingClientRect().bottom - picture.top) / picture.height,
            }));
          const length = cell.querySelector("[data-duration]")?.getBoundingClientRect();
          return {
            name: link.querySelector(".sr-only")?.textContent ?? "",
            overlays,
            lengthBelowPicture: length ? length.top >= picture.bottom - 1 : null,
          };
        }),
      );
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        if (!card) continue;
        // Card art carries its title in the lower part: chips and badges keep to the top corners.
        for (const overlay of card.overlays) {
          expect(
            overlay.bottom,
            `${card.name}: "${overlay.text}" reaches into the title`,
          ).toBeLessThan(0.4);
        }
        // The length lives in the line under the picture.
        expect(card.lengthBelowPicture, `${card.name}: length below the picture`).toBe(true);
      }
    });
  });
}
