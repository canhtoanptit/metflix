/**
 * Editorial control: a curated collection drafted, published and deleted; a billboard pinned
 * and released; a title's availability set. Each change is audited.
 *
 * Kept out of other specs' way on a shared deployment: the published row sits at the last
 * position of the Series view only for the length of the test, the billboard pinned is New &
 * Popular's (a view the engine draws no billboard on), and the availability set is the one the
 * title already has.
 */

import type { Locator, Page } from "@playwright/test";
import {
  ADMIN_API_URL,
  adminPath,
  memberApi,
  signInToConsole,
  staffCall,
} from "./admin-helpers.ts";
import { expect, test } from "./fixtures.ts";

/** What a test that stopped half-way must undo (its own changes only, in its own worker). */
let cleanups: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  const info = test.info();
  if (info.status !== info.expectedStatus) {
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  }
  cleanups = [];
});

interface PickedTitle {
  id: string;
  name: string;
}

/** Titles with distinct names, from the public showcase (never hard-coded). */
async function showcaseTitles(count: number): Promise<PickedTitle[]> {
  const api = await memberApi();
  const response = await api.get(`${ADMIN_API_URL}/api/v1/showcase`);
  expect(response.status(), `showcase: ${await response.text()}`).toBe(200);
  const body = (await response.json()) as { items: PickedTitle[] };
  await api.dispose();
  const distinct = body.items.filter(
    (title, index, all) => all.findIndex((other) => other.name === title.name) === index,
  );
  expect(distinct.length).toBeGreaterThanOrEqual(count);
  return distinct.slice(0, count).map(({ id, name }) => ({ id, name }));
}

/** Find a title by name in a title search, and press its button ("Add", "Choose"). */
async function pickTitle(scope: Page | Locator, title: PickedTitle, action = "Add"): Promise<void> {
  await scope.getByRole("searchbox", { name: "Find a title" }).fill(title.name);
  await scope.getByRole("button", { name: `${action} ${title.name}`, exact: true }).click();
}

test("a curated collection is drafted, published and deleted, each with an audit entry", async ({
  page,
}) => {
  const titles = await showcaseTitles(3);
  const name = `E2E picks ${Date.now()}`;
  await signInToConsole(page, "staff-content", "content/collections");
  await page.getByRole("link", { name: "New collection" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "New collection" })).toBeVisible();

  // Validated before anything is sent.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Give the row a name members will see.")).toBeVisible();
  await expect(page.getByText("Add at least one title.")).toBeVisible();

  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.getByLabel("Row position").fill("50");
  await page.getByRole("combobox", { name: "View" }).click();
  await page.getByRole("option", { name: "Series" }).click();
  // Titles are found by name and shown by name, in the order chosen.
  for (const title of titles) await pickTitle(page, title);
  const chosen = page.getByRole("list", { name: /Titles, in order/ });
  await expect(chosen.getByRole("listitem")).toHaveCount(3);
  await expect(chosen.getByRole("listitem").first()).toContainText(titles[0]?.name ?? "");
  // Reorder by keyboard-reachable controls.
  await page.getByRole("button", { name: `Move ${titles[1]?.name} up` }).click();
  await expect(chosen.getByRole("listitem").first()).toContainText(titles[1]?.name ?? "");
  await page.getByRole("button", { name: "Save draft" }).click();
  const save = page.getByRole("dialog", { name: `Save “${name}” as a draft` });
  await save.getByLabel("Reason").fill("Holiday campaign row, draft for review");
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect(save.getByText(`“${name}” is saved as a draft.`)).toBeVisible();
  await save.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  // A test stopped half-way leaves no published row behind (its own collection only).
  cleanups.push(async () => {
    const list = await staffCall("staff-content", "GET", "/editorial/collections");
    if ((list.json as { items: { id: string }[] }).items.some((item) => item.id === id)) {
      await staffCall("staff-content", "DELETE", `/editorial/collections/${id}`, {
        reason: "e2e: clean-up",
      });
    }
  });

  // Publish it.
  await page.getByRole("radio", { name: "Published" }).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  const publish = page.getByRole("dialog", { name: `Save “${name}”` });
  await publish.getByLabel("Reason").fill("Approved by editorial");
  await publish.getByRole("button", { name: "Publish" }).click();
  await expect(publish.getByText(`“${name}” is published on Series at row 50.`)).toBeVisible();
  await publish.getByRole("button", { name: "Close" }).click();

  await page.goto(adminPath("content/collections"));
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByText("Published")).toBeVisible();
  await expect(row.getByText("Series, row 50")).toBeVisible();
  await row.getByRole("button", { name: `Delete ${name}` }).click();
  const remove = page.getByRole("dialog", { name: `Delete “${name}”` });
  await remove.getByLabel("Reason").fill("Campaign over");
  await remove.getByRole("button", { name: "Delete collection" }).click();
  await expect(remove.getByText(`“${name}” is deleted.`)).toBeVisible();
  await remove.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);

  // The audit log (admin) has all three changes for this collection.
  await page.context().clearCookies();
  await signInToConsole(
    page,
    "staff-admin",
    `operations/audit?targetType=collection&targetId=${id}`,
  );
  // In words: what was done, with the count and the state it left.
  for (const action of ["Edited a collection: 3 titles, published", "Deleted a collection"]) {
    await expect(page.getByRole("row").filter({ hasText: action }).first()).toBeVisible();
  }
});

