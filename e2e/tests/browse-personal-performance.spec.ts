import { createAccount } from "./api.ts";
import { grantConsent } from "./browse-personal-support.ts";
import { pointAt, previewOf, row, showRow, visibleCards } from "./browse-support.ts";
import { expect, test } from "./fixtures.ts";

/**
 * What the browse surface costs to use, measured on a long home page: layout shift from the
 * first paint to the last batch of rows, main-thread blocking while scrolling through it, the
 * latency of the interactions people repeat (paging a row, the hover preview, opening a title),
 * and the frames of a row's glide. Run it at `E2E_CPU_THROTTLE=4` (the gate's throttled run) to
 * compare a change against the polish round's surface; the numbers are attached to the result
 * (`browse-performance`) and printed.
 *
 * The budgets asserted are the product's own: no layout shift, interactions under 110 ms (scaled
 * by the throttle, which slows every task that many times), and a glide that never stalls for
 * more than a few frames.
 */

/**
 * Whose home page: `demo` (the shared demo profile Alex, read-only, nothing collected: no consent
 * on the demo account), `consent` (a fresh account that granted consent: every impression is
 * observed and sent) or `fresh` (a fresh account that did not: the same page, nothing sent).
 * `E2E_PERF_ACCOUNT`, default `consent`, so the measured page runs its instrumentation in full.
 */
const who = (process.env.E2E_PERF_ACCOUNT ?? "consent") as "demo" | "consent" | "fresh";

test.use({ viewport: { width: 1440, height: 900 }, demo: who === "demo" ? "Alex" : null });

const throttle = Math.max(1, Number(process.env.E2E_CPU_THROTTLE ?? 1) || 1);

interface Recorded {
  shifts: Array<{ value: number; at: number; sources: string[] }>;
  longTasks: number[];
  events: Array<{ name: string; duration: number; interactionId: number; at: number }>;
}

declare global {
  interface Window {
    __perf?: Recorded;
  }
}

