import { expect, test } from "./fixtures.ts";

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
