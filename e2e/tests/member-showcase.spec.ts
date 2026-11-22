import { expect, test } from "./fixtures.ts";
import { expectAccessible, uniqueEmail } from "./member-support.ts";

/**
 * Signed-out artwork comes from the public showcase (`GET /showcase`), against the real API:
 * versioned URLs, requested with the navigation, and a landing page that works without it.
 */

interface ShowcaseBody {
  items: Array<{ id: string; images: { poster: { template: string } } }>;
}

test("the landing page draws the showcase's artwork, requested with the navigation", async ({
  page,
}) => {
  const titleImages: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/cdn/img/titles/"))
      titleImages.push(`${url.pathname}${url.search}`);
  });
  const showcase = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/v1/showcase",
  );
  await page.goto("/");
  const response = await showcase;
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toMatch(/^public\b/);
  const body = (await response.json()) as ShowcaseBody;
  expect(body.items.length).toBeGreaterThan(0);

  await expect(page.getByRole("heading", { name: "Now on Webflix" })).toBeVisible();
  // The hero's centre row is fetched eagerly at high priority: the likely LCP image.
  await expect(page.locator('img[fetchpriority="high"]').first()).toBeAttached();
  await expect.poll(() => titleImages.length).toBeGreaterThan(0);
  const showcased = new Set(body.items.map((item) => item.id));
  for (const path of titleImages) {
    expect(showcased.has(path.split("/")[4] ?? ""), `${path} is not in the showcase`).toBe(true);
  }
  // Generated artwork carries its content hash, so immutable caching never shows a stale image.
  if (body.items[0]?.images.poster.template.includes("?v=")) {
    expect(titleImages.every((path) => path.includes("?v="))).toBe(true);
  }
});

test("without the showcase the landing page still works, just without artwork", async ({
  page,
}) => {
  await page.route("**/api/v1/showcase", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "urn:webflix:problem:service_unavailable",
        title: "Service temporarily unavailable",
        status: 503,
        code: "service_unavailable",
      }),
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Stories that stay with you." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose your plan" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /Email/ }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Now on Webflix" })).toHaveCount(0);
  await expect(page.locator('img[src*="/cdn/img/titles/"]')).toHaveCount(0);
});

test("Now on Webflix: whole posters only, each opening a teaser that ends in Get started", async ({
  page,
}) => {
  for (const width of [390, 834, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const strip = page.getByRole("region", { name: "Now on Webflix" });
    await strip.scrollIntoViewIfNeeded();
    const posters = strip.getByRole("button").filter({ visible: true });
    await expect(posters.first()).toBeVisible();
    // Never a cut-off poster: every visible one sits wholly inside the viewport's width.
    for (const box of await posters.evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().toJSON() as DOMRect),
    )) {
      expect(box.left, `poster at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(box.right, `poster at ${width}px`).toBeLessThanOrEqual(width);
    }
  }

  const strip = page.getByRole("region", { name: "Now on Webflix" });
  const first = strip.getByRole("button").first();
  const name = ((await first.textContent()) ?? "").replace(/, (film|series)$/, "");
  await first.click();
  const teaser = page.getByRole("dialog", { name });
  await expect(teaser).toBeVisible();
  await expect(teaser).toContainText(/(Film|Series) on Webflix/);
  await expectAccessible(page);
  const email = uniqueEmail("teaser");
  await teaser.getByRole("textbox", { name: /Email/ }).fill(email);
  await teaser.getByRole("button", { name: "Get started" }).click();
  await expect(page).toHaveURL(new RegExp(`/signup\\?email=${encodeURIComponent(email)}`));
});

test("the hero's poster wall reaches both edges of a 2560 px screen", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto("/");
  await expect(page.locator('img[fetchpriority="high"]').first()).toBeAttached();
  const reach = await page.evaluate(() => {
    const hero = document.querySelector("section");
    const posters = [...(hero?.querySelectorAll("img") ?? [])].map((img) =>
      img.getBoundingClientRect(),
    );
    const middle = window.innerHeight / 2;
    const row = posters.filter((box) => box.top < middle && box.bottom > middle);
    return {
      left: Math.min(...row.map((box) => box.left)),
      right: Math.max(...row.map((box) => box.right)),
    };
  });
  expect(reach.left).toBeLessThanOrEqual(0);
  expect(reach.right).toBeGreaterThanOrEqual(2560);
});
