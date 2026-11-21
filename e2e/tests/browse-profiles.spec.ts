import { createAccount, createProfile } from "./api.ts";
import { firstCard, row } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("the demo Kids profile", () => {
  test.use({ demo: "Kids" });

  test("kids profile: marked as Kids, kid-safe ratings only, and a menu without account settings", async ({
    page,
  }) => {
    await page.goto("/browse");
    await expect(page.getByRole("link", { name: "Webflix Kids home" })).toBeVisible();
    const ratings = await page.request.get("/api/v1/browse?view=home");
    const body = (await ratings.json()) as { rows: Array<{ items: unknown[] }> };
    const maturities = JSON.stringify(body).match(/"maturity":"([^"]+)"/g) ?? [];
    expect(maturities.every((value) => /"(ALL|7\+)"/.test(value))).toBe(true);

    await page.getByRole("button", { name: "Profile menu for Kids" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Exit Kids" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Account" })).toHaveCount(0);
    await expect(menu.getByRole("menuitem", { name: "Sign out of Webflix" })).toHaveCount(0);
  });
});

// Switching profile and signing out change the session: each on its own fresh account.
test("the profile menu switches straight to another profile", async ({ page }) => {
  const request = page.context().request;
  await createAccount(request, { profileName: "Sam", tag: "switch" });
  await createProfile(request, { name: "Pip" });
  await page.goto("/browse");
  await expect(row(page, "Trending Now")).toBeVisible();
  await page.getByRole("button", { name: "Profile menu for Sam" }).click();
  await page.getByRole("menuitem", { name: "Pip" }).click();
  await expect(page.getByRole("button", { name: "Profile menu for Pip" })).toBeVisible();
  await expect(page).toHaveURL(/\/browse$/);
  await expect(row(page, "Trending Now")).toBeVisible();
  const session = (await (await request.get("/api/v1/session")).json()) as {
    activeProfile: { name: string } | null;
  };
  expect(session.activeProfile?.name).toBe("Pip");
});

test("the session ending mid-browse leads to sign in, says why, and comes back to the title", async ({
  page,
}) => {
  // Previews off, so no clip keeps the network busy and the page can settle.
  await createAccount(page.context().request, {
    tag: "ended",
    profile: { settings: { autoplayPreviews: false } },
  });
  await page.goto("/browse");
  await expect(row(page, "Trending Now")).toBeVisible();
  // Let the page finish loading (later batches of rows, images). Otherwise a request still in
  // flight meets the revoked session first and the app signs out by itself, before the title
  // is chosen: correct behaviour, but not the journey this spec is about.
  await page.waitForLoadState("networkidle");
  // Signed out elsewhere: the same session is revoked server-side.
  const logout = await page.request.post("/api/v1/auth/logout", {
    headers: { "X-Webflix-Client": "web" },
  });
  expect(logout.ok()).toBe(true);
  // Keyboard, so no pointer hover gets there first (a preview would prefetch the details).
  await firstCard(row(page, "Trending Now")).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/login\?redirect=%2Fbrowse%3Ftitle%3D/);
  await expect(page.getByText("You've been signed out", { exact: true })).toBeVisible();
});

test.describe("the demo account", () => {
  test.use({ demo: "Alex" });

  test("reduced motion: no preview clips, and the overlay simply fades", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const clips: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/cdn/previews/")) clips.push(request.url());
    });
    await page.goto("/browse");
    await page.waitForTimeout(3500);
    const trending = row(page, "Trending Now");
    await trending.scrollIntoViewIfNeeded();
    await firstCard(trending).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(1500);
    expect(clips).toEqual([]);
  });

  test("previews play progressive clips: the browse page never downloads hls.js", async ({
    page,
  }) => {
    const scripts: string[] = [];
    page.on("request", (request) => scripts.push(request.url()));
    await page.goto("/browse");
    // The billboard clip starts after a beat.
    await expect
      .poll(() => scripts.some((url) => url.includes("/cdn/previews/")), { timeout: 10_000 })
      .toBe(true);
    expect(
      scripts.filter((url) => /hls(\.light)?(\.min)?\.m?js|hls__js|\/assets\/hls-/.test(url)),
    ).toEqual([]);
  });
});
