// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { makeImageSet, makePlaybackSession } from "@webflix/contracts/fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEvents } from "../src/engine/types.ts";

// The engine is the only part that needs a real browser; everything above it runs here.
const engines: { events: EngineEvents; destroyed: boolean; url: string; maxVideoHeight: number }[] =
  [];
vi.mock("../src/engine/create-engine.ts", () => ({
  resolveEngineKind: async (url: string) => (url.endsWith(".m3u8") ? "hls.js" : "progressive"),
  defaultEngineFactory: async (
    kind: string,
    _media: HTMLVideoElement,
    config: { url: string; maxVideoHeight: number },
    events: EngineEvents,
  ) => {
    const engine = {
      events,
      destroyed: false,
      url: config.url,
      maxVideoHeight: config.maxVideoHeight,
    };
    engines.push(engine);
    return {
      kind,
      setQuality: () => {},
      setAudioTrack: () => {},
      destroy: () => {
        engine.destroyed = true;
      },
    };
  },
}));

const { Player, PreviewPlayer, createMemoryPreferenceStorage } = await import("../src/index.ts");

// jsdom has media elements but no playback: emulate play/pause and their events.
beforeAll(() => {
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  Object.defineProperties(HTMLMediaElement.prototype, {
    paused: {
      configurable: true,
      get(this: HTMLMediaElement) {
        return paused.get(this) ?? true;
      },
    },
    play: {
      configurable: true,
      value(this: HTMLMediaElement) {
        paused.set(this, false);
        this.dispatchEvent(new Event("play"));
        this.dispatchEvent(new Event("playing"));
        return Promise.resolve();
      },
    },
    pause: {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (paused.get(this) === false) {
          paused.set(this, true);
          this.dispatchEvent(new Event("pause"));
        }
      },
    },
    load: { configurable: true, value() {} },
  });
});

beforeEach(() => {
  engines.length = 0;
});
afterEach(() => cleanup());

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

/** Move the jsdom playhead (it has no playback of its own) and tell the player. */
function playhead(video: HTMLVideoElement, seconds: number, duration = 2700) {
  Object.defineProperty(video, "duration", { configurable: true, get: () => duration });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => seconds,
    set: () => {},
  });
  act(() => {
    video.dispatchEvent(new Event("durationchange"));
    video.dispatchEvent(new Event("timeupdate"));
  });
}

const liveRegion = (container: HTMLElement) =>
  container.querySelector("[aria-live='polite']")?.textContent ?? "";

function renderPlayer(props: Partial<Parameters<typeof Player>[0]> = {}) {
  const session = makePlaybackSession();
  const handlers = {
    onBack: vi.fn(),
    onNextEpisode: vi.fn(),
    onSelectEpisode: vi.fn(),
    onError: vi.fn(),
  };
  const utils = render(
    <div style={{ width: 1280, height: 720 }}>
      <Player
        session={session}
        preferenceStorage={createMemoryPreferenceStorage()}
        {...handlers}
        {...props}
      />
    </div>,
  );
  return { session, handlers, ...utils };
}

