import {
  firstCard,
  parkPointer,
  pointAt,
  previewOf,
  row,
  showRow,
  visibleCards,
  waitForAnimations,
} from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/** Hover previews: pointer devices only, real mouse movement and timing. */
test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, demo: "Alex" });

test.beforeEach(async ({ page }) => {
  await page.goto("/browse");
});

test("opens after a beat of hover intent, not on a pass-over", async ({ page }) => {
  const trending = row(page, "Trending Now");
  await showRow(page, trending);
  const cards = visibleCards(trending);
  // Measure first, so nothing but pointer movement happens during the sweep.
  const targets: Array<{ x: number; y: number; id: string }> = [];
  for (let index = 0; index < 5; index += 1) {
    const box = await cards.nth(index).boundingBox();
    const href = (await cards.nth(index).locator("a").getAttribute("href")) ?? "";
    if (!box) throw new Error("card without a box");
    targets.push({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      id: new URL(href, "http://x").searchParams.get("title") ?? "",
    });
  }
  // Record, in the page, every preview that opens and when the pointer reaches each card.
  await page.evaluate(() => {
    const record = { opened: [] as string[], entered: [] as number[] };
    Object.assign(window, { __sweep: record });
    document.addEventListener(
      "pointerenter",
      (event) => {
        if ((event.target as Element).matches?.("li.wf-slider__item")) {
          record.entered.push(performance.now());
        }
      },
      true,
    );
    new MutationObserver(() => {
      for (const preview of document.querySelectorAll<HTMLElement>("[data-testid=hover-preview]")) {
        const id = preview.dataset.titleId ?? "";
        if (!record.opened.includes(id)) record.opened.push(id);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  // Sweep across the row and come to rest on the last card.
  for (const target of targets) {
    await page.mouse.move(target.x, target.y, { steps: 2 });
    await page.waitForTimeout(60);
  }
  const last = targets.at(-1)?.id;
  await expect(previewOf(page)).toHaveAttribute("data-title-id", last ?? "");
  await expect(previewOf(page).getByRole("link", { name: /^Play / })).toBeVisible();
  await expect(previewOf(page).getByText(/% Match$/)).toBeVisible();
  const sweep = await page.evaluate(
    () => (window as unknown as { __sweep: { opened: string[]; entered: number[] } }).__sweep,
  );
  // The premise held (each card was only passed over), and only the resting card opened.
  const dwells = sweep.entered.slice(1).map((at, index) => at - (sweep.entered[index] ?? at));
  expect(Math.max(...dwells), "the sweep dwelt on a card past the intent delay").toBeLessThan(450);
  expect(sweep.opened).toEqual([last]);
});

interface FirstFrame {
  id: string;
  /** The picture painted is a decoded image (the card's own, or the preview-width one). */
  decoded: boolean;
  /** A placeholder (blur-up or bare colour) is what would be painted instead. */
  placeholder: boolean;
  /** The info panel's content is already there (it fades in with its surface). */
  panel: boolean;
}

/**
 * Record, for every preview that opens, what its first painted frame holds: inspected in the
 * animation frame that follows its insertion, which runs before that frame is painted.
 */
async function recordFirstFrames(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const frames: FirstFrame[] = [];
    Object.assign(window, { __firstFrames: frames });
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || node.dataset.testid !== "hover-preview") continue;
          requestAnimationFrame(() => {
            const art = node.querySelector<HTMLImageElement>("img[data-preview-art]");
            // The picture layer only (the clip's title logo waits, hidden, for the clip).
            const media = art?.parentElement ?? null;
            frames.push({
              id: node.dataset.titleId ?? "",
              decoded: !!art && art.complete && art.naturalWidth > 0,
              placeholder:
                !media ||
                media.querySelector(
                  ":scope > .wf-image:not([data-loaded]), :scope > .wf-image .wf-image__placeholder",
                ) !== null,
              panel:
                node.querySelector("a[aria-label^='Play ']") !== null &&
                /% Match/.test(node.textContent ?? ""),
            });
          });
        }
      }
    }).observe(document.body, { childList: true });
  });
}

test("a preview's first painted frame is the decoded picture and its panel, never a placeholder", async ({
  page,
}) => {
  await recordFirstFrames(page);
  // Landscape cards (the lift starts from the card's own image) and a poster row (the preview's
  // landscape picture is fetched while the intent timer runs).
  const rows = [row(page, "Trending Now"), row(page, /^Top 10 /).first()];
  let opened = 0;
  for (const slider of rows) {
    await showRow(page, slider);
    for (const index of [1, 3]) {
      await pointAt(page, visibleCards(slider).nth(index));
      await expect(previewOf(page)).toHaveCount(1);
      opened += 1;
      await parkPointer(page);
    }
  }
  const frames = await page.evaluate(
    () => (window as unknown as { __firstFrames: FirstFrame[] }).__firstFrames,
  );
  expect(frames).toHaveLength(opened);
  for (const frame of frames) {
    expect(frame, `preview of ${frame.id}: first frame`).toEqual({
      id: frame.id,
      decoded: true,
      placeholder: false,
      panel: true,
    });
  }
});

