import { defineConfig, devices, type Project } from "@playwright/test";

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
 */
const baseURL = process.env.BASE_URL ?? "http://localhost:5173";
const ci = Boolean(process.env.CI);
const browsers = new Set(
  (process.env.E2E_BROWSERS ?? "chromium,firefox,webkit").split(",").map((name) => name.trim()),
);
const CROSS_BROWSER = /cross-browser\.spec\.ts$/;
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
for (const [name, device] of [
  ["firefox", devices["Desktop Firefox"]],
  ["webkit", devices["Desktop Safari"]],
] as const) {
  if (!browsers.has(name)) continue;
  projects.push({ name, use: { ...device }, testMatch: CROSS_BROWSER, dependencies: ["setup"] });
}

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: true,
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
    video: "retain-on-failure",
  },
  projects,
});
