import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";

export const SHOTS_DIR = resolve(import.meta.dirname, "../../.cache/screenshots");

export interface VideoState {
  t: number;
  paused: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  width: number;
  height: number;
  ended: boolean;
}

export interface PgEvent {
  at: number;
  name: string;
  detail: unknown;
}

/** Open the playground with query params and wait until playback has started. */
export async function openPlayer(page: Page, query: string, { waitForPlaying = true } = {}) {
  await page.goto(`/?ui=0&${query}`);
  await page.waitForSelector(".wfp-root");
  if (waitForPlaying) {
    await page.waitForFunction(() =>
      window.__pg?.events.some((event) => event.name === "state" && event.detail === "playing"),
    );
  }
}

export function videoState(page: Page): Promise<VideoState> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(".wfp-video");
    if (!video) throw new Error("no video");
    return {
      t: video.currentTime,
      paused: video.paused,
      rate: video.playbackRate,
      volume: video.volume,
      muted: video.muted,
      width: video.videoWidth,
      height: video.videoHeight,
      ended: video.ended,
    };
  });
}

export function events(page: Page, name?: string): Promise<PgEvent[]> {
  return page.evaluate(
    (filter) => (window.__pg?.events ?? []).filter((event) => !filter || event.name === filter),
    name ?? null,
  );
}

/** Seek through the public handle and wait until the element has data there. */
export async function seekTo(page: Page, seconds: number) {
  await page.evaluate((s) => window.__pg?.handle()?.seek(s), seconds);
  await page.waitForFunction((s) => {
    const video = document.querySelector<HTMLVideoElement>(".wfp-video");
    return (
      !!video && Math.abs(video.currentTime - s) < 1.5 && !video.seeking && video.readyState >= 3
    );
  }, seconds);
}

export async function showControls(page: Page) {
  const box = await page.locator(".wfp-root").boundingBox();
  if (!box) throw new Error("no player");
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.46);
  await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "shown");
}

export async function shot(page: Page, info: TestInfo, name: string) {
  const dir = resolve(SHOTS_DIR, info.project.name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, `${name}.png`) });
}
