import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { CARDS, CLIENT_HEADERS, createAccount, PASSWORD, uniqueEmail } from "./member-support.ts";

/**
 * Member screens whose layout or behaviour depends on the engine (dialogs, fixed bars, toasts),
 * run by the chromium, firefox and webkit projects. Each journey works on its own fresh account.
 *
 * Controls are activated from the keyboard: on a macOS host whose display is asleep or locked,
 * Playwright's WebKit misses every pointer click (it reports `<html> intercepts pointer events`
 * even for a button on a bare test page), and the keyboard is a path every member must have
 * anyway.
 */

test.use({ viewport: { width: 1440, height: 900 } });

/** Focus and press: Enter for buttons and links, Space for checkboxes and radios. */
async function press(locator: Locator, key: "Enter" | "Space" = "Enter"): Promise<void> {
  await locator.focus();
  await locator.press(key);
}

test("landing: a Now on Webflix poster opens a teaser that ends in Get started", async ({
  page,
}) => {
  await page.goto("/");
  const strip = page.getByRole("region", { name: "Now on Webflix" });
  await strip.scrollIntoViewIfNeeded();
  const first = strip.getByRole("button").first();
  await expect(first).toBeVisible();
  await press(first);
  const teaser = page.getByRole("dialog");
  await expect(teaser).toBeVisible();
  await expect(teaser).toContainText(/(Film|Series) on Webflix/);
  const email = uniqueEmail("xb-teaser");
  await teaser.getByRole("textbox", { name: /Email/ }).fill(email);
  await press(teaser.getByRole("button", { name: "Get started" }));
  await expect(page).toHaveURL(new RegExp(`/signup\\?email=${encodeURIComponent(email)}`));
});

test("sign-up step 4: a kids row and a chosen picture, without the password", async ({ page }) => {
  const email = uniqueEmail("xb-step4");
  const signup = await page.context().request.post("/api/v1/auth/signup", {
    headers: CLIENT_HEADERS,
    data: {
      email,
      password: PASSWORD,
      planId: "standard",
      payment: {
        method: "card",
        cardNumber: CARDS.approved,
        expMonth: 12,
        expYear: new Date().getFullYear() + 3,
        cvc: "123",
        nameOnCard: "E2E Tester",
      },
    },
  });
  expect(signup.status()).toBe(201);
  await page.goto("/signup/profile");
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Profile 2 name (optional)").fill("Pip");
  const kids = page.getByRole("checkbox", { name: "Profile 2 is a kids profile" });
  await press(kids, "Space");
  await expect(kids).toBeChecked();
  await press(page.getByRole("button", { name: "Choose a picture for Pip" }));
  const picker = page.getByRole("dialog", { name: "Choose a profile picture" });
  const choice = picker.getByRole("radio").last();
  const chosen = (await choice.getAttribute("aria-label")) ?? "";
  await press(choice, "Space");
  await expect(choice).toBeChecked();
  await press(picker.getByRole("button", { name: "Use this picture" }));
  await expect(picker).toBeHidden();
  await press(page.getByRole("button", { name: "Create 2 profiles" }));
  await expect(page).toHaveURL(/\/browse/);
  const session = await (await page.context().request.get("/api/v1/session")).json();
  const pip = session.profiles.find((profile: { name: string }) => profile.name === "Pip");
  expect(pip).toMatchObject({ isKids: true, avatar: { name: chosen } });
});

test("profile edit: the Save bar spans the screen on a solid surface, toasts sit above it", async ({
  page,
}) => {
  const account = await createAccount(page.context().request, { tag: "xb-savebar" });
  await page.goto(`/profiles/${account.profileId}/edit`);
  const save = page.getByRole("button", { name: "Save" });
  await expect(save).toBeVisible();
  const bar = save.locator("xpath=ancestor::div[contains(@class,'fixed')][1]");
  const box = await bar.boundingBox();
  expect(box?.x).toBe(0);
  expect(Math.round((box?.x ?? 0) + (box?.width ?? 0))).toBe(1440);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(900);
  const background = await bar.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toMatch(/rgba\(.*, 0(\.\d+)?\)$|transparent/);

  // A toast while the page stays put: locking the profile.
  await press(page.getByRole("button", { name: "Add a PIN" }));
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Digit 1 of 4").pressSequentially("2580");
  await dialog.getByLabel("Account password").fill(account.password);
  await press(dialog.getByRole("button", { name: "Save PIN" }));
  const toast = page.locator("li").filter({ hasText: "Sam is locked" });
  await expect(toast).toBeVisible();
  const toastBox = await toast.boundingBox();
  const barBox = await bar.boundingBox();
  expect((toastBox?.y ?? 0) + (toastBox?.height ?? 0)).toBeLessThanOrEqual(barBox?.y ?? 0);
});
