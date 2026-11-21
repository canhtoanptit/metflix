import { expect, test } from "@playwright/test";
import { cleanLocation, gotoAs } from "./support.ts";

test.describe("session guards", () => {
  test("signed out: app routes send you to sign in, and back after signing in", async ({
    page,
  }) => {
    await gotoAs(page, "/browse", "anonymous");
    await expect(page).toHaveURL(/\/login\?/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Email address").fill("demo@webflix.dev");
    await page.getByLabel("Password", { exact: true }).fill("webflix-demo");
    await page.getByRole("button", { name: "Sign in" }).click();
    // Signed in without a profile: the gate, remembering where we were going.
    await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
    await page.getByRole("button", { name: /^Mara/ }).click();
    await expect(page).toHaveURL(/\/browse/);
    await expect(page.getByRole("region", { name: /Continue Watching for Mara/ })).toBeVisible();
  });

  test("signed out: wrong password shows an inline error", async ({ page }) => {
    await gotoAs(page, "/login", "anonymous");
    await page.getByLabel("Email address").fill("demo@webflix.dev");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Incorrect email or password");
  });

  test("signed in without a profile: the gate guards the app; locked profiles need the PIN", async ({
    page,
  }) => {
    await gotoAs(page, "/my-list", "account");
    await expect(page).toHaveURL(/\/profiles\?redirect=%2Fmy-list/);
    await page.getByRole("button", { name: /^Theo/ }).click();
    const dialog = page.getByRole("dialog", { name: "Profile lock is on" });
    await expect(dialog).toBeVisible();
    await page.keyboard.type("0000");
    await expect(dialog.getByRole("alert")).toContainText("Incorrect PIN");
    // The boxes clear and focus returns to the first one: just type again.
    await expect(dialog.getByLabel("Digit 1 of 4")).toBeFocused();
    await page.keyboard.type("1234");
    await expect(page).toHaveURL(/\/my-list(\?|$)/);
  });

  test("with a profile: guest pages redirect into the app; sign out returns to guest", async ({
    page,
  }) => {
    await gotoAs(page, "/login", "profile");
    await expect(page).toHaveURL(/\/browse/);
    await page.getByRole("button", { name: /Profile menu for Mara/ }).click();
    await page.getByRole("menuitem", { name: "Sign out of Webflix" }).click();
    await expect(page.getByTestId("signed-out")).toBeVisible();
    await page.goto("/browse");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fbrowse/);
  });

  test("unknown URLs render the not-found page", async ({ page }) => {
    await gotoAs(page, "/nowhere", "profile");
    await expect(page.getByRole("heading", { name: "Lost your way?" })).toBeVisible();
    await expect(page).toHaveTitle("Page not found · Webflix");
    expect(cleanLocation(page)).toBe("/nowhere");
  });
});