test("a resume point reads as time left, from the same numbers as its bar", async ({ page }) => {
  const watching = row(page, /^Continue Watching/);
  await showRow(page, watching);
  await pointAt(page, visibleCards(watching).first());
  const bar = previewOf(page).getByRole("progressbar", { name: "Watched" });
  await expect(bar).toBeVisible();
  const label = previewOf(page).getByText(
    /^(\d+h )?(\d+m )?(\d+s )?left$|^\d+[hm] left$|^Finished$/,
  );
  await expect(label).toBeVisible();
  await expect(previewOf(page)).not.toContainText(/\d+ of \d+m/);
  // The spoken value says the same as the label.
  await expect(bar).toHaveAttribute(
    "aria-valuetext",
    /(\d+ (hours?|minutes?|seconds?) )+left|Finished/,
  );
});

test("grows inward at the row's edges and never crosses the page gutters", async ({ page }) => {
  const trending = row(page, "Trending Now");
  await showRow(page, trending);
  const cards = visibleCards(trending);
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const gutter = Math.max(16, viewport.width * 0.04);

  await pointAt(page, cards.first());
  const first = await cards.first().locator("a").boundingBox();
  await expect(previewOf(page)).toBeVisible();
  await waitForAnimations(page); // measure it grown, not mid-scale
  const left = await previewOf(page).boundingBox();
  expect(left?.x).toBeGreaterThanOrEqual(gutter - 1);
  expect(Math.abs((left?.x ?? 0) - (first?.x ?? 0))).toBeLessThan(2);

  await parkPointer(page);
  const count = await cards.count();
  await pointAt(page, cards.nth(count - 1));
  const last = await cards
    .nth(count - 1)
    .locator("a")
    .boundingBox();
  await expect(previewOf(page)).toBeVisible();
  await waitForAnimations(page);
  const right = await previewOf(page).boundingBox();
  expect((right?.x ?? 0) + (right?.width ?? 0)).toBeLessThanOrEqual(viewport.width - gutter + 1);
  expect(
    Math.abs((right?.x ?? 0) + (right?.width ?? 0) - ((last?.x ?? 0) + (last?.width ?? 0))),
  ).toBeLessThan(2);
});

test("closes when the pointer leaves, when the page scrolls, and when the row pages", async ({
  page,
}) => {
  const trending = row(page, "Trending Now");
  await showRow(page, trending);
  const cards = visibleCards(trending);

  await pointAt(page, cards.nth(2));
  await expect(previewOf(page)).toHaveCount(1);
  await parkPointer(page);

  await pointAt(page, cards.nth(2));
  await expect(previewOf(page)).toHaveCount(1);
  await page.mouse.wheel(0, 240);
  await expect(previewOf(page)).toHaveCount(0);

  await showRow(page, trending);
  await pointAt(page, cards.nth(3));
  await expect(previewOf(page)).toHaveCount(1);
  // The arrows live in the gutter, outside every preview: reach one and page.
  await pointAt(page, trending.getByRole("button", { name: "More titles" }));
  await trending.getByRole("button", { name: "More titles" }).click();
  await expect(previewOf(page)).toHaveCount(0);
  await expect(trending).toHaveAttribute("data-state", "idle");
});

test("moving to the neighbouring card hands the preview over without a gap or a double", async ({
  page,
}) => {
  const trending = row(page, "Trending Now");
  await showRow(page, trending);
  const cards = visibleCards(trending);
  await pointAt(page, cards.nth(2));
  await expect(previewOf(page)).toHaveCount(1);
  const first = await previewOf(page).getAttribute("data-title-id");
  const box = await previewOf(page).boundingBox();
  const neighbour = await cards.nth(4).boundingBox();
  if (!box || !neighbour) throw new Error("no boxes");
  // Leave the preview on its right and settle on a card it did not cover.
  await page.mouse.move(neighbour.x + neighbour.width / 2, neighbour.y + neighbour.height / 2, {
    steps: 8,
  });
  await expect
    .poll(async () => previewOf(page).last().getAttribute("data-title-id"), { timeout: 2000 })
    .not.toBe(first);
  // At rest there is exactly one preview.
  await expect(previewOf(page)).toHaveCount(1);
});