test("a long home page: no layout shift, short tasks, quick interactions, a smooth glide", async ({
  page,
}) => {
  test.setTimeout(120_000 * throttle);
  const request = page.context().request;
  if (who !== "demo") {
    await createAccount(request, { tag: "performance", profileName: "Rae" });
    if (who === "consent") await grantConsent(request);
  }
  if (who !== "consent") {
    // "Not now" to the consent prompt (opt-in mode asks): it belongs to the privacy screens, and
    // the committed home page this is compared with has none.
    const session = (await (await request.get("/api/v1/session")).json()) as {
      account: { id: string };
    };
    await page.addInitScript((owner: string) => {
      sessionStorage.setItem(`webflix.privacy.later.${owner}`, "1");
    }, session.account.id);
  }
  await page.addInitScript(() => {
    const recorded: Recorded = { shifts: [], longTasks: [], events: [] };
    window.__perf = recorded;
    const describe = (node: Node | null | undefined): string => {
      if (node && !(node instanceof Element)) {
        // A text node: say whose text it is.
        const text = (node.textContent ?? "").trim().slice(0, 24);
        return `"${text}" in ${node.parentElement ? describe(node.parentElement) : "?"}`;
      }
      if (!node) return "?";
      const id = node.id ? `#${node.id}` : "";
      const cls =
        typeof node.className === "string"
          ? `.${node.className.split(" ").slice(0, 2).join(".")}`
          : "";
      return `${node.tagName.toLowerCase()}${id}${cls}`;
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: Array<{ node?: Node | null }>;
        }
      >) {
        if (entry.hadRecentInput) continue;
        recorded.shifts.push({
          value: entry.value,
          at: entry.startTime,
          sources: (entry.sources ?? []).map((source) => describe(source.node)),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) recorded.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & { interactionId?: number }
      >) {
        recorded.events.push({
          name: entry.name,
          duration: entry.duration,
          interactionId: entry.interactionId ?? 0,
          at: entry.startTime,
        });
      }
    }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
  });

  // --- Load, then scroll through every batch of rows ------------------------------------------
  let batches = 0;
  page.on("response", (response) => {
    if (/\/api\/v1\/browse\?.*cursor=/.test(response.url())) batches += 1;
  });
  await page.goto("/browse");
  const carousels = page.locator('section[aria-roledescription="carousel"]');
  await expect(carousels.first()).toBeVisible();
  await expect(page.getByRole("region", { name: /^Featured: / })).toBeVisible();
  const loadedAt = await page.evaluate(() => performance.now());

  const scrollStart = await page.evaluate(() => window.__perf?.longTasks.length ?? 0);
  let stable = 0;
  let lastCount = 0;
  for (let step = 0; step < 80 && stable < 6; step += 1) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(120);
    const count = await carousels.count();
    const atEnd = await page.evaluate(
      () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
    );
    stable = atEnd && count === lastCount ? stable + 1 : 0;
    lastCount = count;
  }
  const rowCount = await carousels.count();
  const scrollTasks = await page.evaluate(
    (from) => (window.__perf?.longTasks ?? []).slice(from),
    scrollStart,
  );

  // --- Back to a row near the top: page it, hover a card, open the details --------------------
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  const trending = row(page, "Trending Now");
  await showRow(page, trending);
  const interactionsFrom = await page.evaluate(() => performance.now());

  // Paging with the arrow, and the frames of its glide.
  const next = trending.getByRole("button", { name: "More titles" });
  await next.hover();
  const glide = page.evaluate(
    (id) =>
      new Promise<{ durationMs: number; frames: number; longestFrameMs: number }>((resolve) => {
        const section = document.getElementById(id);
        if (!section) throw new Error("no Trending Now row");
        let started = 0;
        let last = 0;
        let frames = 0;
        let longest = 0;
        const tick = (now: number) => {
          const moving = section.dataset.state === "moving";
          if (moving && !started) {
            started = now;
            last = now;
          } else if (started) {
            frames += 1;
            longest = Math.max(longest, now - last);
            last = now;
          }
          if (started && !moving)
            resolve({ durationMs: now - started, frames, longestFrameMs: longest });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    (await trending.getAttribute("id")) ?? "",
  );
  await next.click();
  const glideResult = await glide;

  // Hover intent: from the pointer arriving on a card to the preview on screen.
  await page.mouse.move(4, 120, { steps: 2 });
  await expect(previewOf(page)).toHaveCount(0);
  await page.waitForTimeout(800);
  const card = visibleCards(trending).nth(2);
  const hoverStarted = Date.now();
  await pointAt(page, card);
  await expect(previewOf(page)).toBeVisible();
  const hoverToPreviewMs = Date.now() - hoverStarted;

  // Opening the details from a card (the preview dismissed first: a click lands on the card).
  await page.keyboard.press("Escape");
  await expect(previewOf(page)).toHaveCount(0);
  await visibleCards(trending).nth(1).locator("a").click();
  await expect(page.getByTestId("title-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("title-overlay")).toHaveCount(0);

  // Keyboard paging inside a row.
  await visibleCards(trending).first().locator("a").focus();
  for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(1000);

  const recorded = await page.evaluate(() => window.__perf as Recorded);
  const cls = recorded.shifts.reduce((sum, shift) => sum + shift.value, 0);
  const interactions = new Map<number, { name: string; duration: number }>();
  for (const event of recorded.events) {
    if (!event.interactionId || event.at < interactionsFrom) continue;
    const known = interactions.get(event.interactionId);
    if (!known || event.duration > known.duration) {
      interactions.set(event.interactionId, { name: event.name, duration: event.duration });
    }
  }
  const latencies = [...interactions.values()].map((entry) => entry.duration).sort((a, b) => a - b);
  const summary = {
    who,
    throttle,
    rows: rowCount,
    batches,
    loadedAtMs: Math.round(loadedAt),
    cumulativeLayoutShift: Number(cls.toFixed(4)),
    layoutShifts: recorded.shifts.slice(0, 8),
    scrollLongTasks: scrollTasks.length,
    scrollBlockingMs: Math.round(
      scrollTasks.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0),
    ),
    scrollLongestTaskMs: Math.round(Math.max(0, ...scrollTasks)),
    interactions: latencies.length,
    interactionWorstMs: Math.round(latencies.at(-1) ?? 0),
    interactionP75Ms: Math.round(latencies[Math.floor(latencies.length * 0.75)] ?? 0),
    interactionList: [...interactions.values()].map(
      (entry) => `${entry.name}:${Math.round(entry.duration)}`,
    ),
    glide: {
      durationMs: Math.round(glideResult.durationMs),
      frames: glideResult.frames,
      longestFrameMs: Math.round(glideResult.longestFrameMs),
    },
    hoverToPreviewMs,
  };
  await test.info().attach("browse-performance", {
    body: JSON.stringify(summary, null, 2),
    contentType: "application/json",
  });
  console.log(`browse-performance ${JSON.stringify(summary)}`);

  // A fresh profile's rule-engine page has 12 rows; a staff collection or a model adds to them.
  expect(rowCount, "a long home page (every batch loaded)").toBeGreaterThanOrEqual(12);
  expect(batches, "rows loaded after the first batch").toBeGreaterThan(0);
  expect(cls, "cumulative layout shift").toBeLessThan(0.02);
  expect(summary.interactionWorstMs, "the slowest interaction").toBeLessThan(110 * throttle);
  expect(summary.glide.longestFrameMs, "the longest frame of the glide").toBeLessThan(
    100 * throttle,
  );
  expect(hoverToPreviewMs, "hover intent then the preview").toBeLessThan(1500 * throttle);
});
