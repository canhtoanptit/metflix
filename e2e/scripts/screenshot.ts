/**
 * Full-page screenshots of any route at several widths, for visual review.
 *
 *   pnpm --filter @webflix/e2e shot -- /browse /dev/reference
 *   pnpm --filter @webflix/e2e shot -- --widths 390,834,1440 --session account /profiles
 *   BASE_URL=http://localhost:5173 pnpm --filter @webflix/e2e shot -- /browse   (running app)
 *
 * Without BASE_URL it starts the web app in mock mode on E2E_MOCK_PORT (default 4210) and stops
 * it afterwards. `--session anonymous|account|profile` picks the mock session (mock mode only).
 * Pages are scrolled to the bottom first so lazily loaded rows and images are in the capture.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

interface Options {
  routes: string[];
  widths: number[];
  session: "anonymous" | "account" | "profile" | null;
  out: string;
  base: string | null;
  fullPage: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    routes: [],
    widths: [390, 834, 1440],
    session: "profile",
    out: join(repoRoot, "e2e/screenshots", new Date().toISOString().replaceAll(/[:.]/g, "-")),
    base: process.env.BASE_URL ?? null,
    fullPage: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const value = () => argv[++index] ?? "";
    if (arg === "--") continue;
    else if (arg === "--widths") options.widths = value().split(",").map(Number).filter(Boolean);
    else if (arg === "--session") {
      const session = value();
      options.session = session === "none" ? null : (session as Options["session"]);
    } else if (arg === "--out") options.out = resolve(value());
    else if (arg === "--base") options.base = value();
    else if (arg === "--viewport-only") options.fullPage = false;
    else if (arg.startsWith("/")) options.routes.push(arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.routes.length === 0) options.routes = ["/dev/reference"];
  return options;
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startMockServer(port: number): ChildProcess {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@webflix/web",
      "exec",
      "vite",
      "--mode",
      "mock",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, WEB_PORT: String(port) },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    },
  );
  return child;
}

/** Scroll through the page so lazy rows mount and lazy images load, then return to the top. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.75);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolveFrame) => setTimeout(resolveFrame, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images)
        .filter((image) => !image.complete)
        .map(
          (image) =>
            new Promise((done) => {
              image.addEventListener("load", done, { once: true });
              image.addEventListener("error", done, { once: true });
              setTimeout(done, 3000);
            }),
        ),
    ),
  );
  await page.waitForTimeout(400);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const port = Number(process.env.E2E_MOCK_PORT ?? 4210);
  let server: ChildProcess | null = null;
  let base = options.base;
  if (!base) {
    base = `http://localhost:${port}`;
    server = startMockServer(port);
    await waitForServer(base);
  }
  mkdirSync(options.out, { recursive: true });
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    for (const width of options.widths) {
      const context = await browser.newContext({
        viewport: { width, height: width < 600 ? 844 : width < 1000 ? 1112 : 900 },
        deviceScaleFactor: width < 600 ? 3 : 2,
        hasTouch: width < 1000,
        isMobile: width < 600,
      });
      // Hide development chrome so captures show the product only.
      await context.addInitScript(() => {
        const style = document.createElement("style");
        style.textContent = '[data-testid="dev-toolbar"]{display:none!important}';
        document.addEventListener("DOMContentLoaded", () => document.head.append(style));
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => console.warn(`  page error at ${width}px: ${error.message}`));
      for (const route of options.routes) {
        const url = new URL(route, base);
        // Read by mock mode only; a real API ignores it.
        if (options.session) url.searchParams.set("mock-session", options.session);
        await page.goto(url.toString(), { waitUntil: "networkidle" });
        await settle(page);
        const name = `${route.replaceAll(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}-${width}.png`;
        const file = join(options.out, name);
        await page.screenshot({ path: file, fullPage: options.fullPage });
        written.push(file);
        console.log(`  ${file}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    if (server?.pid) process.kill(-server.pid, "SIGTERM");
  }
  console.log(`\n${written.length} screenshot(s) in ${options.out}`);
}

await main();
