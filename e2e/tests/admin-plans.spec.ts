/**
 * Plans and prices: a price set (in XTS, the ISO code reserved for testing, so no member's price
 * moves on a shared deployment), then the catalogue synchronised with the payment provider.
 */

import { signInToConsole } from "./admin-helpers.ts";
import { expect, test } from "./fixtures.ts";

test("a price is set and the catalogue synchronised with the provider", async ({ page }) => {
  await signInToConsole(page, "staff-billing", "plans");
  const basic = page.getByRole("region", { name: "Basic" });
  await expect(basic.getByRole("table", { name: "Basic prices" })).toBeVisible();
  const amount = (1 + Math.floor(Math.random() * 9000) / 100).toFixed(2);
  const existing = basic.getByRole("button", { name: "Change the Basic price in XTS" });
  if (await existing.count()) {
    await existing.click();
  } else {
    await basic.getByRole("button", { name: "Add a currency" }).click();
    const add = page.getByRole("dialog", { name: "Add a Basic price" });
    await add.getByLabel("Currency").fill("USD");
    await add.getByLabel(/Monthly price/).fill("3.00");
    await add.getByLabel("Reason").fill("e2e: currency check");
    await add.getByRole("button", { name: /^Set/ }).click();
    // Validated before sending: Basic already has a USD price.
    await expect(add.getByText("Basic already has a USD price: change it instead.")).toBeVisible();
    await add.getByLabel("Currency").fill("XTS");
  }
  const dialog = page.getByRole("dialog", { name: /Basic price/ });
  await dialog.getByLabel(/Monthly price/).fill(amount);
  await dialog.getByLabel("Reason").fill("e2e: test-currency price");
  await dialog.getByRole("button", { name: /^Set .* a month$/ }).click();
  await expect(dialog.getByText(/^Basic now costs .* a month in XTS\./)).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  const row = basic.getByRole("row").filter({ hasText: "XTS" });
  await expect(row).toBeVisible();

  await page.getByRole("button", { name: "Sync with the provider" }).click();
  const sync = page.getByRole("dialog", { name: "Sync with the payment provider" });
  await sync.getByLabel("Reason").fill("e2e: publish the test-currency price");
  await sync.getByRole("button", { name: "Sync now" }).click();
  await expect(sync.getByRole("heading", { name: "Done" })).toBeVisible({ timeout: 30_000 });
  await expect(sync.getByText(/^Synced with /)).toBeVisible();
  await sync.getByRole("button", { name: "Close" }).click();
  await expect(row.getByText("Not synced")).toHaveCount(0);
});
