import { expect, test } from "./fixtures.ts";

/** Runs against any deployed mode (BASE_URL): the SPA boots, renders branded UI and its guards. */
test("the app shell loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Webflix/);
  await expect(page.getByRole("img", { name: "Webflix" }).first()).toBeVisible();
});

test("signed-out visitors are sent to sign in from the app", async ({ page }) => {
  await page.goto("/browse");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fbrowse/);
});
