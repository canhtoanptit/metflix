/**
 * What only a real browser engine can prove about telemetry, in every engine the suite runs:
 * an impression counts a card half visible for a second inside a horizontally paged row (the
 * row clips its off-page cards and its peeks), and leaving the page sends what was waiting
 * (`keepalive` on page hide). Fresh account, consent granted; the server's read-back is the
 * witness (requests sent as a page unloads cannot be observed from Playwright).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { createAccount } from "./member-support.ts";
import { answer, consentOf, leavePage, readBackUntil, storedDeviceId } from "./privacy-support.ts";

/**
 * A row long enough to have cards off screen on both of its first two pages (not the Top 10,
 * which wraps around after ten): its rank on the page.
 */
async function longRowRank(page: Page): Promise<number> {
  const rank = await page.evaluate(() => {
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-row-rank]"))) {
      const cards = row.querySelectorAll("li a[href*='title=']").length;
      // A page, its peek and the next page are rendered: 11 cards on a five-card desktop row.
      const wraps = row.dataset.rowKind === "top-10" || row.dataset.rowKind === "continue-watching";
      if (!wraps && cards >= 11) return Number(row.dataset.rowRank);
    }
    return null;
  });
  if (rank === null) throw new Error("no row with cards off screen on its first two pages");
  return rank;
}

interface CardVisibility {
  titleId: string;
  fraction: number;
}

/**
 * How much of each card of a row is on screen: its box cut by the viewport and by every
 * ancestor that clips (the slider's own viewport hides off-page cards and most of the peeks).
 */
async function cardVisibility(page: Page, rowRank: number): Promise<CardVisibility[]> {
  return page.evaluate((rank: number) => {
    const row = document.querySelector(`[data-row-rank="${rank}"]`);
    if (!row) return [];
    const links = Array.from(row.querySelectorAll<HTMLAnchorElement>("li a[href*='title=']"));
    return links.map((link) => {
      const box = link.getBoundingClientRect();
      let left = Math.max(box.left, 0);
      let right = Math.min(box.right, window.innerWidth);
      let top = Math.max(box.top, 0);
      let bottom = Math.min(box.bottom, window.innerHeight);
      for (let element = link.parentElement; element; element = element.parentElement) {
        const style = getComputedStyle(element);
        const clip = element.getBoundingClientRect();
        if (style.overflowX !== "visible") {
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
        if (style.overflowY !== "visible") {
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      const area = Math.max(0, right - left) * Math.max(0, bottom - top);
      const total = box.width * box.height;
      return {
        titleId: new URL(link.href).searchParams.get("title") ?? "",
        fraction: total > 0 ? area / total : 0,
      };
    });
  }, rowRank);
}

const clearly = (cards: CardVisibility[]) =>
  cards.filter((card) => card.fraction >= 0.65).map((card) => card.titleId);

test("impressions in a paged row: what was half visible for a second, and only that; sent as the page is left", async ({
  page,
  browserName,
}) => {
  test.setTimeout(90_000);
  const request = page.context().request;
  test.skip((await consentOf(request)).mode === "off", "consent mode off: nothing is collected");
  await createAccount(request, { tag: `rows-${browserName}` });
  await answer(request, { analytics: true, personalisation: true });
  await page.goto("/browse");
  await expect(page.locator("[data-row-rank] li a[href*='title=']").first()).toBeVisible();
  const ROW_RANK = await longRowRank(page);
  const row = page.locator(`[data-row-rank="${ROW_RANK}"]`);
  await row.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2); // no hover preview over the row
  await page.waitForTimeout(400);
  const firstPage = await cardVisibility(page, ROW_RANK);
  await page.waitForTimeout(2000); // past the one-second dwell
  expect(await storedDeviceId(page)).not.toBeNull();

  // Page the row: the next cards slide in, the first ones out.
  await row.hover();
  await row.getByRole("button", { name: "More titles" }).click();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1200); // the glide
  const secondPage = await cardVisibility(page, ROW_RANK);
  await page.waitForTimeout(2000);
  const seenPages = [firstPage, secondPage];
  await leavePage(page);

  const events = await readBackUntil(
    request,
    "impressions of the row",
    (items) =>
      items.some((event) => event.type === "impression" && event.context.rowRank === ROW_RANK),
    { query: { limit: 500 } },
  );
  const counted = new Set(
    events
      .filter((event) => event.type === "impression" && event.context.rowRank === ROW_RANK)
      .map((event) => (event.payload as { titleId: string }).titleId),
  );
  // Every card clearly on screen for the dwell was counted, on both pages.
  for (const titleId of [...clearly(firstPage), ...clearly(secondPage)]) {
    expect(counted, `${titleId} was on screen and not counted`).toContain(titleId);
  }
  // Nothing that never was at least (about) half visible: off-page cards and peeks.
  const ever = new Map<string, number>();
  for (const cards of seenPages) {
    for (const card of cards) {
      ever.set(card.titleId, Math.max(ever.get(card.titleId) ?? 0, card.fraction));
    }
  }
  for (const titleId of counted) {
    const fraction = ever.get(titleId);
    if (fraction === undefined) continue; // rendered later (the row grew): not measured
    expect(
      fraction,
      `${titleId} counted at ${Math.round(fraction * 100)}% visible`,
    ).toBeGreaterThan(0.35);
  }
  // And the row had cards that were not counted (the test means something).
  expect([...ever.values()].some((fraction) => fraction < 0.35)).toBe(true);
});
