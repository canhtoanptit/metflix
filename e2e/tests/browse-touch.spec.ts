import type { Page } from "@playwright/test";
import { createAccount } from "./api.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Touch: every navigation menu opens on the first tap. The menus' code loads on intent (or once
 * the page is idle) and the real trigger replaces a stand-in; a tap that landed half on one and
 * half on the other used to open the menu and close it again in the same gesture.
 *
 * Opening notifications marks them read (a change), so those specs use a fresh account.
 */

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true } as const;

/** Hold back a lazily loaded module (dev: its source; production: its chunk) until released. */
async function holdModule(page: Page, name: string): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(new RegExp(`/${name}[^/]*\\.(js|tsx)(\\?|$)`), async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

test.describe("phones", () => {
  test.use(PHONE);

  test("one tap opens notifications as a full-screen sheet, and it stays open", async ({
    page,
  }) => {
    await createAccount(page.context().request, { tag: "touch-bell" });
    await page.goto("/browse");
    const bell = page.getByRole("button", { name: /^Notifications/ });
    await expect(bell).toBeVisible();
    await bell.tap();
    const sheet = page.getByRole("dialog", { name: "Notifications" });
    await expect(sheet).toBeVisible();
    // Proving that nothing closes it: the tap's own click must not toggle it shut.
    await page.waitForTimeout(400);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-testid", "notifications-sheet");
    const box = await sheet.boundingBox();
    expect(box?.width).toBe(PHONE.viewport.width);
    expect(box?.height).toBe(PHONE.viewport.height);
    await sheet.getByRole("button", { name: "Close" }).tap();
    await expect(sheet).toBeHidden();
  });

  test("a tap before the menu's code has arrived opens it once the code is in", async ({
    page,
  }) => {
    await createAccount(page.context().request, { tag: "touch-early" });
    const release = await holdModule(page, "NotificationsMenu");
    await page.goto("/browse");
    const bell = page.getByRole("button", { name: /^Notifications/ });
    await expect(bell).toBeVisible();
    await bell.tap();
    release();
    const sheet = page.getByRole("dialog", { name: "Notifications" });
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(400);
    await expect(sheet).toBeVisible();
  });

  test.describe("menus on the shared demo profile", () => {
    test.use({ demo: "Alex" });

    test("the profile menu and Categories open on the first tap", async ({ page }) => {
      await page.goto("/browse");
      await page.getByRole("button", { name: /^Profile menu for / }).tap();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden();

      await page.getByRole("button", { name: "Categories" }).tap();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.waitForTimeout(400);
      await expect(page.getByRole("menu")).toBeVisible();
    });

    test("the profile menu opens on the first tap even before its code has arrived", async ({
      page,
    }) => {
      const release = await holdModule(page, "ProfileMenu");
      await page.goto("/browse");
      const trigger = page.getByRole("button", { name: /^Profile menu for / });
      await expect(trigger).toBeVisible();
      await trigger.tap();
      release();
      await expect(page.getByRole("menu")).toBeVisible();
    });
  });
});

test.describe("tablets", () => {
  test.use({ viewport: { width: 834, height: 1112 }, hasTouch: true });

  test("one tap opens the notifications popover under the bell", async ({ page }) => {
    await createAccount(page.context().request, { tag: "touch-tablet" });
    await page.goto("/browse");
    const bell = page.getByRole("button", { name: /^Notifications/ });
    await bell.tap();
    const popover = page.getByRole("dialog", { name: "Notifications" });
    await expect(popover).toBeVisible();
    await page.waitForTimeout(400);
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box?.width).toBeLessThan(834);
  });

  test.describe("on the shared demo profile", () => {
    test.use({ demo: "Alex" });

    test("the folded primary navigation opens on the first tap", async ({ page }) => {
      await page.goto("/browse");
      await page.getByRole("navigation", { name: "Primary" }).getByRole("button").tap();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.waitForTimeout(400);
      await expect(page.getByRole("menu")).toBeVisible();
    });
  });
});
