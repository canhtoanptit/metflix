# @webflix/player

The Webflix video player: a self-contained React component library.

- **`<Player>`** — the full watch experience. Give it a `PlaybackSession` (from `POST /playback/sessions`), get events back. It never calls the Webflix API.
- **`<PreviewPlayer>`** — muted, chrome-less clip player for the billboard and hover cards.

Plain CSS ships with the components (imported by them, nothing to wire up) and is themed entirely through `--wfp-*` custom properties. No Tailwind, no dependency on `@webflix/ui`. hls.js is loaded on demand (dynamic import), so it stays out of the initial browse bundle.

```
src/
  core/        pure logic, no DOM: state machine (state.ts), keyboard map, moments (skip/countdown/end
               screen), idle controls, tap gestures, trick-play maths, preferences, track rules,
               error-recovery policy, cue-text parser, formatting, labels
  engine/      hls.js engine, native/progressive engine, engine choice
  controller/  PlayerController: owns the <video>, engine, timers, listeners, host callbacks
  react/       the view: <Player>, <PreviewPlayer>, controls, menus, overlays, episodes panel, icons
  styles/      player.css, preview.css
```

---

## Watch page integration (complete example)

The watch page owns the API calls; the player owns playback. Keep **one** `<Player>` mounted for the whole watch session and pass it new sessions: next episode, episode picked in the panel and recreated sessions all load in place, on the same `<video>`, staying in fullscreen.

```tsx
import { ApiError, createApiClient, type PlaybackSession } from "@webflix/contracts";
import { Player, type PlayerError, type PlayerHandle, type ProgressReport } from "@webflix/player";
import { useEffect, useMemo, useRef, useState } from "react";

const api = createApiClient();

export function WatchPage({ titleId, episodeId, onExit }: { titleId: string; episodeId?: string; onExit(): void }) {
  const [session, setSession] = useState<PlaybackSession | null>(null);
  const [start, setStart] = useState<number | undefined>(undefined);
  const [blocked, setBlocked] = useState<null | { reason: "too-many-screens" | "ended-elsewhere"; detail?: unknown }>(null);
  const [heartbeatSec, setHeartbeatSec] = useState(30);
  const player = useRef<PlayerHandle>(null);

  async function open(body: { titleId: string; episodeId?: string; startPositionSec?: number }) {
    try {
      const next = await api.createPlaybackSession({ body });
      setStart(body.startPositionSec);
      setSession(next);
      setHeartbeatSec(next.heartbeatIntervalSec);
      setBlocked(null);
    } catch (error) {
      if (ApiError.is(error, "stream_limit_reached")) {
        setBlocked({ reason: "too-many-screens", detail: error.problem.activeStreams });
      } else throw error; // subscription_required / maturity_restricted → the route's error UI
    }
  }

  useEffect(() => { void open({ titleId, episodeId }); }, [titleId, episodeId]);

  // Release the stream slot when the watch page goes away.
  useEffect(() => () => {
    if (session) void api.endPlaybackSession({ params: { id: session.id } }, { keepalive: true });
  }, [session?.id]);

  // Progress → heartbeats. `report.sessionId` matters: a report can trail a source swap.
  async function onProgress(report: ProgressReport) {
    const { sessionId, positionSec, durationSec, state, reason } = report;
    try {
      const ack = await api.sendHeartbeat(
        { params: { id: sessionId }, body: { positionSec, durationSec, state } },
        { keepalive: reason === "unload" || reason === "hidden" },
      );
      setHeartbeatSec(ack.heartbeatIntervalSec);
    } catch (error) {
      if (ApiError.is(error, "playback_session_ended")) setBlocked({ reason: "ended-elsewhere" });
    }
  }

  // Expired / revoked media token (403 on a segment): recreate the session where it failed.
  function onError(error: PlayerError) {
    if (error.code === "forbidden" && session) {
      void open({ titleId: session.titleId, episodeId: session.episodeId ?? undefined, startPositionSec: error.positionSec });
    }
  }

  const episodes = useMemo(
    () => session?.display.titleType === "series"
      ? {
          seasons: title.seasons, // from GET /titles/:id (TitleDetail.seasons)
          loadEpisodes: async (seasonNumber: number, signal: AbortSignal) =>
            (await api.listEpisodes({ params: { id: titleId, seasonNumber } }, { signal })).items,
        }
      : null,
    [titleId, session?.display.titleType],
  );

  if (!session) return <FullscreenSpinner />;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Player
        ref={player}
        session={session}
        startPositionSec={start}
        progressIntervalSec={heartbeatSec}
        preferences={{ subtitleLanguage: profile.settings.subtitleLanguage ?? undefined }}
        preferenceStorage={`webflix.player.${profile.id}`}
        synopsis={currentEpisode?.synopsis ?? title.synopsis}
        episodes={episodes}
        onBack={onExit}
        onProgress={onProgress}
        onError={onError}
        onNextEpisode={(next) => void open({ titleId, episodeId: next.episode.id })}
        onSelectEpisode={(episode) => void open({ titleId, episodeId: episode.id })}
        onPreferencesChange={(prefs, changed) => {
          if (changed.includes("subtitleLanguage")) void saveProfileSubtitleLanguage(prefs.subtitleLanguage ?? null);
        }}
        renderEndScreen={({ phase }) => <MoreLikeThis titleId={titleId} compact={phase === "credits"} />}
        blockingOverlay={blocked ? <TooManyScreens info={blocked} onRetry={() => void open({ titleId, episodeId })} onExit={onExit} /> : null}
      />
    </div>
  );
}
```

