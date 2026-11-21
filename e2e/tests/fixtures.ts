/**
 * The suite's `test`: Playwright's, plus the isolation model (e2e/README.md).
 *
 * - `test.use({ demo: "Alex" })`: the page starts signed in to the shared, seeded demo account
 *   with that profile active. The session was created once for the whole run by the `setup`
 *   project (demo.setup.ts), so no spec signs in for it and the sign-in budget is spent once.
 *   Every spec on it shares that one session, so it is strictly read-only: any mutating API
 *   call from its browser (My List, ratings, profile switch, sign-out, playback...) fails the
 *   spec, naming the call. Specs that change data use a fresh account (`createAccount` in
 *   api.ts) instead. The check observes requests rather than intercepting them: interception
 *   would route every image through Playwright and switch off the HTTP cache for every spec.
 * - `E2E_CPU_THROTTLE=4`: Chromium pages run with the CPU slowed that many times (CDP
 *   `Emulation.setCPUThrottlingRate`), the gate's proof that timing-sensitive specs hold.
 * - Every context (the page's and `newDevice()`s) fails its spec on a Content-Security-Policy
 *   violation in the console, naming the blocked URL and directive.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BrowserContext,
  type BrowserContextOptions,
  test as base,
  expect,
  type Page,
} from "@playwright/test";

export { expect };

export const DEMO_PROFILES = ["Alex", "Mia", "Kids"] as const;
export type DemoProfile = (typeof DEMO_PROFILES)[number];

const AUTH_DIR = join(import.meta.dirname, "..", ".auth");

/** Where the run's demo session for `profile` is stored; one folder per target origin. */
export function demoStatePath(baseURL: string | undefined, profile: DemoProfile): string {
  const origin = (baseURL ?? "default").replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_");
  const path = join(AUTH_DIR, origin, `demo-${profile.toLowerCase()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

const throttleRate = Number(process.env.E2E_CPU_THROTTLE ?? 1);

async function throttle(page: Page): Promise<void> {
  if (!(throttleRate > 1)) return;
  if (page.context().browser()?.browserType().name() !== "chromium") return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttleRate });
}

/** Throttle every page a context opens (when E2E_CPU_THROTTLE is set). */
function throttleContext(context: BrowserContext): void {
  if (!(throttleRate > 1)) return;
  context.on("page", (page) => void throttle(page).catch(() => {}));
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Record every mutating API call a shared demo session's browser makes. */
function guardReadOnly(context: BrowserContext): string[] {
  const violations: string[] = [];
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (MUTATING.has(request.method()) && path.startsWith("/api/")) {
      violations.push(`${request.method()} ${path}`);
    }
  });
  return violations;
}

/**
 * Record Content-Security-Policy violations the browser reports in the console (Chromium:
 * "Refused to load ... violates the following Content Security Policy directive", Firefox and
 * WebKit word it differently). A blocked resource is a broken page wherever a CSP is served.
 */
function watchCsp(context: BrowserContext): string[] {
  const reports: string[] = [];
  context.on("console", (message) => {
    const text = message.text();
    if (/content[- ]security[- ]policy/i.test(text))
      reports.push(`${message.page()?.url()}: ${text}`);
  });
  return reports;
}

function expectNoCspViolations(reports: string[]): void {
  expect(reports, "Content-Security-Policy violations (blocked URL and directive)").toEqual([]);
}

function expectNoViolations(violations: string[]): void {
  expect(
    violations,
    "this spec changed data on the shared demo session; use a fresh account (createAccount) for specs that change data",
  ).toEqual([]);
}

interface Options {
  /** Start signed in to the shared demo account with this profile (read-only), or signed out. */
  demo: DemoProfile | null;
}

interface Fixtures {
  /**
   * Another browser context ("device"): signed out, or as a demo profile (read-only, guarded).
   * Throttled like the page when E2E_CPU_THROTTLE is set. Closed after the test.
   */
  newDevice: (options?: BrowserContextOptions & { demo?: DemoProfile }) => Promise<BrowserContext>;
}

export const test = base.extend<Options & Fixtures>({
  demo: [null, { option: true }],

  storageState: async ({ demo, storageState, baseURL }, use) => {
    await use(demo ? demoStatePath(baseURL, demo) : storageState);
  },

  context: async ({ context, demo }, use) => {
    throttleContext(context);
    const violations = demo ? guardReadOnly(context) : null;
    const csp = watchCsp(context);
    await use(context);
    if (violations) expectNoViolations(violations);
    expectNoCspViolations(csp);
  },

  page: async ({ page }, use) => {
    await throttle(page);
    await use(page);
  },

  newDevice: async ({ browser, baseURL }, use) => {
    const opened: Array<{
      context: BrowserContext;
      violations: string[] | null;
      csp: string[];
    }> = [];
    await use(async (options = {}) => {
      const { demo, ...contextOptions } = options;
      const context = await browser.newContext({
        ...contextOptions,
        ...(demo ? { storageState: demoStatePath(baseURL, demo) } : {}),
      });
      throttleContext(context);
      opened.push({
        context,
        violations: demo ? guardReadOnly(context) : null,
        csp: watchCsp(context),
      });
      return context;
    });
    for (const { context, violations, csp } of opened) {
      await context.close();
      if (violations) expectNoViolations(violations);
      expectNoCspViolations(csp);
    }
  },
});
