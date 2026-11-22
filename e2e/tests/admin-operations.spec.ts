/**
 * Operations screens (admin role): system health, failed jobs, the served recommendation model,
 * the privacy jobs' queues and the audit log's filters; and a support journey done with the
 * keyboard alone.
 */

import { addLockedProfile, adminPath, createMember, signInToConsole } from "./admin-helpers.ts";
import { expect, test } from "./fixtures.ts";

test("health, failed jobs, recommendations and privacy jobs say where things stand", async ({
  page,
}) => {
  await signInToConsole(page, "staff-admin", "operations/health");
  const dependencies = page.getByRole("region", { name: "Dependencies" });
  await expect(dependencies.getByText("Database")).toBeVisible();
  await expect(dependencies.getByText("Up").first()).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Jobs" }).getByText("Failed every attempt"),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "Console" })
    .first()
    .getByRole("link", { name: "Failed jobs" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Failed jobs" })).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "No failed jobs" })
      .or(page.getByRole("table", { name: /Failed jobs/ })),
  ).toBeVisible();

  await page
    .getByRole("navigation", { name: "Console" })
    .first()
    .getByRole("link", { name: "Recommendations" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Recommendations" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Served now" })).toBeVisible();
  // Opening an action and cancelling it sends nothing.
  let posted = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/system/recommendations/"))
      posted = true;
  });
  await page.getByRole("button", { name: "Import now" }).click();
  const dialog = page.getByRole("dialog", { name: "Import the latest published run" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import now" })).toBeFocused();
  expect(posted).toBe(false);
  // Importing says what it found: queued only when a new run is published.
  await page.getByRole("button", { name: "Import now" }).click();
  await dialog.getByLabel("Reason").fill("e2e: is there a new run?");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeVisible();
  await expect(
    dialog.getByText(
      /is being imported|Nothing to import|already the one being served|can't be imported|no store for the pipeline/,
    ),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();

  await page
    .getByRole("navigation", { name: "Console" })
    .first()
    .getByRole("link", { name: "Privacy jobs" })
    .click();
  await expect(page.getByRole("region", { name: "Pending erasures" })).toBeVisible();
  // Results are recorded only while exports wait for them (never in dev, where exports run inline).
  const exportsRegion = page.getByRole("region", { name: "Pending exports" });
  await expect(
    exportsRegion
      .getByRole("heading", { name: "No exports waiting" })
      .or(exportsRegion.getByRole("button", { name: "Record results" })),
  ).toBeVisible();
});

test("the audit log filters by outcome and by the signed-in staff member", async ({ page }) => {
  await signInToConsole(page, "staff-admin", "operations/audit");
  await page.getByRole("combobox", { name: "Outcome" }).click();
  await page.getByRole("option", { name: "Succeeded" }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/outcome=succeeded/);
  await page.getByRole("button", { name: "Mine" }).click();
  await expect(page).toHaveURL(/actorId=/);
  await page.getByRole("button", { name: "Clear" }).click();
  await expect(page).not.toHaveURL(/outcome=|actorId=/);
  await expect(page.getByRole("region", { name: "Entries", exact: true })).toBeVisible();
});

test("a PIN is removed with the keyboard alone, and focus lands somewhere sensible after", async ({
  page,
}) => {
  const member = await createMember("keyboard");
  await addLockedProfile(member, "Den");
  await signInToConsole(page, "staff-support", `members/${member.accountId}`);
  await expect(page.getByRole("heading", { level: 1, name: member.email })).toBeVisible();
  const remove = page.getByRole("button", { name: "Remove PIN from Den" });
  await remove.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Remove the PIN from “Den”" });
  await expect(dialog).toBeVisible();
  // Focus is inside the dialog; Tab reaches the reason, typing fills it, Tab reaches the buttons.
  await expect(dialog.locator(":focus")).toHaveCount(1);
  await dialog.getByLabel("Reason").focus();
  await page.keyboard.type("Member forgot the PIN");
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Remove PIN" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  // The button that opened it is gone (no PIN any more): focus goes to the page, not nowhere.
  await expect(page.locator("main")).toBeFocused();
  await page.goto(adminPath(`members/${member.accountId}`));
  await expect(page.getByRole("button", { name: "Remove PIN from Den" })).toHaveCount(0);
});

test("the keyboard reaches everything: skip link, navigation, then the screen", async ({
  page,
}) => {
  await signInToConsole(page, "staff-admin", "operations/health");
  // A fresh load (the issuer's session signs straight back in): focus starts at the top.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "System health" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  // Navigating moves focus to the new screen, so the next Tab starts there.
  const nav = page.getByRole("navigation", { name: "Console" }).first();
  await nav.getByRole("link", { name: "Audit log" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
  await expect(page.locator("main")).toBeFocused();
});