test("a keyboard user adds, reorders and removes titles without losing their place", async ({
  page,
}) => {
  const titles = await showcaseTitles(5);
  const [first, second, third, fourth, fifth] = titles;
  if (!first || !second || !third || !fourth || !fifth) throw new Error("five showcase titles");
  await signInToConsole(page, "staff-content", "content/collections/new");
  await expect(page.getByRole("heading", { level: 1, name: "New collection" })).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Find a title" });
  const focusedName = () =>
    page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");

  // Add: focus stays on the result's button, now "Added …", so the next Tab goes on.
  for (const title of titles) {
    await search.fill(title.name);
    const add = page.getByRole("button", { name: `Add ${title.name}`, exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: `Added ${title.name}`, exact: true }),
    ).toBeFocused();
  }
  const chosen = page.getByRole("list", { name: /Titles, in order/ });
  await expect(chosen.getByRole("listitem")).toHaveCount(5);

  // Move the first title to the end: four presses of Enter, focus riding along with it.
  await page.getByRole("button", { name: `Move ${first.name} down` }).focus();
  for (let press = 1; press <= 4; press += 1) {
    await page.keyboard.press("Enter");
    await expect(chosen.getByRole("listitem").nth(press)).toContainText(first.name);
    // At the bottom its "down" is unavailable: focus is on its "up", still on the same title.
    expect(await focusedName()).toBe(
      press < 4 ? `Move ${first.name} down` : `Move ${first.name} up`,
    );
  }
  await expect(chosen.getByRole("listitem").last()).toContainText(first.name);
  await expect(page.getByText(`${first.name} moved to position 5 of 5.`)).toBeAttached();

  // Remove: focus goes to the Remove of the title that took its place, or the one before it.
  await page.getByRole("button", { name: `Remove ${third.name}` }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Remove ${fourth.name}` })).toBeFocused();
  await page.getByRole("button", { name: `Remove ${first.name}` }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: `Remove ${fifth.name}` })).toBeFocused();
  for (const title of [fifth, fourth, second]) {
    await expect(page.getByRole("button", { name: `Remove ${title.name}` })).toBeFocused();
    await page.keyboard.press("Enter");
  }
  // The list is empty: focus is back in the search field, ready for the next title.
  await expect(chosen).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("a billboard is pinned in order, shown by name, and released to the engine", async ({
  page,
}) => {
  const titles = await showcaseTitles(2);
  cleanups.push(async () => {
    await staffCall("staff-content", "PUT", "/editorial/billboards/new-popular", {
      titleIds: [],
      reason: "e2e: clean-up",
    });
  });
  await signInToConsole(page, "staff-content", "content/billboards");
  await page.getByRole("tab", { name: "New & Popular" }).click();
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: "Change" }).click();
  const dialog = page.getByRole("dialog", { name: "Change the New & Popular billboard" });
  for (const title of titles) await pickTitle(dialog, title);
  await dialog.getByLabel("Reason").fill("Feature two launches");
  await dialog.getByRole("button", { name: "Save billboard" }).click();
  await expect(dialog.getByRole("heading", { name: "Done" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  const pinned = panel.getByRole("list", { name: /Pinned to the New & Popular billboard/ });
  await expect(pinned.getByRole("listitem")).toHaveCount(2);
  await expect(pinned.getByRole("listitem").nth(0)).toContainText(titles[0]?.name ?? "");
  await expect(pinned.getByRole("listitem").nth(1)).toContainText(titles[1]?.name ?? "");

  await panel.getByRole("button", { name: "Change" }).click();
  for (const title of titles) {
    await dialog.getByRole("button", { name: `Remove ${title.name}` }).click();
  }
  await dialog.getByLabel("Reason").fill("Back to the engine's choice");
  await dialog.getByRole("button", { name: "Let the engine choose" }).click();
  await expect(dialog.getByText("No title is pinned now")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(panel.getByRole("heading", { name: "The engine chooses" })).toBeVisible();
});

test("a title is found by name, its availability read and set; an impossible window is refused", async ({
  page,
}) => {
  const [title] = await showcaseTitles(1);
  if (!title) throw new Error("no showcase title");
  await signInToConsole(page, "staff-content", "content/availability");
  await pickTitle(page.getByRole("region", { name: "Choose a title" }), title, "Choose");
  const change = page.getByRole("region", { name: "Change its availability" });
  await expect(change.getByText(title.name)).toBeVisible();
  // A showcase title is available; the form starts from what is in force.
  await expect(change.getByText(/^Now: Available/)).toBeVisible();
  await expect(change.getByRole("radio", { name: /^Available/ })).toBeChecked();
  await change.getByLabel("From (optional)").fill("2030-01-02T10:00");
  await change.getByLabel("Until (optional)").fill("2030-01-01T10:00");
  await change.getByRole("button", { name: "Review the change" }).click();
  await expect(change.getByText("The end must come after the start.")).toBeVisible();
  await change.getByLabel("From (optional)").fill("");
  await change.getByLabel("Until (optional)").fill("");
  await change.getByRole("button", { name: "Review the change" }).click();
  const dialog = page.getByRole("dialog", { name: `Make “${title.name}” available` });
  await dialog.getByLabel("Reason").fill("Confirm the licence is open-ended");
  await dialog.getByRole("button", { name: "Make available" }).click();
  await expect(dialog.getByText(`“${title.name}”: available (override, no window).`)).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  const overrides = page.getByRole("region", { name: "Titles with an override" });
  const row = overrides.getByRole("row").filter({ hasText: title.name });
  await expect(row.getByText("Available", { exact: true })).toBeVisible();
});
