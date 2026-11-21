// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { makePlaybackSession } from "@webflix/contracts/fixtures";
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
      "Audio & Subtitles",
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

  it("opens the audio & subtitles menu with checked items", async () => {
    renderPlayer();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Audio & Subtitles" }));
    const menu = screen.getByRole("menu", { name: "Audio & Subtitles" });
    const off = within(menu).getByRole("menuitemradio", { name: "Off" });
    expect(off.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "English" }));
    expect(
      within(menu).getByRole("menuitemradio", { name: "English" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
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
