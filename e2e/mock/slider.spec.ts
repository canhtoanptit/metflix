import { expect, type Locator, type Page, test } from "@playwright/test";
import { gotoAs } from "./support.ts";

/** Row slider behaviour in a real browser (layout, transitions, pointer and keyboard input). */

const row = (page: Page, id = "ref-standard") => page.locator(`section#${id}`);
const visible = (slider: Locator) => slider.locator("li.wf-slider__item:not([inert])");
const firstVisibleName = (slider: Locator) => visible(slider).first().locator("a").textContent();

test.beforeEach(async ({ page }) => {
  await gotoAs(page, "/dev/reference#browse", "profile");
  await row(page).scrollIntoViewIfNeeded();
});

test("shows 6 cards and a peek at 1440px; arrows and page indicators appear on hover", async ({
  page,
}) => {
  const slider = row(page);
  await expect(visible(slider)).toHaveCount(6);
  const next = slider.getByRole("button", { name: "More titles" });
  await expect(next).toHaveCSS("opacity", "0");
  await slider.hover();
  await expect(next).toHaveCSS("opacity", "1");
  await expect(slider.locator(".wf-slider__pages")).toHaveCSS("opacity", "1");
  // The peeking 7th card is rendered (and inert) inside the right gutter.
  const peek = slider.locator("li.wf-slider__item[inert]").first();
  const box = await peek.boundingBox();
  expect(box?.x ?? 0).toBeGreaterThan(1300);
});

test("pages with an eased transform, then wraps around after the last page", async ({ page }) => {
  const slider = row(page);
  const before = await firstVisibleName(slider);
  await slider.hover();
  await slider.getByRole("button", { name: "More titles" }).click();
  // Mid-flight the track is animating its transform (not jumping).
  await expect(slider).toHaveAttribute("data-state", "moving");
  const track = slider.locator(".wf-slider__track");
  await expect(track).toHaveCSS("transition-property", "transform");
  await expect(slider).toHaveAttribute("data-state", "idle", { timeout: 2000 });
  expect(await firstVisibleName(slider)).not.toBe(before);
  await expect(slider.getByRole("button", { name: "Previous titles" })).toBeAttached();

  // 56 titles / 6 per page = 10 pages: nine more moves return to the first card.
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (let move = 0; move < 9; move += 1) {
    await slider.getByRole("button", { name: "More titles" }).click();
  }
  expect(await firstVisibleName(slider)).toBe(before);
  await slider.getByRole("button", { name: "Previous titles" }).click();
  expect(await firstVisibleName(slider)).not.toBe(before);
});

test("keyboard: one Tab stop, arrows move focus and page at the edge", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const slider = row(page);
  const first = visible(slider).first().locator("a");
  await first.focus();
  await expect(first).toBeFocused();
  const links = slider.locator("a[tabindex='0']");
  await expect(links).toHaveCount(1);
  for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowRight");
  // Focus moved past the sixth card: the row paged and focus sits on the new first card.
  await expect(visible(slider).first().locator("a")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(visible(slider).last().locator("a")).toBeFocused();
  await expect(page.getByTestId("page-log")).toContainText("page 1 of 10");
});

test("cards per page follow the slider width (container queries) and stay aligned", async ({
  page,
}) => {
  const slider = row(page);
  for (const [width, perPage] of [
    [1440, 6],
    [1200, 5],
    [1000, 4],
    [700, 3],
    [420, 2],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(visible(slider)).toHaveCount(perPage);
    const firstBox = await visible(slider).first().boundingBox();
    const gutter = Math.max(16, width * 0.04);
    expect(Math.abs((firstBox?.x ?? 0) - gutter)).toBeLessThan(2);
  }
});

test("touch swipe pages with momentum; a short drag snaps back", async ({ page }) => {
  const slider = row(page);
  const before = await firstVisibleName(slider);
  const viewport = slider.locator(".wf-slider__viewport");
  const box = await viewport.boundingBox();
  if (!box) throw new Error("no viewport");
  const y = box.y + box.height / 2;
  // Real pointer events with real time between them, so velocity is what a finger would produce.
  const swipe = (from: number, to: number, steps: number, stepMs: number) =>
    viewport.evaluate(
      async (element, args) => {
        const fire = (type: string, x: number) =>
          element.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 7,
              pointerType: "touch",
              isPrimary: true,
              clientX: x,
              clientY: args.y,
              bubbles: true,
            }),
          );
        fire("pointerdown", args.from);
        for (let i = 1; i <= args.steps; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, args.stepMs));
          fire("pointermove", args.from + ((args.to - args.from) * i) / args.steps);
        }
        fire("pointerup", args.to);
      },
      { from, to, steps, stepMs, y },
    );

  // A slow, short drag is not a page turn: the track springs back.
  await swipe(box.x + box.width * 0.5 + 40, box.x + box.width * 0.5, 8, 40);
  await expect(slider).toHaveAttribute("data-state", "idle", { timeout: 2000 });
  expect(await firstVisibleName(slider)).toBe(before);

  // A quick flick pages, continuing at the finger's speed.
  await swipe(box.x + box.width * 0.8, box.x + box.width * 0.3, 6, 16);
  await expect(slider).toHaveAttribute("data-state", "idle", { timeout: 2000 });
  expect(await firstVisibleName(slider)).not.toBe(before);
});

test("hover intent reports geometry and edge for a preview outside the clip", async ({ page }) => {
  const slider = page.getByRole("region", { name: "Hover preview (extension point demo)" });
  await slider.scrollIntoViewIfNeeded();
  await visible(slider).first().hover();
  await expect(page.getByTestId("hover-log")).toContainText("edge start", { timeout: 2000 });
  await expect(page.getByTestId("hover-log")).toContainText("position 1/6");
  await visible(slider).nth(5).hover();
  await expect(page.getByTestId("hover-log")).toContainText("edge end", { timeout: 2000 });
});
