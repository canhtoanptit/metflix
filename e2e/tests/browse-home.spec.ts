import { row, visibleCards } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

test.use({ viewport: { width: 1440, height: 900 }, demo: "Alex" });

test("home: billboard with its actions, then the first batch of rows", async ({ page }) => {
  await page.goto("/browse");
  const billboard = page.getByRole("region", { name: /^Featured: / });
  await expect(billboard).toBeVisible();
  await expect(billboard.getByRole("link", { name: /^(Play|Resume)$/ })).toBeVisible();
  await expect(billboard.getByRole("button", { name: "More info" })).toBeVisible();
  await expect(billboard.getByText(/^Maturity rating/)).toBeAttached();
  await expect(row(page, /^Continue Watching for Alex$/)).toBeVisible();
  // Continue Watching cards carry the time left and the episode to resume in their names.
  await expect(
    row(page, /^Continue Watching/)
      .getByRole("link")
      .first(),
  ).toHaveAccessibleName(/(\d+ (hours?|minutes?|seconds?) )+left|Finished/);
});

test("home: more batches of rows load as you scroll towards the end", async ({ page }) => {
  const batches: number[] = [];
  page.on("response", (response) => {
    if (/\/api\/v1\/browse\?.*cursor=/.test(response.url())) batches.push(response.status());
  });
  await page.goto("/browse");
  const carousels = page.locator('section[aria-roledescription="carousel"]');
  await expect(carousels.first()).toBeVisible();
  for (let step = 0; step < 14; step += 1) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(150);
  }
  await expect.poll(() => batches.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(batches.every((status) => status === 200)).toBe(true);
  // The first batch has six rows; later batches (and lazily mounted rows) add the rest.
  await expect.poll(() => carousels.count(), { timeout: 10_000 }).toBeGreaterThan(6);
});

test("the navigation is transparent over the billboard and solid once scrolled", async ({
  page,
}) => {
  await page.goto("/browse");
  const header = page.locator("header").first();
  await expect(header).not.toHaveAttribute("data-scrolled");
  await page.mouse.wheel(0, 400);
  await expect(header).toHaveAttribute("data-scrolled");
  await page.mouse.wheel(0, -2000);
  await expect(header).not.toHaveAttribute("data-scrolled");
});

test("a row pages its own items: paging towards the end fetches the next page", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/browse");
  const trending = row(page, "Trending Now");
  await trending.scrollIntoViewIfNeeded();
  await trending.hover();
  const more = page.waitForResponse((r) => r.url().includes("/api/v1/browse/rows/"));
  const next = trending.getByRole("button", { name: "More titles" });
  for (let step = 0; step < 3; step += 1) await next.click();
  expect((await more).ok()).toBe(true);
  // The row keeps going past its first 20 titles instead of wrapping.
  await expect
    .poll(async () => Number(await visibleCards(trending).first().getAttribute("aria-posinset")))
    .toBeGreaterThan(12);
  await expect(visibleCards(trending).first()).toHaveAttribute(
    "aria-setsize",
    /^(2[1-9]|[3-9]\d)$/,
  );
});