test("More info opens the detail overlay; closing it returns focus to the card", async ({
  page,
}) => {
  const trending = row(page, "Trending Now");
  await showRow(page, trending);
  const card = visibleCards(trending).nth(1);
  const name = await card.locator(".sr-only").first().textContent();
  await pointAt(page, card);
  await expect(previewOf(page)).toBeVisible();
  // Click the preview once it has grown, fully on screen (a click that has to scroll first
  // would scroll the page, and scrolling closes the preview by design).
  await waitForAnimations(page);
  const more = previewOf(page).getByRole("button", { name: /^More info about / });
  await expect(more).toBeInViewport({ ratio: 1 });
  await more.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]title=/);
  await expect(previewOf(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator(":focus")).toHaveAccessibleName(new RegExp(`^${name}(,|$)`));
});

test("a card that stayed under the pointer while the page scrolled opens once the pointer moves", async ({
  page,
}) => {
  const trending = row(page, "Trending Now");
  await showRow(page, trending);
  const box = await visibleCards(trending).nth(2).boundingBox();
  if (!box) throw new Error("no card box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // Rest on the card while the page keeps scrolling (a pixel at a time, so the same card stays
  // under the pointer) for longer than the hover-intent delay: its intent is declined.
  await page.mouse.move(x, y);
  await page.evaluate(async () => {
    for (let step = 0; step < 16; step += 1) {
      window.scrollBy(0, step % 2 === 0 ? 1 : -1);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
  // A resting pointer never opens a preview, even once the page has settled.
  await page.waitForTimeout(1000);
  await expect(previewOf(page)).toHaveCount(0);
  // Moving on that same card is a fresh intent.
  await page.mouse.move(x + 8, y + 4, { steps: 3 });
  await expect(previewOf(page)).toHaveCount(1);
});

test("touch devices skip the preview and open the details", async ({ newDevice }) => {
  const context = await newDevice({
    viewport: { width: 834, height: 1112 },
    hasTouch: true,
    isMobile: false,
    demo: "Alex",
  });
  const page = await context.newPage();
  await page.goto("/browse");
  const trending = row(page, "Trending Now");
  await trending.scrollIntoViewIfNeeded();
  await firstCard(trending).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(previewOf(page)).toHaveCount(0);
});

test.describe("preview kinds (answers rewritten: every clip a silent motion preview)", () => {
  test("the billboard and the detail hero play a motion preview with no sound control; a card keeps its still", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "preview playback is checked in Chromium, the engine of the full suite",
    );
    const motion = (clip: Record<string, unknown> | null | undefined) =>
      clip ? { ...clip, kind: "motion", hasAudio: false } : clip;
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") {
        const entries = Object.entries(value).map(([key, inner]) => [
          key,
          key === "preview" ? motion(inner as Record<string, unknown> | null) : rewrite(inner),
        ]);
        return Object.fromEntries(entries);
      }
      return value;
    };
    await page.route(/\/api\/v1\/(browse|titles\/[^/?]+)(\?|$)/, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: rewrite(await response.json()) });
    });
    await page.goto("/browse");
    const billboard = page.getByRole("region", { name: /^Featured: / });
    const clip = billboard.locator("video");
    const playing = await clip
      .waitFor({ state: "attached", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!playing, "this target's billboard has no preview clip");
    await expect
      .poll(() => clip.evaluate((video: HTMLVideoElement) => video.currentTime))
      .toBeGreaterThan(0.3);
    await expect(billboard.getByRole("button", { name: /^Turn sound (on|off)$/ })).toHaveCount(0);

    // A card's preview keeps the still for a motion title: no clip, no sound control.
    const trending = row(page, "Trending Now");
    await showRow(page, trending);
    await pointAt(page, visibleCards(trending).nth(2));
    await expect(previewOf(page)).toBeVisible();
    await page.waitForTimeout(1_500); // past the moment a footage clip would start
    await expect(previewOf(page).locator("video")).toHaveCount(0);
    await expect(previewOf(page).getByRole("button", { name: /^Turn sound/ })).toHaveCount(0);
    await parkPointer(page);

    // The detail hero plays it too, without a sound control.
    await page.evaluate(() => window.scrollTo(0, 0));
    await billboard.getByRole("button", { name: "More info" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("video")).toBeAttached();
    await expect
      .poll(() => dialog.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime))
      .toBeGreaterThan(0);
    await expect(dialog.getByRole("button", { name: /^Turn sound (on|off)$/ })).toHaveCount(0);
  });
});
