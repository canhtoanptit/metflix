import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/** What the server searches (`SEARCH_QUERY_MAX_LENGTH`, in code points). */
const LIMIT = 100;
const codePoints = (text: string) => [...text].length;

/** Paste `text` into a field (a real paste event; typed in if the engine cannot synthesise one). */
async function paste(field: Locator, text: string): Promise<void> {
  await field.focus();
  const handled = await field.evaluate((input: HTMLInputElement, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    if (!event.clipboardData?.getData("text/plain")) return false;
    input.dispatchEvent(event);
    return input.value.length > 0;
  }, text);
  if (!handled) await field.fill(text);
}

/** The search page settled on results or the designed no-match state, never an error. */
async function expectSearched(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("list", { name: /^Results for / })
      .or(page.getByText(/did not have any matches/)),
  ).toBeVisible();
  await expect(page.getByTestId("search-unavailable")).toHaveCount(0);
  await expect(page.getByText(/validation|went wrong|Reference:/i)).toHaveCount(0);
  const q = new URL(page.url()).searchParams.get("q") ?? "";
  expect(codePoints(q)).toBeLessThanOrEqual(LIMIT);
  // Never cut inside a character: no lone surrogate halves.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(q)).toBe(
    false,
  );
}

test.use({ demo: "Alex" });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("search as you type: the URL follows after a pause, focus and caret stay", async ({
    page,
  }) => {
    await page.goto("/browse");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const field = page.getByRole("searchbox", { name: "Search titles, people and genres" });
    await expect(field).toBeFocused();
    const before = await page.evaluate(() => history.length);
    await field.pressSequentially("sint", { delay: 40 });
    await expect(page).toHaveURL(/\/search\?q=sint$/);
    await field.pressSequentially("el", { delay: 40 });
    await expect(page).toHaveURL(/\/search\?q=sintel$/);
    // One entry for the whole query (Back returns to Home), and typing never lost the field.
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    await expect(field).toBeFocused();
    expect(await field.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(6);
    const results = page.getByRole("list", { name: "Results for sintel" });
    await expect(results.getByRole("link").first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Related" })).toContainText("Sintel");
    await page.goBack();
    await expect(page).toHaveURL(/\/browse$/);
  });

  test("long, emoji, combining-mark and right-to-left pastes are searched, never an error", async ({
    page,
  }) => {
    await page.goto("/browse");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const field = page.getByRole("searchbox", { name: "Search titles, people and genres" });
    await expect(field).toHaveAttribute("dir", "auto");
    const cases = {
      long: "the dragon who lived under the mountain of scales ".repeat(60),
      emoji: "🐉 👨‍👩‍👧‍👦 🇬🇧 dragon ".repeat(30),
      combining: "Cafe\u0301 Ame\u0301lie ".repeat(30),
      rightToLeft: "שלום עולם مرحبا بالعالم ".repeat(12),
      lines: "sintel\n\tdragon\r\nmoon",
    };
    for (const [name, text] of Object.entries(cases)) {
      await field.fill("");
      await paste(field, text);
      const value = await field.inputValue();
      expect(codePoints(value), name).toBeLessThanOrEqual(LIMIT);
      expect(value, name).not.toMatch(/[\n\r\t]/);
      expect(value.length, name).toBeGreaterThan(0);
      await expect(page).toHaveURL(/\/search\?q=/);
      await expectSearched(page);
    }
  });

  test("typing stops at the limit", async ({ page }) => {
    await page.goto("/browse");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const field = page.getByRole("searchbox");
    await field.fill("a".repeat(LIMIT - 2));
    await field.press("End");
    await field.pressSequentially("bcdef");
    await expect(field).toHaveValue(`${"a".repeat(LIMIT - 2)}bc`);
    await expectSearched(page);
  });

  test("a shared link longer than any query searches its first characters", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent("moon ".repeat(500))}`);
    await expectSearched(page);
    expect(codePoints(await page.getByRole("searchbox").inputValue())).toBeLessThanOrEqual(LIMIT);
  });

  test("a search that cannot run says so quietly, keeps the query and retries", async ({
    page,
  }) => {
    await page.route(/\/api\/v1\/search(\?|$)/, (route) => route.abort("failed"));
    await page.goto("/search?q=sintel");
    const unavailable = page.getByTestId("search-unavailable");
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText("“sintel”");
    await expect(page.getByText(/went wrong|Reference:/i)).toHaveCount(0);
    await expect(page.getByRole("searchbox")).toHaveValue("sintel");
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await unavailable.getByRole("button", { name: "Search again" }).click();
    await expect(page.getByRole("list", { name: "Results for sintel" })).toBeVisible();
  });

  test("no matches: a designed empty state with genres to try", async ({ page }) => {
    await page.goto("/search?q=zzqxv");
    await expect(page.getByText("Your search for “zzqxv” did not have any matches.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Or browse a genre" })).toBeVisible();
    await expect(page.getByRole("searchbox")).toHaveValue("zzqxv");
  });

  test("Escape clears back to where you were, a second Escape folds the field", async ({
    page,
  }) => {
    await page.goto("/browse/movies");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const field = page.getByRole("searchbox");
    await field.pressSequentially("night", { delay: 30 });
    await expect(page).toHaveURL(/\/search\?q=night$/);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/browse\/movies$/);
    await expect(field).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("searchbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeFocused();
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the tab bar's Search opens a ready-to-type field over the top bar", async ({ page }) => {
    await page.goto("/browse");
    const tabs = page.getByRole("navigation", { name: "Primary" });
    await tabs.getByRole("link", { name: "Search" }).tap();
    await expect(page).toHaveURL(/\/search$/);
    const field = page.getByRole("searchbox");
    await expect(field).toBeFocused();
    await field.pressSequentially("moon", { delay: 30 });
    await expect(page).toHaveURL(/\/search\?q=moon$/);
    await expect(page.getByRole("list", { name: "Results for moon" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).tap();
    await expect(page.getByRole("searchbox")).toHaveCount(0);
  });
});
