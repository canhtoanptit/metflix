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
 *   violation in the console, naming the blocked URL and directive, and on React reporting a state
 *   update during another component's render (development builds report it, so the dev mode).
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
/** Telemetry's batches (`POST /events`): they record behaviour, they change nothing of the account. */
const TELEMETRY_PATH = "/api/v1/events";

interface ReadOnlyGuard {
  /** Mutating API calls: the spec changed the shared account. */
  violations: string[];
  /** Event batches sent, or a device id kept, while the account's consent grants no purpose. */
  unconsented: string[];
  granted: boolean;
}

/** Where the telemetry SDK keeps its device id: it exists only while collection is allowed. */
const DEVICE_ID_KEY = "webflix.deviceId";

/**
 * Before the context closes: a page still holding a telemetry device id for an account that
 * consented to nothing means collection started without consent (the batch it would send as the
 * page closes cannot be observed, the id it stored can).
 */
async function checkDeviceIds(context: BrowserContext, guard: ReadOnlyGuard | null): Promise<void> {
  if (!guard || guard.granted) return;
  for (const page of context.pages()) {
    try {
      const stored = await page.evaluate((key) => localStorage.getItem(key), DEVICE_ID_KEY);
      if (stored) guard.unconsented.push(`${page.url()}: localStorage ${DEVICE_ID_KEY}`);
    } catch {
      // closed, or on a page without storage (about:blank)
    }
  }
}

/**
 * Whether the account a context is signed in to has consented to any purpose, as the server says
 * (`GET /privacy/consent`); true where the deployment does not serve it.
 */
async function consentGranted(context: BrowserContext): Promise<boolean> {
  try {
    const response = await context.request.get("/api/v1/privacy/consent");
    if (!response.ok()) return true;
    const consent = (await response.json()) as {
      mode: string;
      purposes: Record<string, { granted: boolean }>;
    };
    return (
      consent.mode !== "off" && Object.values(consent.purposes).some((purpose) => purpose.granted)
    );
  } catch {
    return true;
  }
}

/**
 * Record every mutating API call a shared demo session's browser makes. Telemetry's event batches
 * are not mutations of the account and pass, but only where the account's consent grants a
 * purpose: under the default opt-in mode the demo account has said nothing, so its browser must
 * send nothing at all, and every spec on it doubles as a check that consent is honoured.
 */
async function guardReadOnly(context: BrowserContext): Promise<ReadOnlyGuard> {
  const granted = await consentGranted(context);
  const guard: ReadOnlyGuard = { violations: [], unconsented: [], granted };
  context.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!MUTATING.has(request.method()) || !path.startsWith("/api/")) return;
    if (request.method() === "POST" && path === TELEMETRY_PATH) {
      if (!granted) guard.unconsented.push(`POST ${path}`);
      return;
    }
    guard.violations.push(`${request.method()} ${path}`);
  });
  return guard;
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

/**
 * React's "Cannot update a component (`A`) while rendering a different component (`B`)": B's
 * render changed A's state, a bug in B whatever A shows. Seen once (WatchPage from PlayerFrame) in
 * a run and never reproduced; watched for, so a recurrence names its spec.
 */
function watchRenderPhaseUpdates(context: BrowserContext): string[] {
  const reports: string[] = [];
  context.on("console", (message) => {
    const text = message.text();
    if (/Cannot update a component .* while rendering a different component/.test(text))
      reports.push(`${message.page()?.url()}: ${text.split("\n")[0]}`);
  });
  return reports;
}

function expectNoRenderPhaseUpdates(reports: string[]): void {
  expect(reports, "React state updates during another component's render").toEqual([]);
}

function expectNoViolations(guard: ReadOnlyGuard): void {
  expect(
    guard.violations,
    "this spec changed data on the shared demo session; use a fresh account (createAccount) for specs that change data",
  ).toEqual([]);
  expect(
    guard.unconsented,
    "the browser sent behaviour events for the demo account, whose consent grants no purpose (docs/BLUEPRINT-M2.md §6.3)",
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
    const violations = demo ? await guardReadOnly(context) : null;
    const csp = watchCsp(context);
    const renderUpdates = watchRenderPhaseUpdates(context);
    await use(context);
    await checkDeviceIds(context, violations);
    if (violations) expectNoViolations(violations);
    expectNoCspViolations(csp);
    expectNoRenderPhaseUpdates(renderUpdates);
  },

  page: async ({ page }, use) => {
    await throttle(page);
    await use(page);
  },

  newDevice: async ({ browser, baseURL }, use) => {
    const opened: Array<{
      context: BrowserContext;
      violations: ReadOnlyGuard | null;
      csp: string[];
      renderUpdates: string[];
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
        violations: demo ? await guardReadOnly(context) : null,
        csp: watchCsp(context),
        renderUpdates: watchRenderPhaseUpdates(context),
      });
      return context;
    });
    for (const { context, violations, csp, renderUpdates } of opened) {
      await checkDeviceIds(context, violations);
      await context.close();
      if (violations) expectNoViolations(violations);
      expectNoCspViolations(csp);
      expectNoRenderPhaseUpdates(renderUpdates);
    }
  },
});
