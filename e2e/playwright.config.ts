import { execFileSync } from "node:child_process";
import { defineConfig, devices, type Project } from "@playwright/test";
import { video, workers } from "./host-limits.ts";

/**
 * One suite for every mode: point BASE_URL at the running app (e2e/README.md).
 *   dev:        http://localhost:5173 (default)
 *   k8s:        http://localhost:8080
 *   cloudflare: http://localhost:8787
 *
 * Projects: `setup` signs in to the demo account once per profile for the run; `chromium`
 * runs every spec; `firefox` and `webkit` run the cross-browser subset (cross-browser.spec.ts).
 * E2E_BROWSERS=chromium (comma-separated) limits the browsers.
 *
 * Flake policy: no retries locally, and a test that only passes on a retry fails the run
 * everywhere (CI retries once, to capture a trace of the first failure).
 *
 * Host limits (host-limits.ts): 4 workers unless E2E_WORKERS says otherwise, and no video unless
 * E2E_VIDEO=1. Run it through scripts/host-guard.sh (the make targets do).
 */
const baseURL = process.env.BASE_URL ?? "http://localhost:5173";
const ci = Boolean(process.env.CI);
const browsers = new Set(
  (process.env.E2E_BROWSERS ?? "chromium,firefox,webkit").split(",").map((name) => name.trim()),
);
// Specs every engine runs: the *-cross-browser subsets, and the docs page's CSP (engines enforce
// policies differently).
const CROSS_BROWSER = /(cross-browser|ops-docs)\.spec\.ts$/;
// E2E_CPU_THROTTLE=4 slows every Chromium page 4x (fixtures.ts): rendering a screen then takes
// 4x as long, so budgets for screens to appear scale with it. What the throttled run proves (hover
// intent, sweep dwell, glide and preview timings) is measured by product timers, not by budgets.
const slowdown = Math.max(1, Number(process.env.E2E_CPU_THROTTLE ?? 1) || 1);

const projects: Project[] = [{ name: "setup", testMatch: /\.setup\.ts$/ }];
if (browsers.has("chromium")) {
  projects.push({
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
    dependencies: ["setup"],
  });
}
// Host condition (README "What each browser engine covers"): WebKit does not run while the Mac's
// screen is locked. There it loses pointer input, and it is the suspect for the kernel memory that
// grew overnight on 2026-11-22. A run that asks for WebKit on a locked screen does not start, so
// nobody mistakes "not run" for "passed". Read once, by the runner; its workers inherit the answer,
// so a screen that locks mid-run cannot make them disagree about the projects.
function screenLocked(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const session = execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" });
    return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(session);
  } catch {
    return false;
  }
}
process.env.E2E_SCREEN_LOCKED ??= screenLocked() ? "1" : "0";
if (browsers.has("webkit") && process.env.E2E_SCREEN_LOCKED === "1") {
  throw new Error(
    "The screen is locked, and WebKit does not run on a locked screen (e2e/README.md). Run E2E_BROWSERS=chromium,firefox and report WebKit as not run, or run it all once the owner's session is unlocked.",
  );
}
for (const [name, device] of [
  ["firefox", devices["Desktop Firefox"]],
  ["webkit", devices["Desktop Safari"]],
] as const) {
  if (!browsers.has(name)) continue;
  projects.push({
    name,
    use: {
      ...device,
      // WebKit's trace keeps its DOM snapshots but takes no screenshots: trace screenshots are a
      // continuous capture of the page for the whole test, kept or not. The night the host ran out
      // of memory, kernel memory grew from 9 GB to 268 GB, which macOS put down to a likely
      // IOSurface leak, while the screen was locked; WebKit capturing its window is the suspect
      // (unproven). A failing WebKit test still gets its one screenshot (`screenshot` below).
      ...(name === "webkit"
        ? { trace: { mode: "retain-on-failure" as const, screenshots: false } }
        : {}),
    },
    testMatch: CROSS_BROWSER,
    dependencies: ["setup"],
  });
}

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: true,
  workers,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  failOnFlakyTests: true,
  // A screen's first content follows a navigation, a session bootstrap and its data. Playwright's
  // 5 s default fails a correct page on a shared, CPU-saturated host (measured: 3-5 s API
  // answers while another project's VM held ten cores); 10 s keeps that from reading as a defect.
  expect: { timeout: 10_000 * slowdown },
  timeout: 30_000 * slowdown,
  reporter: [
    [ci ? "github" : "list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ...(process.env.E2E_JSON_REPORT
      ? [["json", { outputFile: process.env.E2E_JSON_REPORT }] as ["json", { outputFile: string }]]
      : []),
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video,
  },
  projects,
});
