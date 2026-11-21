/**
 * Browser verification for the player: `pnpm --filter @webflix/player verify`.
 * Drives the playground (started on :4300 if not already running) against the generated test
 * media, and writes screenshots of every state to `.cache/screenshots/<project>/`.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PLAYER_PLAYGROUND_PORT ?? 4300);

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../.cache/playwright/results",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  webServer: {
    command: "pnpm playground",
    cwd: "..",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
      testMatch: /(player|preview)\.spec\.ts/,
    },
    {
      name: "mobile-portrait",
      use: { ...devices["Pixel 7"] },
      testMatch: /touch\.spec\.ts/,
    },
    {
      name: "mobile-landscape",
      use: { ...devices["Pixel 7 landscape"] },
      testMatch: /touch\.spec\.ts/,
    },
  ],
});