test("paging glides the whole way to the next page instead of jumping", async ({ page }) => {
  await page.goto("/browse");
  const trending = row(page, "Trending Now");
  await trending.scrollIntoViewIfNeeded();
  const next = trending.getByRole("button", { name: "More titles" });
  await next.hover();
  // Sample the track every frame from the click until the move settles.
  const sampled = page.evaluate(
    (id) =>
      new Promise<{ planned: number; moving: number; samples: Array<[number, number]> }>(
        (resolve) => {
          const section = document.getElementById(id);
          const track = section?.querySelector<HTMLElement>(".wf-slider__track");
          if (!section || !track) throw new Error("no Trending Now track");
          // The token in either unit: production CSS ships 700ms as .7s.
          const raw = getComputedStyle(document.documentElement)
            .getPropertyValue("--duration-slower")
            .trim();
          const planned = raw.endsWith("ms")
            ? Number.parseFloat(raw)
            : Number.parseFloat(raw) * 1000;
          const samples: Array<[number, number]> = [];
          let started = 0;
          const tick = () => {
            const now = performance.now();
            const moving = section.dataset.state === "moving";
            if (moving && !started) started = now;
            if (started)
              samples.push([now - started, new DOMMatrix(getComputedStyle(track).transform).m41]);
            if (started && !moving) resolve({ planned, moving: now - started, samples });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
      ),
    (await trending.getAttribute("id")) ?? "",
  );
  await next.click();
  const { planned, moving, samples } = await sampled;
  expect(planned).toBeGreaterThan(0);
  // The move lasts its token (a fallback that settles early cuts the glide short).
  expect(moving).toBeGreaterThanOrEqual(planned * 0.8);
  // Halfway through, the track is on its way: neither still nor already there.
  const from = samples[0]?.[1] ?? 0;
  const to = samples.at(-1)?.[1] ?? 0;
  const halfway = samples.find(([at]) => at >= planned / 2)?.[1] ?? to;
  const progress = (halfway - from) / (to - from);
  expect(progress).toBeGreaterThan(0.05);
  expect(progress).toBeLessThan(0.98);
});

test("paging never reveals a placeholder: the next page's pictures load before the glide", async ({
  page,
}) => {
  await page.goto("/browse");
  const trending = row(page, "Trending Now");
  await trending.scrollIntoViewIfNeeded();
  // Seen, then idle: every card the row has rendered either side of its page loads its picture.
  await expect
    .poll(() =>
      trending.evaluate((section) =>
        [...section.querySelectorAll<HTMLImageElement>("li.wf-slider__item img")].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true);
  const next = trending.getByRole("button", { name: "More titles" });
  await next.hover();
  // Every frame of the glide: no card inside the row's viewport shows a placeholder.
  const glide = trending.evaluate(
    (section) =>
      new Promise<string[]>((resolve) => {
        const viewport = section.querySelector<HTMLElement>(".wf-slider__viewport");
        if (!viewport) throw new Error("no viewport");
        const seen: string[] = [];
        let started = false;
        const tick = () => {
          const moving = section.dataset.state === "moving";
          if (moving) started = true;
          const box = viewport.getBoundingClientRect();
          for (const image of section.querySelectorAll<HTMLElement>(".wf-image")) {
            const r = image.getBoundingClientRect();
            const inside = r.right > box.left + 1 && r.left < box.right - 1;
            if (inside && !image.hasAttribute("data-loaded")) {
              seen.push(image.closest("a")?.textContent?.trim() ?? "?");
            }
          }
          if (started && !moving) resolve([...new Set(seen)]);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  await next.click();
  expect(await glide, "cards that showed a placeholder during the glide").toEqual([]);
});

test.describe("Kids", () => {
  test.use({ demo: "Kids" });

  test("the Kids home greets its viewer and marks the Kids experience", async ({ page }) => {
    await page.goto("/browse");
    await expect(page.getByTestId("kids-greeting")).toContainText(/^Hi, .+!/);
    await expect(page.getByRole("link", { name: "Webflix Kids home" })).toBeVisible();
    await expect(page.locator("header [data-kids-rule]")).toBeVisible();
    // Rounder cards: the card radius maps to a larger token.
    const radius = await page
      .locator("li.wf-slider__item a")
      .first()
      .evaluate((link) => Number.parseFloat(getComputedStyle(link).borderTopLeftRadius));
    expect(radius).toBeGreaterThan(8);
  });
});

test("Series, Movies and New & Popular are views of their own", async ({ page }) => {
  await page.goto("/browse");
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("link", { name: "Series" }).click();
  await expect(page).toHaveURL(/\/browse\/series$/);
  await expect(page.getByRole("heading", { name: "Series", level: 1 })).toBeAttached();
  await expect(row(page, /Top 10 Series Today/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Genres" })).toBeVisible();

  await nav.getByRole("link", { name: "Movies" }).click();
  await expect(row(page, /Top 10 Movies Today/)).toBeVisible();

  await nav.getByRole("link", { name: "New & Popular" }).click();
  await expect(page.getByRole("heading", { name: "New & Popular", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Featured/ })).toHaveCount(0);
  await expect(row(page, "New on Webflix")).toBeVisible();
});

test("genre page: type filter and sort live in the URL; the grid loads", async ({ page }) => {
  await page.goto("/browse/genre/drama");
  await expect(page.getByRole("heading", { name: "Drama", level: 1 })).toBeVisible();
  const grid = page.getByRole("list", { name: /^Drama/ });
  await expect(grid.getByRole("link").first()).toBeVisible();
  await page.getByRole("radio", { name: "Movies" }).click();
  await expect(page).toHaveURL(/type=movie/);
  await expect(page.getByRole("list", { name: "Drama movies" })).toBeVisible();
  await page.getByRole("combobox", { name: "Sort by" }).click();
  await page.getByRole("option", { name: "A–Z" }).click();
  await expect(page).toHaveURL(/sort=a-z/);
  const grid2 = page.getByRole("list", { name: "Drama movies" });
  await expect(grid2).not.toHaveAttribute("aria-busy", "true");
  const names = await grid2
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.querySelector(".sr-only")?.textContent ?? ""));
  expect(names.length).toBeGreaterThan(1);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
});
