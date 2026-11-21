import { expect, test } from "./fixtures.ts";

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
