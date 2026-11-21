import type { Page } from "@playwright/test";
import { escapeRegExp, findPlayableTitle, PASSWORD, uniqueEmail } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import { fillCard } from "./member-support.ts";

/**
 * The golden path, in one browser session, through the real UI end to end: what a release
 * manager runs on a deployment to trust it on its own.
 *
 * land → sign up → pick a plan → pay → create profiles → browse → open a title → play real
 * video → leave → resume from Continue Watching → sign out.
 */

test.use({
  viewport: { width: 1440, height: 900 },
  launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
});

async function video(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector("video");
    return {
      time: element?.currentTime ?? 0,
      paused: element?.paused ?? true,
      width: element?.videoWidth ?? 0,
    };
  });
}

test("a new member signs up, watches a film, resumes it, and signs out", async ({ page }) => {
  // A whole membership plus real playback: minutes of work, most of it waiting on video.
  test.setTimeout(180_000);
  const email = uniqueEmail("golden");

  await test.step("land and start a membership", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const capture = page
      .getByRole("form", { name: /start your membership or sign back in/ })
      .first();
    await capture.getByLabel("Email address").fill(email);
    await capture.getByRole("button", { name: "Get started" }).click();
    const account = page.getByRole("form", { name: "Create your account" });
    await expect(account.getByLabel("Email address")).toHaveValue(email);
    await account.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await account.getByRole("button", { name: "Continue" }).click();
  });

  await test.step("pick a plan and pay", async () => {
    await expect(page).toHaveURL(/\/signup\/plan/);
    await page.getByRole("radio", { name: /Premium/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/signup\/payment\?plan=premium/);
    await fillCard(page, "4242424242424242");
    await page.getByRole("button", { name: "Start membership" }).click();
  });

  await test.step("create profiles", async () => {
    await expect(page.getByRole("heading", { name: "Who's watching?" })).toBeVisible();
    await page.getByLabel("Your name").fill("Sam");
    await page.getByLabel("Profile 2 name (optional)").fill("Pip");
    await page.getByRole("checkbox", { name: "Kids profile" }).first().check();
    await page.getByRole("button", { name: "Create 2 profiles" }).click();
    await expect(page).toHaveURL(/\/browse/);
    await expect(page.getByRole("button", { name: "Profile menu for Sam" })).toBeVisible();
    await expect(page.getByRole("region", { name: /^Featured: / })).toBeVisible();
  });

  // A film this deployment has packaged media for (never hard-coded: content changes).
  const film = await findPlayableTitle(page.context().request, "movie", { minDurationSec: 60 });
  const name = new RegExp(`^${escapeRegExp(film.name)}`);

  await test.step("find the film and open its details", async () => {
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page
      .getByRole("searchbox", { name: "Search titles, people and genres" })
      .pressSequentially(film.name, { delay: 20 });
    const results = page.getByRole("list", { name: `Results for ${film.name}` });
    await results.getByRole("link", { name }).first().click();
    await expect(page.getByRole("dialog", { name: film.name })).toBeVisible();
  });

  let leftAt = 0;
  await test.step("play real video, skip ahead, and leave", async () => {
    await page
      .getByRole("dialog", { name: film.name })
      .getByRole("link", { name: /^Play/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/watch/${film.id}`));
    await expect.poll(async () => (await video(page)).time, { timeout: 45_000 }).toBeGreaterThan(1);
    expect((await video(page)).width).toBeGreaterThan(0);
    // Skip ahead with the keyboard past the point that counts as "in progress" (30 s).
    for (let press = 0; press < 4; press += 1) await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => (await video(page)).time, { timeout: 30_000 })
      .toBeGreaterThan(41);
    await expect.poll(async () => (await video(page)).paused).toBe(false);
    leftAt = (await video(page)).time;
    await page.mouse.move(400, 300);
    await page.getByRole("button", { name: /^Back/ }).first().click();
    await expect(page).not.toHaveURL(/\/watch\//);
  });

  await test.step("resume from Continue Watching", async () => {
    await page.goto("/browse");
    const row = page.getByRole("region", { name: "Continue Watching for Sam" });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name }).first().click();
    const dialog = page.getByRole("dialog", { name: film.name });
    await dialog
      .getByRole("link", { name: /^Resume/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/watch/${film.id}`));
    await expect
      .poll(async () => (await video(page)).time, { timeout: 45_000 })
      .toBeGreaterThan(leftAt - 2);
    await expect.poll(async () => (await video(page)).paused).toBe(false);
    await page.mouse.move(400, 300);
    await page.getByRole("button", { name: /^Back/ }).first().click();
    // Back returns to the details it was played from.
    await expect(page).toHaveURL(new RegExp(`/browse\\?title=${film.id}`));
    await expect(page.getByRole("dialog", { name: film.name })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  await test.step("sign out", async () => {
    await page.getByRole("button", { name: "Profile menu for Sam" }).click();
    await page.getByRole("menuitem", { name: "Sign out of Webflix" }).click();
    await expect(page.getByRole("heading", { name: "You've signed out" })).toBeVisible();
    await page.goto("/browse");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fbrowse/);
  });
});
