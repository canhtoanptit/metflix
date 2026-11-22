import type { Page } from "@playwright/test";
import { createAccount, findPlayableTitle } from "./api.ts";
import { expect, test } from "./fixtures.ts";
import { videoState, waitForPlayback } from "./member-support.ts";

/**
 * Regression for a stall the 4x-throttled gate run found: after a seek near the end, hls.js
 * sometimes never ends the MediaSource (`endOfStream()` is never called), so the element waits
 * forever a few frames short of the end (149.95 of 150, readyState 2, MediaSource "open") and
 * the member sees a spinner instead of the end screen. The player now ends the stream itself
 * when playback stalls in the last half second.
 *
 * The loss is made deterministic here: every `endOfStream()` call made before the last half
 * second is dropped, so only a call made once playback has stalled at the end gets through.
 */

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

interface EndOfStreamProbe {
  mediaSources: number;
  lost: number;
}

/** The post-play moment's lead recommendation (named by the recommended title). */
const leadOf = (page: Page) =>
  page
    .getByRole("region")
    .filter({ has: page.getByRole("button", { name: /^Play / }) })
    .filter({ hasNot: page.getByRole("region") });

test("a film still ends, with its end screen, when the engine never ends the stream", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const probe: EndOfStreamProbe = { mediaSources: 0, lost: 0 };
    (window as unknown as { __endOfStream: EndOfStreamProbe }).__endOfStream = probe;
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = (object: Blob | MediaSource) => {
      if (object instanceof MediaSource) probe.mediaSources += 1;
      return createObjectURL(object);
    };
    const endOfStream = MediaSource.prototype.endOfStream;
    MediaSource.prototype.endOfStream = function (this: MediaSource, ...args: [EndOfStreamError?]) {
      const video = document.querySelector("video");
      if (video && video.duration - video.currentTime >= 0.5) {
        probe.lost += 1;
        return;
      }
      endOfStream.apply(this, args);
    };
  });
  await createAccount(page.context().request, { tag: "endofstream" });
  const movie = await findPlayableTitle(page.context().request, "movie");
  await page.goto("/browse");
  await page.goto(`/watch/${movie.id}?t=0`);
  await waitForPlayback(page, 0.5);
  await page.evaluate(() => {
    const video = document.querySelector("video");
    if (video) video.currentTime = Math.max(0, video.duration - 3);
  });

  // The pause before the end is the stall detector's (about a second), not a wait for data.
  try {
    await expect
      .poll(() => page.evaluate(() => document.querySelector("video")?.ended ?? false))
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nvideo element: ${JSON.stringify(await videoState(page))}`,
    );
  }
  await expect(leadOf(page)).toBeVisible();

  // The path under test was taken: hls.js on a MediaSource, and its end-of-stream was lost.
  const probe = await page.evaluate(
    () => (window as unknown as { __endOfStream: EndOfStreamProbe }).__endOfStream,
  );
  expect(probe.mediaSources).toBeGreaterThan(0);
  expect(probe.lost).toBeGreaterThan(0);
});