Notes for the watch page:

- **Size**: the player fills its parent (`width/height: 100%`). Give the parent a size; the watch page is normally `position: fixed; inset: 0`.
- **Session identity**: a new `session.id` (or `manifestUrl`) reloads the source in place. Changing other fields of the same session (e.g. `autoplayNextEpisode`) updates without reloading. Don't `key` the player by episode, or fullscreen is lost on every episode change.
- **"Too many screens"**: `POST /playback/sessions` answers 409 `stream_limit_reached` before any session exists. Render the player only once you have a session, or keep the last one and pass `blockingOverlay`. While `blockingOverlay` is set the player pauses, hides and disables its controls and shortcuts, and keeps focus inside your overlay.
- **Session ended elsewhere**: a heartbeat answering 410 `playback_session_ended` → set `blockingOverlay`.
- **Final heartbeat**: the player sends `reason: "unload"` when it unmounts or swaps sources, and `"hidden"` when the tab is hidden; send those with `keepalive: true`. In development, React StrictMode's mount → unmount → mount also produces one `unload` report at startup.

---

## `<Player>` props

| Prop | Type | Default | |
| --- | --- | --- | --- |
| `session` | `PlayerSession` | — | **Required.** The parts of `PlaybackSession` the player reads; a `PlaybackSession` is assignable as is. |
| `startPositionSec` | `number` | `session.resumePositionSec` | Start here instead (e.g. after recreating an expired session). |
| `autoPlay` | `boolean` | `true` | If the browser refuses (autoplay policy), a large Play button is shown. The player never silently mutes a title. |
| `autoplayNextEpisode` | `boolean` | `session.autoplayNextEpisode` | Override the profile setting, e.g. to stop after N unattended episodes ("Are you still watching?" is a host concern). |
| `nextEpisodeCountdownSec` | `number` | `10` | Length of the next-episode countdown. |
| `synopsis` | `string \| null` | — | Shown in the paused-state overlay ("You're watching…"). The session carries none. |
| `episodes` | `EpisodesSource \| null` | — | Feeds the episodes panel; omit for movies (the button is hidden). |
| `renderEndScreen` | `(ctx: EndScreenContext) => ReactNode` | — | Slot for the last episode / a movie (e.g. "More like this"): the right-hand column beside the shrunken picture (below it in portrait) from the credits marker and after the end. See [End screen](#end-screen). |
| `endScreenBackdrop` | `ImageSet \| null` | — | Still for the shrunken picture's frame once playback has ended (the title's backdrop, or the episode still), cross-faded over the last frame. During the credits the video keeps playing there. Without it the last frame stays. |
| `blockingOverlay` | `ReactNode` | — | Host overlay that blocks playback (see above and [Blocking overlay](#blocking-overlay)). Start it with a heading: the modal dialog takes its accessible name from the first `h1`–`h6` inside. |
| `progressIntervalSec` | `number` | `session.heartbeatIntervalSec ?? 30` | Cadence of `onProgress` `interval` reports. Update it from `HeartbeatAck`. |
| `preferences` | `Partial<PlayerPreferences>` | — | Host values that win over remembered ones (the profile's subtitle language). |
| `preferenceStorage` | `string \| PreferenceStorage \| false` | `"webflix.player.preferences.v1"` | localStorage key (use one per profile), a custom storage, or `false` for none. |
| `labels` | `Partial<PlayerLabels>` | English | Every visible and announced string (see `DEFAULT_LABELS`). |
| `engine` | `"auto" \| "hls.js" \| "native"` | `"auto"` | See [Browser support](#browser-support). |
| `hlsConfig` | `Partial<HlsConfig>` | — | Merged over the player's hls.js configuration. |
| `crossOrigin` | `"anonymous" \| "use-credentials"` | unset | Only for cross-origin media/subtitles. Webflix media is same-origin. |
| `globalShortcuts` | `boolean` | `true` | Shortcuts work wherever focus is on the page (the watch page *is* the player). Typing in inputs is never intercepted; keys aimed at host buttons outside the player are left alone. |
| `autoFocus` | `boolean` | `true` | Focus the player on mount. |
| `className`, `style` | | | On the root element (`.wfp-root`). Theme variables can go in `style`. |
| `ref` | `Ref<PlayerHandle>` | | See below. |

### Callbacks

| Callback | When |
| --- | --- |
| `onProgress(report: ProgressReport)` | Every `progressIntervalSec` while a source is loaded (also while paused, so the stream lease stays alive), plus on `pause`, after a seek settles, at `ended`, when the tab is `hidden` and on `unload` (unmount or source swap). Event reports are throttled to one per 2 s; one that comes too soon is sent when the 2 s are up, with the state of that moment (never dropped: a pause right after a seek still reaches the server), unless `ended` or `unload` supersedes it. `report` = `{ sessionId, positionSec, durationSec, state, reason }` — the first four are exactly `HeartbeatBody` + the session id. |
| `onStateChange(phase)` | `idle \| loading \| playing \| paused \| buffering \| ended \| error`. |
| `onEnded()` | Once per source, at the end. |
| `onNextEpisode(next, reason)` | `reason: "autoplay"` (countdown finished) or `"user"` (Next Episode button, post-play card, Shift+N, media-session "next track"). Called at most once per source. Load `next.episode.id`. |
| `onSelectEpisode(episode)` | An episode picked in the episodes panel (not the current one). |
| `onBack()` | The back arrow (top left) and the Back action of the end screen / error dialog. The arrow is hidden without this prop. |
| `onQualityChange({ selection, active })` | Quality selection (`"auto"` or `{ height }`) or the playing rendition changed. |
| `onError(error: PlayerError)` | Fatal errors only (see [Errors](#errors-and-recovery)). |
| `onFullscreenChange(value)` | Entered / left fullscreen. |
| `onPreferencesChange(prefs, changedKeys)` | The viewer changed volume, mute, subtitle or audio language, or speed. Already persisted to `preferenceStorage`. |

### Imperative handle (`ref`)

```ts
interface PlayerHandle {
  play(): Promise<void>; pause(): void; seek(positionSec: number): void;
  getCurrentTime(): number; getDuration(): number; getPhase(): PlaybackPhase;
  getProgress(reason?: ProgressReason): ProgressReport | null; // e.g. a last keepalive heartbeat on route change
  setVolume(volume: number): void; setMuted(muted: boolean): void;
  enterFullscreen(): Promise<void>; exitFullscreen(): Promise<void>;
  retry(): void;          // reload the current source at the current/failure position
  showControls(): void; focus(): void;
  readonly media: HTMLVideoElement | null; // read-only access for analytics; don't change its source
}
```

### Episodes panel

```ts
interface EpisodesSource {
  seasons: { number: number; name: string; episodeCount: number }[]; // TitleDetail.seasons
  currentEpisodeId?: string | null;   // default: session.display.episode.id
  initialSeasonNumber?: number;       // default: the playing episode's season
  loadEpisodes(seasonNumber: number, signal: AbortSignal): Promise<readonly EpisodeSummary[]>;
}
```

`EpisodeSummary` is a `Pick` of the contract's `Episode`, so `SeasonEpisodes.items` fits directly. Seasons load on demand (skeleton rows meanwhile, an error state with Retry on failure) and are cached per `EpisodesSource` object: memoise it, or every render refetches.

Each row's time uses the shared wording of `@webflix/contracts` (`formatTimeLeft`, `progressFraction`, `formatTimeLeftSpoken` for screen readers), so the panel says the same as browse: a started episode shows what is left ("12m left") over a bar drawn from the same two numbers; an unwatched one shows its runtime (`runtimeSec`, the playable duration); a `completed` one shows its runtime over a full bar (its stored position may stop at the credits, so "time left" would be wrong). The playing episode follows the live position rather than the stored progress.

### End screen

For a movie or the last episode (`session.nextEpisode === null`): at `markers.creditsStartSec` the picture shrinks and the credits keep playing in it; `renderEndScreen({ phase: "credits", watchCredits, replay, back })` fills the slot. After the end, `phase` is `"ended"`, Replay replaces Watch Credits, and `endScreenBackdrop` (if given) cross-fades over the last frame in the same frame. Without a credits marker the end screen waits for the real end. `EndScreenContext` is unchanged: `watchCredits()` returns to full-size credits, then the end screen comes back at the end.

Layout (`.wfp-endscreen`, a container-query layout, so it follows the player's box, not the viewport):

- **Landscape** (wider than tall: desktop, tablet landscape, phone landscape): a left column 30 % of the picture width (`.wfp-endscreen__lead`) holds the picture (`.wfp-endscreen__frame`, 16:9, rounded), then the title, the episode line and the actions (Watch Credits / Replay and Back, full-size pills). The slot (`.wfp-endscreen__slot`) is the right column at full height: about 61 % of the player's width and 90 % of its height (876 × 810 px in a 1440 × 900 player, 1167 × 972 px at 1920 × 1080, 1557 × 1296 px at 2560 × 1440, 558 × 351 px on an 844 × 390 phone).
- **Portrait** (as tall as wide or taller): the picture full width at the top, then title and actions, then the slot with the rest of the height (363 × 413 px on a 390 × 844 phone, 777 × 386 px at 834 × 1112).

The slot scrolls (`overflow: auto`, `overscroll-behavior: contain`) and has 4 px of inner room so focus rings inside it are never clipped; the host renders content only (no positioning, no backgrounds needed). The end screen's actions and the slot are reachable with Tab in DOM order (actions first); the transport, skip and next-episode buttons are hidden meanwhile. Under `prefers-reduced-motion` the picture moves without animating; the backdrop still fades.

When there *is* a next episode: at the credits, two buttons appear bottom-right — **Watch Credits** and **Next Episode** with a countdown ring (autoplay on) or without one (autoplay off). The countdown pauses while the video is paused, a menu or the episodes panel is open, the viewer scrubs, or a blocking overlay is up. Watch Credits hides the card until the end, where a post-play card (still, title, synopsis) appears. Seeking back before the credits re-arms everything. Without a credits marker the card appears 12 s before the end.

### Blocking overlay

`blockingOverlay` renders inside `.wfp-layer--blocking` (an opaque-ish blurred scrim over the whole player) in `.wfp-blocking`, a modal `role="dialog"` that **fills the whole layer**: `width/height: 100%`, no max width, `position: relative; isolation: isolate`. It scrolls itself, centres its children both ways (content taller than the player starts at the top and scrolls; nothing is cut off) and pads them so no focus ring touches an edge. So:

- Size your own content (e.g. `max-width: 560px` on the card); a child with `width: 100%` spans the layer.
- For a full-bleed background (art, a gradient), add a child with `position: absolute; inset: 0; z-index: -1`; it paints behind your content and stays inside the dialog.
- Focus moves to the first focusable element and Tab stays inside; the dialog is named after the first `h1`–`h6` in it.

### Overlay precedence

What may be on screen at once, and who wins. "Hides" means not rendered (so never announced); everything hidden comes back when the winner goes, if it still applies.

| When both apply | Wins | What happens to the other |
| --- | --- | --- |
| Paused overlay ("You're watching…", after 8 s paused and idle) + Skip Intro / Recap | Paused overlay | Skip hidden; any pointer, touch or key activity drops the overlay and the offer returns. |
| Paused overlay + next-episode card | Paused overlay | Card hidden (the countdown is already stopped: it only runs while playing). |
| Next-episode card + skip offer (a skip window inside the credits) | Next-episode card | Skip hidden. |
| Menu or episodes panel + skip offer / next-episode card | Menu / panel | Both hidden; the countdown pauses until it closes. |
| Paused overlay + menu / panel | Menu / panel | The overlay never shows while one is open. |
| Maturity advisory + paused overlay / end screen | Paused overlay / end screen | Advisory hidden. |
| End screen + transport, skip, next-episode card, captions | End screen | All hidden; the end screen has its own actions. |
| Buffering spinner + touch centre controls | Both | The spinner ring wraps the centre play button. |
| Error dialog / host blocking overlay + everything | The layer | Controls hidden and inert; the live region drops earlier announcements. |
| Host banner (e.g. a connection pill fixed at the top centre, ~44 px tall, 16 px from the top) + top bar, advisory, toasts, menus, end screen, layers | Host banner | The player can't see host UI: while the banner shows, set `--wfp-inset-top` (e.g. `76px`) on the player or an ancestor and everything top-anchored moves down by it. Without it the banner covers the stacked title of the touch layout. |

### Preferences

`{ volume, muted, subtitleLanguage?, audioLanguage?, playbackRate }`, resolved as defaults ← stored ← `preferences` prop. `subtitleLanguage: null` means "off" (forced narrative tracks in the audio language still show); `undefined` means "no preference" (the session's `default` track). Storage reads are validated field by field; private mode or blocked storage just means nothing is remembered.

### Errors and recovery

Recoverable problems are handled inside: network failures retry with back-off (1, 2, 4 s), media errors go through `recoverMediaError` and then an audio-codec swap. A playhead that stops with seconds of data buffered ahead (hls.js reports a non-fatal `bufferStalledError`, and nudges only across buffer holes) is nudged forward up to three times (0.1, 0.2, 0.3 s), then the media pipeline is recovered. This was seen in Firefox and WebKit right after the start-gap seek, where it left a frozen first frame. A stall in the last half second ends the stream instead (`BUFFER_EOS` for every track, so hls.js calls `MediaSource.endOfStream()`): after a seek near the end under load, hls.js sometimes never ended the MediaSource and the element waited forever a few frames short of the end, with a spinner where the end screen belongs. Only after all of that does `onError` fire and the error dialog (with **Try Again**, which calls `retry()`) appear. The position a `PlayerError` reports is the element's playhead at the moment of failure, not the last `timeupdate`:

| `error.code` | Meaning | Host action |
| --- | --- | --- |
| `forbidden` | 401/403 from the media origin: the signed token expired or was revoked. Surfaced immediately. | Recreate the session with `startPositionSec: error.positionSec`. |
| `network` | Still failing after retries (or offline; the player retries by itself when the browser comes back online). | Usually nothing; the dialog offers Try Again. |
| `not_found` | 404/410 for the manifest. | Show an unavailable state. |
| `media` / `unsupported` | Undecodable content / no playback path in this browser. | Report. |
| `unknown` | Anything else. | Report. |

`PlayerError` = `{ code, detail, httpStatus, positionSec, fatal: true }`. The dialog shows a short code such as `WFP-FORBIDDEN-403` for support.

---

## Keyboard, pointer and touch

| Key | Action |
| --- | --- |
| Space, K | Play / pause |
| ← / J, → / L | Back / forward 10 s (hold to repeat) |
| ↑ / ↓ | Volume ±10 % |
| M | Mute |
| F | Fullscreen |
| C | Subtitles on / off (last used language) |
| Esc | Close menu or panel, else leave fullscreen |
| 0 … 9 | Jump to 0 % … 90 % |
| Home / End | Start / end |
| S | Skip Intro / Skip Recap while offered |
| Shift + N | Next episode |
| Shift + . / Shift + , | Faster / slower (0.5× … 1.5×) |
| P | Picture-in-picture |
| Shift + D | Playback stats (engine, the rendition actually playing with its size and bitrate, buffer ahead, dropped frames, viewport); press again to close |

Every shortcut shows feedback (pulse, ±10 s, volume meter, toast) and is announced to screen readers. Inside menus the arrows move between items instead. A focused control keeps Space/Enter while the viewer navigates by keyboard; after a mouse click focus returns to the player, so Space never re-presses the last button.

Pointer: click the picture to play/pause, double-click for fullscreen; controls hide after 3 s idle (never while a menu is open, the pointer rests on the controls, or a control has keyboard focus), and when the pointer leaves the player. Touch (or any player narrower than 640 px): tap toggles the controls, double-tap the left/right third seeks ∓10 s and further taps extend it (−20 s, −30 s…); transport buttons move to the centre and menus become bottom sheets.

---

## Theming

All styling reads `--wfp-*` custom properties, falling back to the defaults below. Set them on any ancestor (e.g. the watch page or `:root`) or through `style`. The web app maps its design tokens once (`apps/web/src/features/watch/playerTheme.ts`; it leaves durations at the player's defaults), for example:

```css
.watch-page {
  --wfp-font-family: var(--font-sans);
  --wfp-accent: var(--color-accent);
  --wfp-surface: var(--color-surface-2);
  --wfp-radius-md: var(--radius-md);
  --wfp-ease: var(--ease-standard);
}
```

| Variable | Default | Used for |
| --- | --- | --- |
| `--wfp-font-family` | `system-ui, …` | All player text. |
| `--wfp-accent` | `#ff2d55` | Played range, scrubber thumb, spinner, "Now playing", advisory bar. |
| `--wfp-text` / `--wfp-text-muted` / `--wfp-text-dim` | `#fff` / `rgb(255 255 255 / .72)` / `/ .5` | Text levels. |
| `--wfp-surface` | `rgb(24 24 26)` | Menus, sheets, episodes panel, tooltips, hover cards (keep it opaque: captions sit beneath). |
| `--wfp-surface-raised` | `rgb(255 255 255 / .08)` | Hover / focus rows. |
| `--wfp-border` | `rgb(255 255 255 / .12)` | Hairlines in menus and panels. |
| `--wfp-scrim` | `0 0 0` | RGB triplet for the top/bottom gradients and overlays. |
| `--wfp-backdrop` | `#000` | Behind the picture (letterbox). |
| `--wfp-focus-ring` | `#fff` | Focus outlines. |
| `--wfp-track` / `--wfp-buffered` | `rgb(255 255 255 / .26)` / `/ .5` | Scrubber and volume tracks. |
| `--wfp-radius-sm` / `-md` / `-lg` | `4px` / `8px` / `12px` | Corners. |
| `--wfp-duration-fast` / `-base` / `-slow` | `140ms` / `240ms` / `480ms` | Transitions (only opacity and transform animate). |
| `--wfp-ease` / `--wfp-ease-out` | `cubic-bezier(.2,0,0,1)` / `cubic-bezier(.16,1,.3,1)` | Easing. |
| `--wfp-control-scale` | `1` | Multiplies control sizes (TV / 10-ft UI). Sizes already grow with the player up to 2560 px wide. |
| `--wfp-inset-top` | `0px` | Space a host keeps clear at the top while it shows something there (a connection banner): the top bar, advisory, toasts, menus' and panel's maximum height, the end screen and the layers move down by it. |
| `--wfp-caption-font-family` | the player font | Captions. |
| `--wfp-caption-scale` | `1` | Caption size multiplier (base ≈ 5.4 % of the picture height, 15–60 px). |
| `--wfp-caption-color` / `--wfp-caption-background` | `#fff` / `transparent` | Caption text and box (e.g. `rgb(0 0 0 / .75)` for a boxed style). |
| `--wfp-caption-font-weight` / `--wfp-caption-shadow` | `600` / layered dark shadow | Caption legibility on bright frames. |
| `--wfp-advisory-accent` | `--wfp-accent` | Maturity advisory bar. |
| `--wfp-preview-backdrop`, `--wfp-preview-fade`, `--wfp-preview-mute-size`, `--wfp-preview-mute-inset` | `transparent`, `600ms`, `44px`, `16px` | `<PreviewPlayer>`. |

`--wfp-video-aspect` is set by the player itself from the stream (it positions captions on the picture rather than the letterbox); don't set it. Internal `--_*` properties are not API. Styles are unlayered, single-class selectors, so element resets such as Tailwind's preflight never override them regardless of load order. The CSS is imported by the components; `@webflix/player/styles.css` and `@webflix/player/preview.css` are also exported if you need to control ordering.

---

## `<PreviewPlayer>`

```tsx
<PreviewPlayer
  src={card.preview.url}            // progressive MP4 (PreviewClip) or an HLS .m3u8
  poster={backdropUrl}              // shown until the first frame and again after the clip ends
  active={hoverIntent}              // host intent; playback also requires ≥ 50 % visibility and a visible tab
  muted={muted} onMutedChange={setMuted} showMuteToggle
  onFirstFrame={() => setSynopsisCollapsed(true)}
  onEnded={() => setSynopsisCollapsed(false)}
>
  <TitleTreatment />                {/* optional overlay content */}
</PreviewPlayer>
```

| Prop | Default | |
| --- | --- | --- |
| `src` | — | Required. Changing it swaps the clip (old decoder released). |
| `poster` | — | Image under the video. |
| `active` | `true` | Pause (and keep the last frame) when false. |
| `muted` / `onMutedChange` | uncontrolled, starts muted | If an unmuted resume is refused by autoplay policy it falls back to muted and reports `true`. |
| `loop` | `false` | |
| `startPositionSec` | `0` | |
| `visibilityThreshold` | `0.5` | IntersectionObserver ratio needed to play. |
| `respectReducedMotion` | `true` | No autoplay under `prefers-reduced-motion: reduce` (poster stays). |
| `maxVideoHeight` | `720` | HLS rendition cap. |
| `showMuteToggle`, `muteLabel`, `unmuteLabel` | `false`, "Mute", "Unmute" | Round toggle bottom-right. |
| `fit` | `"cover"` | Or `"contain"`. |
| `onFirstFrame`, `onEnded`, `onError` | | `onError` gets `{ code, detail, httpStatus }`; the poster stays. |
| `ref` | | `{ play(), pause(), restart(), media }` |

The video fades in on its first presented frame (`requestVideoFrameCallback` where available) and fades back to the poster at the end. No keyboard shortcuts, no progress reports, no PiP, no remote playback. Unmount releases everything.

---

## Accessibility

- The root is a labelled region (`"Kestrel Bay, S1:E1 The Harbour Lights"`); every control has an accessible name (including the touch layout, where visible labels are dropped on phones); the scrubber and volume are sliders with spoken value text ("12 minutes 3 seconds of 45 minutes").
- Menus follow the ARIA menu pattern (`menuitemradio`, arrows, Esc returns focus to the trigger). The episodes panel is a labelled dialog that takes focus and gives it back. The error layer is an `alertdialog` focusing Try Again. The host overlay is modal with focus held inside.
- A polite live region announces play/pause (from shortcuts), seeks, volume, subtitle/audio/speed/quality changes, "Skip Intro available. Press S." and the next-episode countdown. A skip offer is announced once, and only while it is on screen (not under the paused overlay or a menu). Announcements leave the region after 7 s, and the end screen, the error dialog and a blocking overlay clear whatever was said before them, so nothing stale can be found later.
- With a single audio track there is no audio choice: the menu and its button are just "Subtitles".
- Focus is always visible (`:focus-visible`), and controls never hide while a control has keyboard focus.
- `prefers-reduced-motion`: nothing slides, scales or shrinks; state changes still fade. Previews don't autoplay.
- Captions are rendered by the player (one style everywhere), sit on the picture, rise above the controls when they show, and use a layered shadow that stays legible on near-white frames. In iPhone system fullscreen the selected track is handed to the system renderer.

---

## Browser support

- **Engine choice (`engine="auto"`)**: hls.js wherever MSE or ManagedMediaSource exists (Chrome, Edge, Firefox, desktop Safari, iPadOS, iOS 17.1+); native HLS where it doesn't (older iOS). `canPlayType` alone can't decide: current desktop Chrome answers "maybe" for HLS too. hls.js is preferred because it is the only path that enforces `maxVideoHeight`, offers the quality menu and recovers from errors.
- **Native path caveats**: no quality menu, and **the plan's `maxVideoHeight` cannot be enforced client-side** — the server should also filter the master playlist per plan. Audio tracks use Safari's `audioTracks`.
- **Quality names** use the contract's shared vocabulary, so the player, cards, details and the Account plan labels agree. The quality menu offers classes only: Auto, then 4K / Full HD / HD / SD, best first, never a bitrate or a pixel height. Renditions of the same class (judged on the nominal 16:9 height, so 1280×536 is HD) collapse into one choice, played by the class's best rendition (tallest, then highest bitrate); nothing above the plan's class is offered, and the menu is hidden when one class is all there is. Auto carries the class playing now as its detail (Auto … HD). When `session.bestVideoQuality` is below the plan's class (a 4K plan on a Full HD title), the menu says once "Best available for this title: Full HD" (`labels.qualityTitleLimit`), as the menu's description. `qualityBadge(level)` names one rendition, and `sessionQualityLabel(session)` the whole session (the lower of `session.bestVideoQuality` and the plan's `maxVideoHeight`; none for external media). The exact rendition is in the stats overlay (Shift + D).
- **Plan cap on hls.js**: renditions taller than `maxVideoHeight` are removed before the first fragment loads (`autoStartLoad: false` + `removeLevel`), so ABR and manual selection never see them. ABR is also capped to the player size until fullscreen.
- **iPhone**: element fullscreen isn't available; the Fullscreen button uses the system player (`webkitEnterFullscreen`), where our captions are replaced by the system's rendering of the same track and our overlays (skip, countdown) are not visible.
- **Picture-in-picture**: standard API (Chromium, Safari 13.1+ via the WebKit presentation mode); the button is hidden where unsupported (Firefox).
- **Media Session**: lock-screen / hardware keys (play, pause, ±10 s, seek, next episode) where supported.
- Verified for real in Chromium (Playwright) and Google Chrome; the end-to-end suite also plays titles in Playwright's Firefox and WebKit, including WebKit's native HLS path (`e2e/README.md`). Real Safari and real iOS/Android devices were not available in this environment.

---

## Development

```sh
pnpm --filter @webflix/player media        # generate test media (ffmpeg in Docker) → .cache/test-media (git-ignored, ~70 MB, ~40 s)
pnpm --filter @webflix/player playground   # http://localhost:4300
pnpm --filter @webflix/player verify       # Playwright: desktop + Pixel 7 portrait/landscape → .cache/screenshots/
pnpm --filter @webflix/player test         # unit + component tests (Vitest, jsdom)
pnpm --filter @webflix/player lint
pnpm --filter @webflix/player typecheck
```

**Test media** (`scripts/generate-test-media.ts`) is fully synthetic and deterministic: two "episodes" (150 s and 90 s) built from lavfi gradients, fractals and DejaVu typography, with a burned-in timecode and rendition label; fMP4/CMAF HLS with a 1080p/720p/480p/360p ladder (4 s segments, 2 s GOP) and two alternate audio groups (English/Español, different tones so a switch is audible); two side-car WebVTT tracks (with italics, a two-line cue, a `line:0` cue, a long wrapping cue); trick-play sprite sheets matching the `TrickPlay` DTO (2 s tiles, 240×135, 5×5 per sheet); recap/intro/credits markers; a faststart preview MP4 and episode stills. The layout mirrors the blob layout (`vod/{assetId}/…`, `public/previews/…`, `public/img/episodes/…`). The ffmpeg image is pinned by digest (override with `WEBFLIX_PLAYER_FFMPEG_IMAGE`); containers are named `webflix-player-ffmpeg-*` and removed on exit. Output is skipped when up to date; `--force` regenerates.

**Playground** (`playground/`): the host app — it builds `PlaybackSession`s from the generated media and plays the watch page's role (swaps episodes in place, recreates expired sessions, renders the end-screen slot and a "too many screens" overlay). Its dev server serves `/media/{token}/vod/…` and `/cdn/…` like production; the token `expired` answers 403. URL parameters reach every state: `?scenario=episode|last-episode|movie|capped|expired|external&start=&autoplay=0&autoplayNext=0&countdown=&progress=&blocked=1&theme=alt&ui=0`, `&best=sd|hd|full-hd|4k&cap=<height>` for the title's best quality and the plan cap, and `?page=preview` for the preview players. The end screen uses the first episode's still as its `endScreenBackdrop`. `scenario=external` plays a public test stream (network needed); everything else is local.