describe("<Player>", () => {
  it("loads the session through the engine with the plan cap", async () => {
    const { session } = renderPlayer();
    await settle();
    expect(engines).toHaveLength(1);
    expect(engines[0]).toMatchObject({ url: session.manifestUrl, maxVideoHeight: 1080 });
    expect(
      screen.getByRole("region", { name: /Night Shift at Kestrel Bay, S1:E1 Chapter 1/ }),
    ).toBeTruthy();
  });

  it("labels every control", async () => {
    renderPlayer({ episodes: { seasons: [], loadEpisodes: async () => [] } });
    await settle();
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-label") || button.textContent?.trim()).toBeTruthy();
    }
    expect(screen.getByRole("slider", { name: "Seek" }).getAttribute("aria-valuetext")).toMatch(
      /of 45 minutes/,
    );
    for (const name of [
      "Back",
      "Pause",
      "Back 10 seconds",
      "Forward 10 seconds",
      "Mute",
      "Episodes",
      "Subtitles",
      "Playback speed",
      "Next Episode",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("toggles playback with Space anywhere on the page", async () => {
    const { container } = renderPlayer();
    await settle();
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.paused).toBe(false);
    fireEvent.keyDown(document.body, { key: " " });
    expect(video.paused).toBe(true);
    await settle();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("opens the subtitles menu with checked items", async () => {
    renderPlayer();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    const menu = screen.getByRole("menu", { name: "Subtitles" });
    const off = within(menu).getByRole("menuitemradio", { name: "Off" });
    expect(off.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "English" }));
    expect(
      within(menu).getByRole("menuitemradio", { name: "English" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers audio only when there is a choice of tracks", async () => {
    renderPlayer();
    await settle();
    act(() => engines[0]?.events.audioTracks([{ id: 0, language: "en", name: "English" }], 0));
    expect(screen.queryByRole("button", { name: "Audio & Subtitles" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    expect(within(screen.getByRole("menu")).queryByRole("group", { name: "Audio" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    act(() =>
      engines[0]?.events.audioTracks(
        [
          { id: 0, language: "en", name: "English" },
          { id: 1, language: "es", name: "Español" },
        ],
        0,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Audio & Subtitles" }));
    const menu = screen.getByRole("menu", { name: "Audio & Subtitles" });
    expect(within(menu).getByRole("group", { name: "Audio" })).toBeTruthy();
  });

  it("lists quality classes, never bitrates or pixel heights", async () => {
    renderPlayer({
      session: makePlaybackSession({ maxVideoHeight: 2160, bestVideoQuality: "full-hd" }),
    });
    await settle();
    act(() =>
      engines[0]?.events.levels(
        [
          { id: 0, width: 640, height: 360, bitrate: 700_000 },
          { id: 1, width: 854, height: 480, bitrate: 1_200_000 },
          { id: 2, width: 1280, height: 720, bitrate: 3_000_000 },
          { id: 3, width: 1280, height: 720, bitrate: 2_000_000 },
          { id: 4, width: 1920, height: 1080, bitrate: 5_000_000 },
        ],
        true,
      ),
    );
    act(() => engines[0]?.events.levelSwitched(2));
    fireEvent.click(screen.getByRole("button", { name: "Quality" }));
    const menu = screen.getByRole("menu", { name: "Quality" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["AutoHD", "Full HD", "HD", "SD"]);
    expect(menu.textContent).not.toMatch(/\d+p|bps/);
    // A 4K plan on a Full HD title: said once, as the menu's description.
    const note = document.getElementById(menu.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe("Best available for this title: Full HD");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "HD" }));
    expect(
      within(menu).getByRole("menuitemradio", { name: "HD" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("hides the quality menu when the ladder is a single class", async () => {
    renderPlayer();
    await settle();
    act(() =>
      engines[0]?.events.levels(
        [
          { id: 0, width: 1280, height: 720, bitrate: 2_000_000 },
          { id: 1, width: 1280, height: 720, bitrate: 3_000_000 },
        ],
        true,
      ),
    );
    expect(screen.queryByRole("button", { name: "Quality" })).toBeNull();
  });

  it("shows the playing rendition in the stats overlay (Shift+D)", async () => {
    renderPlayer();
    await settle();
    act(() =>
      engines[0]?.events.levels([{ id: 0, width: 1280, height: 720, bitrate: 3_000_000 }], true),
    );
    act(() => engines[0]?.events.levelSwitched(0));
    fireEvent.keyDown(document.body, { key: "D", shiftKey: true });
    expect(screen.getByLabelText("Playback stats").textContent).toMatch(
      /1280×720 · HD · 3(\.0)? Mbps/,
    );
    fireEvent.keyDown(document.body, { key: "D", shiftKey: true });
    expect(screen.queryByLabelText("Playback stats")).toBeNull();
  });

  it("lays out the end screen with the host slot and fades the backdrop in at the end", async () => {
    const backdrop = makeImageSet();
    const { container } = renderPlayer({
      session: makePlaybackSession({ nextEpisode: null }),
      endScreenBackdrop: backdrop,
      renderEndScreen: ({ phase }) => <p>More like this ({phase})</p>,
    });
    await settle();
    const video = container.querySelector("video") as HTMLVideoElement;
    playhead(video, 2620);
    const end = screen.getByRole("region", { name: "Night Shift at Kestrel Bay" });
    expect(container.querySelector(".wfp-root")?.getAttribute("data-endscreen")).toBe("credits");
    expect(end.querySelector(".wfp-endscreen__slot")?.textContent).toBe("More like this (credits)");
    const still = end.querySelector(".wfp-endscreen__still") as HTMLElement;
    // Loaded during the credits (the video still plays in the frame), shown only at the end.
    expect(still.hasAttribute("data-visible")).toBe(false);
    expect(still.querySelector("source")?.getAttribute("type")).toBe("image/avif");
    expect(still.querySelector("img")?.getAttribute("src")).toContain(".webp");
    expect(within(end).getByRole("button", { name: "Watch Credits" })).toBeTruthy();
    act(() => {
      video.dispatchEvent(new Event("ended"));
    });
    expect(still.hasAttribute("data-visible")).toBe(true);
    expect(within(end).getByRole("button", { name: "Replay" })).toBeTruthy();
    expect(end.querySelector(".wfp-endscreen__slot")?.textContent).toBe("More like this (ended)");
  });

  it("announces a skip offer once and clears it when the end screen takes over", async () => {
    const { container } = renderPlayer({ session: makePlaybackSession({ nextEpisode: null }) });
    await settle();
    const video = container.querySelector("video") as HTMLVideoElement;
    playhead(video, 40);
    expect(screen.getByRole("button", { name: "Skip Intro" })).toBeTruthy();
    expect(liveRegion(container)).toBe("Skip Intro available. Press S.");
    playhead(video, 2620);
    expect(screen.queryByRole("button", { name: "Skip Intro" })).toBeNull();
    expect(liveRegion(container)).toBe("");
  });

  it("never announces a skip offer hidden behind an open menu", async () => {
    const { container } = renderPlayer();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Playback speed" }));
    const video = container.querySelector("video") as HTMLVideoElement;
    playhead(video, 40);
    expect(screen.queryByRole("button", { name: "Skip Intro" })).toBeNull();
    expect(liveRegion(container)).toBe("");
    // Closing the menu shows the offer, and only then is it announced.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Skip Intro" })).toBeTruthy();
    expect(liveRegion(container)).toBe("Skip Intro available. Press S.");
  });

  it("loads episodes lazily and reports the selection", async () => {
    const loadEpisodes = vi.fn(async () => [
      {
        id: "e-fixture-1",
        seasonNumber: 1,
        number: 1,
        name: "Chapter 1",
        synopsis: "One.",
        runtimeSec: 2700,
        still: null,
        isPlayable: true,
        progress: null,
      },
      {
        id: "e-fixture-2",
        seasonNumber: 1,
        number: 2,
        name: "Chapter 2",
        synopsis: "Two.",
        runtimeSec: 2650,
        still: null,
        isPlayable: true,
        progress: null,
      },
    ]);
    const { handlers } = renderPlayer({
      episodes: { seasons: [{ number: 1, name: "Season 1", episodeCount: 2 }], loadEpisodes },
    });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Episodes" }));
    await settle();
    const panel = screen.getByRole("dialog", { name: "Episodes" });
    expect(loadEpisodes).toHaveBeenCalledWith(1, expect.any(AbortSignal));
    expect(
      within(panel)
        .getByRole("button", { name: /Chapter 1/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    fireEvent.click(within(panel).getByRole("button", { name: /Chapter 2/ }));
    expect(handlers.onSelectEpisode).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e-fixture-2" }),
    );
    expect(screen.queryByRole("dialog", { name: "Episodes" })).toBeNull();
  });

  it("says what is left of started episodes, with a bar from the same numbers", async () => {
    const episode = (n: number, extra: Record<string, unknown>) => ({
      id: `e-fixture-${n}`,
      seasonNumber: 1,
      number: n,
      name: `Chapter ${n}`,
      synopsis: "…",
      runtimeSec: 2640,
      still: null,
      isPlayable: true,
      progress: null,
      ...extra,
    });
    const progress = (positionSec: number, durationSec: number, completed = false) => ({
      positionSec,
      durationSec,
      completed,
      updatedAt: "2026-01-15T18:00:00.000Z",
    });
    const { container } = renderPlayer({
      episodes: {
        seasons: [{ number: 1, name: "Season 1", episodeCount: 4 }],
        loadEpisodes: async () => [
          // The playing episode follows the live position, not the stored progress.
          episode(1, { progress: progress(60, 2700) }),
          episode(2, { progress: progress(300, 1020) }),
          episode(3, { progress: progress(2500, 2640, true) }),
          episode(4, {}),
        ],
      },
    });
    await settle();
    playhead(container.querySelector("video") as HTMLVideoElement, 2100);
    fireEvent.click(screen.getByRole("button", { name: "Episodes" }));
    await settle();
    const rows = within(screen.getByRole("dialog", { name: "Episodes" })).getAllByRole("button", {
      name: /Chapter/,
    });
    const visible = (row: HTMLElement) =>
      row.querySelector(".wfp-episode__runtime [aria-hidden='true']")?.textContent;
    const bar = (row: HTMLElement) => {
      const fill = row.querySelector<HTMLElement>(".wfp-episode__progress > span");
      return fill ? Number(/scaleX\(([\d.]+)\)/.exec(fill.style.transform)?.[1]).toFixed(3) : null;
    };
    // Completed reads "Finished" under a full bar (the shared wording), even stopped at 2500 s.
    expect(rows.map(visible)).toEqual(["10m left", "12m left", "Finished", "44m"]);
    // 2100 / 2700 live, 300 / 1020 stored, completed, unwatched.
    expect(rows.map(bar)).toEqual(["0.778", "0.294", "1.000", null]);
    expect(rows[1]?.textContent).toContain("12 minutes left");
  });

  it("shows a fatal error with retry and reports it", async () => {
    const { handlers } = renderPlayer();
    await settle();
    act(() =>
      engines[0]?.events.fatal({ code: "network", detail: "fragLoadError", httpStatus: null }),
    );
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("WFP-NETWORK");
    expect(handlers.onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "network", fatal: true }),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Try Again" }));
    await settle();
    expect(engines).toHaveLength(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders a host blocking overlay modally and pauses", async () => {
    const { container, rerender, session } = renderPlayer();
    await settle();
    rerender(
      <div style={{ width: 1280, height: 720 }}>
        <Player
          session={session}
          preferenceStorage={false}
          blockingOverlay={<button type="button">Back to browse</button>}
        />
      </div>,
    );
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((container.querySelector("video") as HTMLVideoElement).paused).toBe(true);
    expect(container.querySelector(".wfp-chrome")?.hasAttribute("inert")).toBe(true);
  });

  it("names the blocking dialog after the overlay's heading", async () => {
    const { rerender, session } = renderPlayer();
    await settle();
    rerender(
      <div style={{ width: 1280, height: 720 }}>
        <Player
          session={session}
          preferenceStorage={false}
          blockingOverlay={
            <div>
              <h2>Playback stopped</h2>
              <button type="button">Resume watching</button>
            </div>
          }
        />
      </div>,
    );
    await settle();
    expect(screen.getByRole("dialog", { name: "Playback stopped" })).toBeTruthy();
  });

  it("tears everything down on unmount", async () => {
    const { container, unmount } = renderPlayer();
    await settle();
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.querySelectorAll("track").length).toBeGreaterThan(0);
    unmount();
    expect(engines[0]?.destroyed).toBe(true);
    expect(video.querySelectorAll("track")).toHaveLength(0);
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("swaps the source in place for the next episode", async () => {
    const { rerender, container } = renderPlayer();
    await settle();
    const video = container.querySelector("video");
    const next = makePlaybackSession({
      id: "ps-next",
      manifestUrl: "/media/t/vod/next/master.m3u8",
    });
    rerender(
      <div style={{ width: 1280, height: 720 }}>
        <Player session={next} preferenceStorage={false} />
      </div>,
    );
    await settle();
    expect(container.querySelector("video")).toBe(video);
    expect(engines).toHaveLength(2);
    expect(engines[0]?.destroyed).toBe(true);
    expect(engines[1]?.url).toBe("/media/t/vod/next/master.m3u8");
  });
});

describe("<PreviewPlayer>", () => {
  it("plays muted when visible, fades in on the first frame and toggles mute", async () => {
    const onMutedChange = vi.fn();
    const { container } = render(
      <PreviewPlayer
        src="/cdn/previews/a/preview.mp4"
        poster="/poster.webp"
        showMuteToggle
        onMutedChange={onMutedChange}
      />,
    );
    await settle();
    const root = container.querySelector(".wfp-preview") as HTMLElement;
    const video = container.querySelector("video") as HTMLVideoElement;
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(false);
    expect(root.hasAttribute("data-ready")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(onMutedChange).toHaveBeenCalledWith(false);
    expect(video.muted).toBe(false);
  });

  it("pauses when the host deactivates it and releases the source on unmount", async () => {
    const { container, rerender, unmount } = render(
      <PreviewPlayer src="/media/t/vod/a/master.m3u8" />,
    );
    await settle();
    const video = container.querySelector("video") as HTMLVideoElement;
    rerender(<PreviewPlayer src="/media/t/vod/a/master.m3u8" active={false} />);
    await settle();
    expect(video.paused).toBe(true);
    unmount();
    expect(engines.at(-1)?.destroyed).toBe(true);
  });
});
