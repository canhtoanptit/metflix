import { expect, test } from "@playwright/test";
import { cleanLocation, gotoAs } from "./support.ts";

test("title overlay: opens from a card, Back closes it, scroll position is kept", async ({
  page,
}) => {
  await gotoAs(page, "/browse", "profile");
  const row = page.getByRole("region", { name: "Trending Now" });
  await row.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(/[?&]title=t-/);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link", { name: "Play" })).toBeVisible();
  await page.goBack();
  await expect(dialog).toBeHidden();
  expect(cleanLocation(page)).toBe("/browse");
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore)).toBeLessThan(4);
});

test("title overlay: a shared link opens it; Escape closes without leaving the app", async ({
  page,
}) => {
  await gotoAs(page, "/title/t-meridian", "profile");
  const dialog = page.getByRole("dialog", { name: "Meridian" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveTitle("Meridian · Webflix");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(cleanLocation(page)).toBe("/browse");
});
