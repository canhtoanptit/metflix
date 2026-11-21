/**
 * Desktop verification of <Player> against the generated test stream: real playback, seeking,
 * menus, captions, moments, keyboard, fullscreen, errors, host overlay and teardown.
 * Screenshots land in `.cache/screenshots/desktop/`.
 */
import { expect, test } from "@playwright/test";
import { events, openPlayer, seekTo, shot, showControls, videoState } from "./helpers.ts";

test.describe("player (desktop)", () => {
  test("plays HLS, reports progress, auto-hides controls", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode&progress=2");
    const first = await videoState(page);
    await page.waitForTimeout(2500);
    const later = await videoState(page);
    expect(later.paused).toBe(false);
    expect(later.t).toBeGreaterThan(first.t + 1.5);
    expect(later.height).toBeGreaterThan(0);

    await showControls(page);
    await shot(page, info, "01-controls-recap-dark-frame");
    // Idle: the controls and the cursor hide after 3 s of no movement.
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "hidden", {
      timeout: 6000,
    });
    await shot(page, info, "02-controls-hidden");

    const progress = await events(page, "progress");
    expect(progress.length).toBeGreaterThan(0);
    const report = progress[progress.length - 1]?.detail as Record<string, unknown>;
    expect(report).toMatchObject({ state: "playing", reason: "interval" });
    expect(report.sessionId).toMatch(/^ps-episode/);
    expect(typeof report.positionSec).toBe("number");
    expect(report.durationSec).toBe(150);
  });

  test("scrubber: hover thumbnail, drag to seek", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await showControls(page);
    const track = page.locator(".wfp-scrubber__hit");
    const box = await track.boundingBox();
    if (!box) throw new Error("no scrubber");
    // Hover at 40 % (60 s): the second sprite sheet, cell 5 (tiles cover 2 s each, 25 per sheet).
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
    const frame = page.locator(".wfp-scrubber__frame");
    await expect(frame).toBeVisible();
    const style = await frame.getAttribute("style");
    expect(style).toContain("trickplay/1.webp");
    await expect(page.locator(".wfp-scrubber__time")).toHaveText("1:00");
    await page.waitForTimeout(300);
    await shot(page, info, "03-scrubber-hover-trickplay");

    // Drag from 20 % to 60 %: the thumbnail follows; the picture seeks on release.
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 6 });
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 6 });
    await expect(page.locator(".wfp-scrubber")).toHaveAttribute("data-dragging", "");
    await expect(page.locator(".wfp-scrubber__time")).toHaveText(/^1:(29|30)$/);
    await shot(page, info, "04-scrubber-dragging");
    await page.mouse.up();
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>(".wfp-video");
      return !!video && Math.abs(video.currentTime - 90) < 3 && !video.seeking;
    });
  });

  test("keyboard map with visible feedback", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await seekTo(page, 30);
    await page.locator(".wfp-root").focus();

    await page.keyboard.press("Space");
    await expect.poll(async () => (await videoState(page)).paused).toBe(true);
    await expect(page.locator(".wfp-feedback--pulse")).toBeVisible();
    await page.keyboard.press("k");
    await expect.poll(async () => (await videoState(page)).paused).toBe(false);

    const before = (await videoState(page)).t;
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".wfp-feedback--seek")).toBeVisible();
    await shot(page, info, "05-key-seek-forward");
    await expect.poll(async () => (await videoState(page)).t).toBeGreaterThan(before + 8);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await videoState(page)).t).toBeLessThan(before);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await videoState(page)).volume).toBeCloseTo(0.8, 2);
    await expect(page.locator(".wfp-feedback--volume")).toBeVisible();
    await shot(page, info, "06-key-volume");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("m");
    await expect.poll(async () => (await videoState(page)).muted).toBe(true);
    await page.keyboard.press("m");
    await expect.poll(async () => (await videoState(page)).muted).toBe(false);

    await page.keyboard.press("5");
    await expect.poll(async () => (await videoState(page)).t).toBeGreaterThan(73);
    await expect.poll(async () => (await videoState(page)).t).toBeLessThan(80);

    await page.keyboard.press("Shift+.");
    await expect.poll(async () => (await videoState(page)).rate).toBe(1.25);
    await expect(page.locator(".wfp-feedback--toast")).toContainText("1.25×");
    await page.keyboard.press("Shift+,");
    await expect.poll(async () => (await videoState(page)).rate).toBe(1);

    // C: subtitles on (the cue at 1:15 is long enough to wrap on phones).
    await page.keyboard.press("c");
    await expect(page.locator(".wfp-feedback--toast")).toContainText("Subtitles: English");
    await seekTo(page, 66);
    await expect(page.locator(".wfp-cue")).toContainText("This line is long enough");
    await page.keyboard.press("c");
    await expect(page.locator(".wfp-cue")).toHaveCount(0);

    // F: fullscreen on the player root; Esc leaves it.
    await page.keyboard.press("f");
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.className ?? ""))
      .toContain("wfp-root");
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-fullscreen", "");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

    // Shortcuts never fire while typing in a host field.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.id = "host-input";
      document.body.append(input);
    });
    await page.locator("#host-input").focus();
    await page.keyboard.press("Space");
    expect((await videoState(page)).paused).toBe(false);
  });

  test("audio & subtitles, speed and quality menus", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await seekTo(page, 46);
    await showControls(page);

    await page.getByRole("button", { name: "Audio & Subtitles" }).click();
    const menu = page.getByRole("menu", { name: "Audio & Subtitles" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: "English" })).toHaveCount(2);
    await menu
      .getByRole("group", { name: "Subtitles" })
      .getByRole("menuitemradio", { name: "Español" })
      .click();
    await expect(page.locator(".wfp-cue")).toContainText("Buenos días");
    await menu
      .getByRole("group", { name: "Audio" })
      .getByRole("menuitemradio", { name: "Español" })
      .click();
    await expect(
      menu.getByRole("group", { name: "Audio" }).getByRole("menuitemradio", { name: "Español" }),
    ).toHaveAttribute("aria-checked", "true");
    await shot(page, info, "07-menu-audio-subtitles");
    // Keyboard inside the menu: arrows move, Esc closes and returns focus to the trigger.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Audio & Subtitles" })).toBeFocused();

    await page.getByRole("button", { name: "Playback speed" }).click();
    const speed = page.getByRole("menu", { name: "Playback speed" });
    await speed.getByRole("menuitemradio", { name: "1.5×" }).click();
    await expect.poll(async () => (await videoState(page)).rate).toBe(1.5);
    await shot(page, info, "08-menu-speed");
    await speed.getByRole("menuitemradio", { name: "1× (Normal)" }).click();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Quality" }).click();
    const quality = page.getByRole("menu", { name: "Quality" });
    await expect(quality.getByRole("menuitemradio")).toHaveCount(5);
    await quality.getByRole("menuitemradio", { name: /^1080p/ }).click();
    await expect
      .poll(
        async () => {
          const changes = await events(page, "quality");
          return changes.some((change) => {
            const detail = change.detail as {
              selection: unknown;
              active: { height: number } | null;
            };
            return (
              JSON.stringify(detail.selection) === '{"height":1080}' &&
              detail.active?.height === 1080
            );
          });
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect.poll(async () => (await videoState(page)).height, { timeout: 20_000 }).toBe(1080);
    await shot(page, info, "09-menu-quality-1080p");

    const prefs = await events(page, "preferences");
    const last = prefs[prefs.length - 1]?.detail as { prefs: Record<string, unknown> };
    expect(last.prefs).toMatchObject({
      subtitleLanguage: "es",
      audioLanguage: "es",
      playbackRate: 1,
    });
    // Remembered across reloads (localStorage).
    await page.reload();
    await page.waitForSelector(".wfp-root");
    await seekTo(page, 46);
    await expect(page.locator(".wfp-cue")).toContainText("Buenos días");
  });

  test("plan cap: a 720p session never offers or fetches 1080p", async ({ page }, info) => {
    const fetched: string[] = [];
    page.on("request", (request) => fetched.push(new URL(request.url()).pathname));
    await openPlayer(page, "scenario=capped");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.locator(".wfp-root").focus();
    await page.keyboard.press("f");
    await seekTo(page, 40);
    await page.waitForTimeout(3000);
    await showControls(page);
    await page.getByRole("button", { name: "Quality" }).click();
    const quality = page.getByRole("menu", { name: "Quality" });
    await expect(quality.getByRole("menuitemradio")).toHaveCount(4);
    await expect(quality.getByRole("menuitemradio", { name: /^1080p/ })).toHaveCount(0);
    await shot(page, info, "27-quality-capped-720p");
    expect(fetched.some((path) => path.includes("/1080p/"))).toBe(false);
    expect(fetched.some((path) => path.includes("/720p/"))).toBe(true);
    expect((await videoState(page)).height).toBeLessThanOrEqual(720);
  });

  test("audio track switch loads the other audio rendition", async ({ page }) => {
    const fetched: string[] = [];
    page.on("request", (request) => fetched.push(new URL(request.url()).pathname));
    await openPlayer(page, "scenario=episode");
    expect(fetched.some((path) => path.includes("/audio_en/"))).toBe(true);
    expect(fetched.some((path) => path.includes("/audio_es/"))).toBe(false);
    await showControls(page);
    await page.getByRole("button", { name: "Audio & Subtitles" }).click();
    await page
      .getByRole("menu", { name: "Audio & Subtitles" })
      .getByRole("group", { name: "Audio" })
      .getByRole("menuitemradio", { name: "Español" })
      .click();
    await expect.poll(() => fetched.some((path) => path.includes("/audio_es/seg_"))).toBe(true);
    expect((await videoState(page)).paused).toBe(false);
  });

  test("captions are legible on bright frames and rise above the controls", async ({
    page,
  }, info) => {
    await openPlayer(page, "scenario=episode");
    await page.locator(".wfp-root").focus();
    await page.keyboard.press("c");
    await seekTo(page, 66);
    await page.keyboard.press("Space");
    await expect(page.locator(".wfp-cue")).toBeVisible();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await shot(page, info, "10-captions-bright-frame-paused");
    const lifted = await page.locator(".wfp-captions__region--bottom").boundingBox();
    const bar = await page.locator(".wfp-bottom").boundingBox();
    expect(lifted && bar && lifted.y + lifted.height).toBeLessThanOrEqual((bar?.y ?? 0) + 4);
    await seekTo(page, 61);
    await expect(page.locator(".wfp-captions__region--top")).toBeVisible();
    await shot(page, info, "11-captions-top-positioned");
  });

  test("skip intro / recap", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await seekTo(page, 4);
    await expect(page.getByRole("button", { name: "Skip Recap" })).toBeVisible();
    await seekTo(page, 23);
    const skip = page.getByRole("button", { name: "Skip Intro" });
    await expect(skip).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-controls", "hidden", {
      timeout: 6000,
    });
    await shot(page, info, "12-skip-intro-controls-hidden");
    await skip.click();
    await expect.poll(async () => (await videoState(page)).t).toBeGreaterThanOrEqual(42.5);
    await expect(skip).toHaveCount(0);
  });

  test("next-episode countdown swaps the source in place", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode&countdown=5");
    const firstSession = await page.evaluate(() => window.__pg?.session()?.id);
    await page.locator(".wfp-root").focus();
    await page.keyboard.press("f");
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-fullscreen", "");
    await seekTo(page, 129);
    const card = page.getByRole("group", { name: "Next Episode" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(
      card.getByRole("button", { name: /Play Next Episode\. Next episode in \d/ }),
    ).toBeVisible();
    await page.waitForTimeout(1200);
    await shot(page, info, "13-next-episode-countdown");

    await page.waitForFunction(
      () => window.__pg?.events.some((event) => event.name === "next-episode"),
      null,
      {
        timeout: 12_000,
      },
    );
    const next = (await events(page, "next-episode"))[0]?.detail;
    expect(next).toEqual({ id: "kestrel-s1e2", reason: "autoplay" });
    await page.waitForFunction(
      (id) => window.__pg?.session()?.id !== id && window.__pg?.handle()?.getPhase() === "playing",
      firstSession,
    );
    // Same element, same fullscreen, new source from the start.
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-fullscreen", "");
    expect((await videoState(page)).t).toBeLessThan(6);
    await expect(page.locator(".wfp-title__episode")).toContainText("The Ledger");
    await showControls(page);
    await shot(page, info, "14-after-autoplay-next-fullscreen");
    await page.keyboard.press("Escape");
  });

  test("watch credits, autoplay off, and manual next", async ({ page }) => {
    await openPlayer(page, "scenario=episode&autoplayNext=0");
    await seekTo(page, 132);
    const group = page.getByRole("group", { name: "Next Episode" });
    await expect(group).toBeVisible();
    await expect(group.getByRole("button", { name: "Play Next Episode" })).toBeVisible();
    await page.waitForTimeout(2500);
    expect(await events(page, "next-episode")).toHaveLength(0);
    await group.getByRole("button", { name: "Watch Credits" }).click();
    await expect(group).toHaveCount(0);
    // At the end the card returns as post-play; Shift+N goes next.
    await seekTo(page, 148);
    await expect(page.getByRole("region", { name: "Next Episode" })).toBeVisible({
      timeout: 10_000,
    });
    await page.locator(".wfp-root").focus();
    await page.keyboard.press("Shift+N");
    await expect.poll(async () => (await events(page, "next-episode")).length).toBe(1);
  });

  test("end screen for the last episode and a movie", async ({ page }, info) => {
    await openPlayer(page, "scenario=last-episode");
    await seekTo(page, 74);
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-endscreen", "credits", {
      timeout: 8000,
    });
    await expect(page.getByRole("heading", { name: "More Like This" })).toBeVisible();
    await page.waitForTimeout(900);
    await shot(page, info, "15-endscreen-credits");
    await page.getByRole("button", { name: "Watch Credits" }).click();
    await expect(page.locator(".wfp-root")).not.toHaveAttribute("data-endscreen", /.+/);
    await seekTo(page, 88);
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-endscreen", "ended", {
      timeout: 8000,
    });
    await expect(page.getByRole("button", { name: "Replay" }).first()).toBeVisible();
    await page.waitForTimeout(900);
    await shot(page, info, "16-endscreen-ended");
    expect((await events(page, "ended")).length).toBe(1);
    await page.getByRole("button", { name: "Replay" }).first().click();
    await expect.poll(async () => (await videoState(page)).t).toBeLessThan(5);

    await openPlayer(page, "scenario=movie");
    await expect(page.getByRole("button", { name: "Episodes" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next Episode" })).toHaveCount(0);
    await showControls(page);
    await shot(page, info, "17-movie-controls");
  });

  test("episodes panel loads seasons lazily and selects an episode", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await showControls(page);
    await page.getByRole("button", { name: "Episodes" }).click();
    const panel = page.getByRole("dialog", { name: "Episodes" });
    await expect(panel.getByRole("button", { name: /The Harbour Lights/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await page.waitForTimeout(400);
    await shot(page, info, "18-episodes-panel");
    await panel.getByLabel("Season").selectOption("2");
    await expect(panel.locator("[aria-busy='true']")).toBeVisible();
    await shot(page, info, "19-episodes-loading");
    await expect(panel.getByRole("button", { name: /Return/ })).toBeVisible();
    await panel.getByLabel("Season").selectOption("3");
    await expect(panel.getByRole("alert")).toContainText("couldn't be loaded");
    await panel.getByRole("button", { name: "Retry" }).click();
    await expect(panel.getByRole("button", { name: /Lighthouse/ })).toBeVisible();
    await panel.getByLabel("Season").selectOption("1");
    await panel.getByRole("button", { name: /The Ledger/ }).click();
    await expect
      .poll(async () => (await events(page, "select-episode")).map((e) => e.detail))
      .toEqual(["kestrel-s1e2"]);
    await expect(panel).toHaveCount(0);
    await page.waitForFunction(() => window.__pg?.session()?.id.startsWith("ps-last"));
  });

  test("paused overlay after idle", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await seekTo(page, 100);
    await page.locator(".wfp-root").focus();
    await page.keyboard.press("Space");
    await page.mouse.move(5, 5);
    await expect(page.locator(".wfp-paused")).toHaveAttribute("data-visible", "", {
      timeout: 12_000,
    });
    await page.waitForTimeout(800);
    await shot(page, info, "20-paused-overlay");
    await page.mouse.move(700, 400);
    await expect(page.locator(".wfp-paused")).not.toHaveAttribute("data-visible", "");
  });

  test("fullscreen and picture-in-picture buttons", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await seekTo(page, 58);
    await showControls(page);
    await page.getByRole("button", { name: "Full screen" }).click();
    await expect(page.locator(".wfp-root")).toHaveAttribute("data-fullscreen", "");
    await showControls(page);
    await shot(page, info, "21-fullscreen-bright-frame");
    await page.getByRole("button", { name: "Exit full screen" }).click();
    await expect(page.locator(".wfp-root")).not.toHaveAttribute("data-fullscreen", "");

    const pip = page.getByRole("button", { name: "Picture in picture" });
    if ((await pip.count()) > 0) {
      await pip.click();
      const entered = await page
        .waitForFunction(() => document.pictureInPictureElement !== null, null, { timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      info.annotations.push({
        type: "pip",
        description: entered ? "entered" : "refused by headless browser",
      });
      if (entered) {
        await expect(page.locator(".wfp-pip-placeholder")).toBeVisible();
        await shot(page, info, "22-pip-placeholder");
        await page.getByRole("button", { name: "Exit picture in picture" }).click();
      }
    }
  });

  test("expired media token: fatal error, then the host recreates the session", async ({
    page,
  }, info) => {
    await openPlayer(page, "scenario=expired", { waitForPlaying: false });
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("This playback session has expired.");
    await expect(dialog).toContainText("WFP-FORBIDDEN-403");
    await expect(dialog.getByRole("button", { name: "Try Again" })).toBeFocused();
    await shot(page, info, "23-error-expired");
    const error = (await events(page, "error"))[0]?.detail;
    expect(error).toMatchObject({ code: "forbidden", httpStatus: 403, fatal: true });
    await page.waitForFunction(() =>
      window.__pg?.events.some((event) => event.name === "state" && event.detail === "playing"),
    );
    await expect(dialog).toHaveCount(0);
  });

  test("host blocking overlay pauses and holds focus", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode");
    await page.evaluate(() => window.__pg?.setBlocked(true));
    const overlay = page.getByRole("dialog").filter({ hasText: "too many screens" });
    await expect(overlay).toBeVisible();
    await expect.poll(async () => (await videoState(page)).paused).toBe(true);
    await expect(overlay.getByRole("button", { name: "Try Again" })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(overlay.getByRole("button", { name: "Try Again" })).toBeFocused();
    await page.keyboard.press("k");
    expect((await videoState(page)).paused).toBe(true);
    await shot(page, info, "24-blocking-overlay");
    await overlay.getByRole("button", { name: "Try Again" }).click();
    await expect(overlay).toHaveCount(0);
  });

  test("alternate theme through --wfp-* variables", async ({ page }, info) => {
    await openPlayer(page, "scenario=episode&theme=alt");
    await seekTo(page, 46);
    await showControls(page);
    await page.getByRole("button", { name: "Audio & Subtitles" }).click();
    await page.waitForTimeout(300);
    await shot(page, info, "25-theme-alternate");
    const accent = await page
      .locator(".wfp-scrubber__played")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(accent).toBe("rgb(45, 212, 191)");
  });

  test("teardown: unmount and remount leave nothing playing", async ({ page }) => {
    await openPlayer(page, "scenario=episode");
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.__pg?.setMounted(false));
      await expect(page.locator("video")).toHaveCount(0);
      await page.evaluate(() => window.__pg?.setMounted(true));
      await expect(page.locator("video")).toHaveCount(1);
    }
    await page.evaluate(() => window.__pg?.setMounted(false));
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/media/")) requests.push(request.url());
    });
    await page.waitForTimeout(3000);
    expect(requests).toEqual([]);
    const progress = await events(page, "progress");
    expect(progress.some((event) => (event.detail as { reason: string }).reason === "unload")).toBe(
      true,
    );
  });

  test("autoplay blocked shows a play button", async ({ page }, info) => {
    // Headless Chromium ignores --autoplay-policy (and the test runner reports a prior user
    // activation), so enforce the policy here: unmuted play() before a gesture is refused.
    await page.addInitScript(() => {
      let gesture = false;
      for (const type of ["pointerdown", "keydown"]) {
        window.addEventListener(
          type,
          (event) => {
            if (event.isTrusted) gesture = true;
          },
          true,
        );
      }
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        if (!gesture && !this.muted) {
          return Promise.reject(new DOMException("play() needs a user gesture", "NotAllowedError"));
        }
        return play.call(this);
      };
    });
    {
      await page.goto("/?ui=0&scenario=episode");
      const play = page.locator(".wfp-autoplay__button");
      await expect(play).toBeVisible();
      await page.waitForTimeout(600);
      await shot(page, info, "26-autoplay-blocked");
      await play.click();
      await page.waitForFunction(() => {
        const video = document.querySelector<HTMLVideoElement>(".wfp-video");
        return !!video && !video.paused && video.currentTime > 0.5;
      });
      await expect(play).toHaveCount(0);
    }
  });
});
