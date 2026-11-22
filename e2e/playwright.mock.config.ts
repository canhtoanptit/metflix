import { defineConfig, devices } from "@playwright/test";
import { video, workers } from "./host-limits.ts";

/**
 * UI suites against the web app in mock mode (no backend): guards, overlay, slider interaction,
 * accessibility. Starts `vite --mode mock` on E2E_MOCK_PORT (default 4210) unless one is running.
 *
 *   pnpm --filter @webflix/e2e e2e:mock        (or: make e2e-mock, under the host guard)
 *
 * Host limits as in the main suite (host-limits.ts): 4 workers (E2E_WORKERS), video only with
 * E2E_VIDEO=1.
 */
const port = Number(process.env.E2E_MOCK_PORT ?? 4210);
const baseURL = `http://localhost:${port}`;
const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./mock",
  outputDir: "./test-results/mock",
  fullyParallel: true,
  workers,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: [
    [ci ? "github" : "list"],
    ["html", { open: "never", outputFolder: "playwright-report/mock" }],
  ],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", video },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm --filter @webflix/web exec vite --mode mock --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !ci,
    timeout: 120_000,
    env: { WEB_PORT: String(port) },
  },
});
