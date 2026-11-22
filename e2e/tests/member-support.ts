/**
 * Shared helpers for the member and watch journeys against a running API (dev mode or any
 * deployed mode via BASE_URL). Every journey that changes data works on its own fresh account
 * (api.ts), so suites can run in parallel and the seeded demo account stays untouched.
 */
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { signIn, type TestAccount } from "./api.ts";

export {
  CARDS,
  CLIENT_HEADERS,
  createAccount,
  DEMO,
  PASSWORD,
  selectProfile,
  signIn,
  type TestAccount,
  uniqueEmail,
} from "./api.ts";

/**
 * Records every time the page showed the app's error screen ("Something went wrong", on screen or
 * in the document title) or logged a session hook used without its session. A session that ends
 * while a screen is open (signed out everywhere, revoked, "Sign in again") must lead straight to
 * sign-in: the screens behind a guard never render without the session the guard promised them.
 * Call before the page loads; the returned function reads what was recorded in this document.
 */
export async function recordErrorScreens(page: Page): Promise<() => Promise<string[]>> {
  const logged: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/used while signed out|used without an active profile/.test(text)) {
      logged.push(`console: ${text.split("\n")[0]}`);
    }
  });
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __webflixErrorScreens: seen });
    const note = (what: string) => {
      if (seen.length < 20) seen.push(`${what} on ${location.pathname}`);
    };
    new MutationObserver((records) => {
      if (document.title.includes("Something went wrong")) note("error title");
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.textContent?.includes("Something went wrong")) note("error screen");
        }
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  return async () => [
    ...logged,
    ...(await page.evaluate(
      () => (window as { __webflixErrorScreens?: string[] }).__webflixErrorScreens ?? [],
    )),
  ];
}

/** A second "device": a fresh browser context signed in to the same account. */
export async function secondDevice(context: BrowserContext, account: TestAccount): Promise<void> {
  await signIn(context.request, account, account.profileId);
}

/** axe in the real browser, colour contrast included. */
export async function expectAccessible(page: Page, exclude: string[] = []): Promise<void> {
  // Contrast is computed from what is painted: let entrance fades and scales finish first.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
  let builder = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
    "wcag22aa",
  ]);
  for (const selector of ['[data-testid="dev-toolbar"]', ...exclude]) {
    builder = builder.exclude(selector);
  }
  const results = await builder.analyze();
  expect(
    results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.nodes
          .map((node) => node.target.join(" "))
          .slice(0, 4)
          .join(" | ")}`,
    ),
  ).toEqual([]);
}

/** The video element is playing past `seconds`. */
export async function waitForPlayback(page: Page, seconds = 1): Promise<void> {
  try {
    await page.waitForFunction(
      (min) => {
        const video = document.querySelector("video");
        return video !== null && video.currentTime > min && !video.paused;
      },
      seconds,
      { timeout: 45_000 },
    );
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nvideo element: ${JSON.stringify(await videoState(page))}`,
    );
  }
}

/** Everything a stalled playback needs explaining: clock, readiness, buffer, errors. */
export async function videoState(page: Page) {
  return page
    .evaluate(() => {
      const video = document.querySelector("video");
      if (!video) return null;
      const buffered: Array<[number, number]> = [];
      for (let index = 0; index < video.buffered.length; index += 1) {
        buffered.push([video.buffered.start(index), video.buffered.end(index)]);
      }
      return {
        currentTime: video.currentTime,
        paused: video.paused,
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error ? `${video.error.code} ${video.error.message}` : null,
        buffered,
        videoWidth: video.videoWidth,
        source: video.currentSrc.startsWith("blob:") ? "mse" : video.currentSrc.slice(0, 60),
        status: document.querySelector("[data-testid^=watch-status]")?.getAttribute("data-testid"),
      };
    })
    .catch((error: Error) => ({ unavailable: error.message }));
}

/** Fill the card form of the payment step / plan change. */
export async function fillCard(page: Page, number: string): Promise<void> {
  await page.getByLabel("Card number").fill(number);
  await page.getByLabel("Expiry (MM / YY)").fill("");
  await page
    .getByLabel("Expiry (MM / YY)")
    .pressSequentially(`12${String((new Date().getFullYear() + 3) % 100)}`);
  await page.getByLabel("Security code").fill("123");
  await page.getByLabel("Name on card").fill("E2E Tester");
}
