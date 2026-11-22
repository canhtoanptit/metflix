/**
 * An experiment defined, started, stopped and archived from the console. A status change takes
 * effect for every member at one instant the API names (`statusChangeAt`, up to a minute ahead
 * on Kubernetes and Cloudflare, at once in dev unless configured): the console shows "starts at"
 * with the time and only then "live". The experiment has a layer of its own and is stopped at the
 * end whatever happens.
 */

import { signInToConsole, staffCall } from "./admin-helpers.ts";
import { expect, test } from "./fixtures.ts";

test("define, start (starts at, then live), stop and archive an experiment", async ({ page }) => {
  test.setTimeout(180_000);
  const key = `e2e.console-${Date.now()}`;
  await signInToConsole(page, "staff-experiments", "experiments/new");
  await expect(page.getByRole("heading", { level: 1, name: "New experiment" })).toBeVisible();

  // Validated before anything is sent.
  await page.getByLabel("Key").fill("Not A Key");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/Lowercase letters, digits, dots/).first()).toBeVisible();
  await expect(page.getByText("Give it a name people will recognise.")).toBeVisible();

  await page.getByLabel("Key").fill(key);
  await page.getByLabel("Name", { exact: true }).fill("Console journey");
  await page
    .getByLabel("Hypothesis and notes")
    .fill("Created by the browser suite; stopped when it ends.");
  await page.getByRole("button", { name: "Save draft" }).click();
  const save = page.getByRole("dialog", { name: "Save “Console journey” as a draft" });
  await save.getByLabel("Reason").fill("e2e: define");
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await expect(save.getByRole("heading", { name: "Done" })).toBeVisible();
  await save.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Console journey" })).toBeVisible();
  const status = page
    .getByRole("status")
    .filter({ hasText: /Draft|Starting|Live|Scheduled/ })
    .first();
  await expect(status.getByText("Draft", { exact: true })).toBeVisible();

  try {
    await page.getByRole("button", { name: "Start" }).click();
    const start = page.getByRole("dialog", { name: "Start “Console journey”" });
    await expect(start.getByText(/up to a minute after you confirm/)).toBeVisible();
    await start.getByLabel("Reason").fill("e2e: start");
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" && /\/status$/.test(new URL(response.url()).pathname),
    );
    await start.getByRole("button", { name: "Start", exact: true }).click();
    const definition = (await (await answered).json()) as { statusChangeAt: string | null };
    await expect(start.getByRole("heading", { name: "Done" })).toBeVisible();
    if (definition.statusChangeAt) {
      // The change is scheduled: the console says when, not "live".
      await expect(start.getByText(/takes effect for every member at/)).toBeVisible();
      await start.getByRole("button", { name: "Close" }).click();
      await expect(page.getByText("Starting", { exact: true })).toBeVisible();
      await expect(page.getByText(/Starts at .*\(in \d+ (s|min)\)/)).toBeVisible();
      const waitMs = Date.parse(definition.statusChangeAt) - Date.now() + 15_000;
      await expect(page.getByText("Live", { exact: true })).toBeVisible({
        timeout: Math.max(waitMs, 15_000),
      });
    } else {
      await expect(start.getByText("in effect for every member")).toBeVisible();
      await start.getByRole("button", { name: "Close" }).click();
      await expect(page.getByText("Live", { exact: true })).toBeVisible();
    }

    await page.getByRole("button", { name: "Stop" }).click();
    const stop = page.getByRole("dialog", { name: "Stop “Console journey”" });
    await stop.getByLabel("Reason").fill("e2e: done");
    await stop.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(stop.getByRole("heading", { name: "Done" })).toBeVisible();
    await stop.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText(/Stopping|Completed/).first()).toBeVisible();

    await page.getByRole("button", { name: "Archive" }).click();
    const archive = page.getByRole("dialog", { name: "Archive “Console journey”" });
    await archive.getByLabel("Reason").fill("e2e: tidy up");
    await archive.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(archive.getByRole("heading", { name: "Done" })).toBeVisible();
    await archive.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
  } finally {
    // Whatever happened above, the experiment does not keep assigning members.
    const current = await staffCall("staff-experiments", "GET", `/experiments/${key}`);
    const state = (current.json as { status?: string } | null)?.status;
    if (state === "running" || state === "paused") {
      await staffCall("staff-experiments", "PUT", `/experiments/${key}/status`, {
        status: "completed",
        reason: "e2e: clean-up",
      });
    }
  }

  // The results section says plainly that there is no analysis yet.
  await expect(page.getByText(/No analysis yet/)).toBeVisible();
});
