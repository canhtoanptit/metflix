/**
 * Operations screens (admin role): system health with the privacy work waiting, failed jobs,
 * the served recommendation model, the privacy jobs' queues and the audit log's filters; and a
 * support journey done with the keyboard alone.
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
  // The privacy work waiting, from the health answer, each line with its normal wait.
  const privacy = page.getByRole("region", { name: "Privacy work" });
  for (const line of [
    "Account erasures in progress",
    "Erasures waiting for the event lake",
    "Data exports waiting for events",
  ]) {
    await expect(privacy.getByText(line)).toBeVisible();
  }
  await expect(privacy.getByText(/^Normal wait:/).first()).toBeVisible();

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
      /is being imported|Nothing to import|already served, exactly as published|can't be imported|no store for the pipeline/,
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

test("overdue privacy work is impossible to miss, on health and on the overview", async ({
  page,
}) => {
  // The real health answer, with its privacy backlog aged past each normal wait (a stuck
  // erasure, a lake erase that stopped, exports nobody processes).
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  await page.route(/\/api\/admin\/v1\/system\/health$/, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { privacy: Record<string, unknown> };
    body.privacy = {
      erasuresInProgress: 1,
      oldestErasureInProgressAt: hoursAgo(1),
      oldestErasureInProgressAgeSec: 3600,
      pendingErasures: 4,
      oldestPendingErasureAt: hoursAgo(50),
      oldestPendingErasureAgeSec: 50 * 3600,
      waitingExports: 2,
      oldestWaitingExportAt: hoursAgo(3),
      oldestWaitingExportAgeSec: 3 * 3600,
    };
    await route.fulfill({ response, json: body });
  });
  await signInToConsole(page, "staff-admin", "operations/health");
  const privacy = page.getByRole("region", { name: "Privacy work" });
  await expect(privacy.getByText("Privacy work is overdue")).toBeVisible();
  await expect(privacy.getByText(/it keeps failing/)).toBeVisible();
  await expect(privacy.getByText(/daily erase job isn't running/)).toBeVisible();
  await expect(privacy.getByText(/nobody is processing exports/)).toBeVisible();
  await expect(privacy.getByText("Overdue", { exact: true })).toHaveCount(3);
  await expect(privacy.getByText("Oldest waiting 2 days 2 h", { exact: false })).toBeVisible();
  // The overview lists each overdue line with what needs attention.
  await page.getByRole("link", { name: "Overview" }).first().click();
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByText(/Account erasures in progress: 1/)).toBeVisible();
  await expect(attention.getByText(/Data exports waiting for events: 2/)).toBeVisible();
});

test("the served run rewritten after an erasure is said to be applied in place", async ({
  page,
}) => {
  await page.route(/\/api\/admin\/v1\/system\/recommendations\/import$/, async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        activeModel: {
          run: "2026-11-23T04-00-00Z",
          asOf: "2026-11-23T00:00:00.000Z",
          expiresAt: "2026-11-26T00:00:00.000Z",
          importedAt: "2026-11-23T04:20:00.000Z",
        },
        lastImport: null,
        outcome: "queued",
        run: "2026-11-23T04-00-00Z",
        detail: null,
      },
    });
  });
  await signInToConsole(page, "staff-admin", "operations/recommendations");
  await page.getByRole("button", { name: "Import now" }).click();
  const dialog = page.getByRole("dialog", { name: "Import the latest published run" });
  await dialog.getByLabel("Reason").fill("e2e: the pipeline rewrote the served run");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByText(/published again with corrected content/)).toBeVisible();
  await expect(dialog.getByText(/applies it in place/)).toBeVisible();
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
  // Reading the log is itself recorded: a view, listed only when views are asked for.
  await expect(page.getByRole("row").filter({ hasText: "Read the audit log" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Show" }).click();
  await page.getByRole("option", { name: "Views only" }).click();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/show=views/);
  await expect(
    page.getByRole("row").filter({ hasText: "Read the audit log" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Removed a profile PIN" })).toHaveCount(0);
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
  // The way to its entry first (their own actions, without the admin role), then Close.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("link", { name: "See it in your actions" })).toBeFocused();
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
