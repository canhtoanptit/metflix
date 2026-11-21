/**
 * The playground host: plays the role of the watch page (creates sessions, handles callbacks,
 * swaps episodes in place) and of the browse page (preview players). URL parameters make every
 * state reachable for the browser checks:
 *
 *   ?scenario=episode|last-episode|movie|capped|expired|external
 *   &start=<sec>  &autoplay=0  &autoplayNext=0  &blocked=1  &theme=alt  &ui=0  &page=preview
 *   &countdown=<sec>  &engine=auto|hls.js|native  &progress=<sec>
 */
import type { PlaybackSession } from "@webflix/contracts";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type EnginePreference,
  Player,
  type PlayerHandle,
  type PlayerPreferences,
  PreviewPlayer,
} from "../src/index.ts";
import {
  buildSession,
  episodesSource,
  SCENARIOS,
  type ScenarioId,
  sessionForEpisode,
  type TestAsset,
} from "./scenarios.ts";

interface LoggedEvent {
  at: number;
  name: string;
  detail: unknown;
}

declare global {
  interface Window {
    __pg?: {
      events: LoggedEvent[];
      handle: () => PlayerHandle | null;
      setBlocked: (value: boolean) => void;
      setMounted: (value: boolean) => void;
      session: () => PlaybackSession | null;
    };
  }
}

const params = new URLSearchParams(location.search);
const flag = (name: string, fallback: boolean) => {
  const value = params.get(name);
  return value === null ? fallback : value !== "0" && value !== "false";
};

function useAssets(): TestAsset[] | null | "missing" {
  const [assets, setAssets] = useState<TestAsset[] | null | "missing">(null);
  useEffect(() => {
    fetch("/test-media/assets.json")
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((data: { assets: TestAsset[] }) => setAssets(data.assets))
      .catch(() => setAssets("missing"));
  }, []);
  return assets;
}

export function App() {
  const assets = useAssets();
  if (assets === null) return <div className="pg-message">Loading test media…</div>;
  if (assets === "missing") {
    return (
      <div className="pg-message">
        Test media not found. Run <code>pnpm --filter @webflix/player media</code> and reload.
      </div>
    );
  }
  return params.get("page") === "preview" ? (
    <PreviewPage assets={assets} />
  ) : (
    <WatchPage assets={assets} />
  );
}

function WatchPage({ assets }: { assets: TestAsset[] }) {
  const showUi = flag("ui", true);
  const [scenario, setScenario] = useState<ScenarioId>(
    (params.get("scenario") as ScenarioId) ?? "episode",
  );
  const [autoplayNext, setAutoplayNext] = useState(flag("autoplayNext", true));
  const [session, setSession] = useState<PlaybackSession>(() =>
    buildSession(scenario, assets, { autoplayNext }),
  );
  const [startPositionSec, setStartPositionSec] = useState<number | undefined>(
    params.get("start") ? Number(params.get("start")) : undefined,
  );
  const [blocked, setBlocked] = useState(flag("blocked", false));
  const [mounted, setMounted] = useState(true);
  const [altTheme, setAltTheme] = useState(params.get("theme") === "alt");
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const eventsRef = useRef<LoggedEvent[]>([]);
  const handleRef = useRef<PlayerHandle | null>(null);
  const episodes = useMemo(
    () =>
      session.display.titleType === "series" && scenario !== "external"
        ? episodesSource(assets)
        : null,
    [assets, session.display.titleType, scenario],
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const log = useCallback((name: string, detail: unknown = null) => {
    const entry = { at: Math.round(performance.now()), name, detail };
    eventsRef.current = [...eventsRef.current, entry].slice(-400);
    setEvents((current) => [...current.slice(-59), entry]);
  }, []);

  useEffect(() => {
    window.__pg = {
      get events() {
        return eventsRef.current;
      },
      handle: () => handleRef.current,
      setBlocked,
      setMounted,
      session: () => sessionRef.current,
    };
  }, []);

  const switchScenario = (next: ScenarioId) => {
    setScenario(next);
    setStartPositionSec(undefined);
    setSession(buildSession(next, assets, { autoplayNext, sessionSuffix: `-${Date.now()}` }));
    log("host:scenario", next);
  };

  const goToEpisode = (episodeId: string, reason: string) => {
    const next = sessionForEpisode(episodeId, assets, {
      autoplayNext,
      sessionSuffix: `-${Date.now()}`,
    });
    if (!next) return;
    setStartPositionSec(undefined);
    setSession(next);
    setScenario(next.nextEpisode ? "episode" : "last-episode");
    log("host:load-episode", { episodeId, reason });
  };

  const style = altTheme
    ? ({
        "--wfp-accent": "#2dd4bf",
        "--wfp-font-family": "Georgia, 'Times New Roman', serif",
        "--wfp-surface": "rgb(12 24 28 / 0.97)",
        "--wfp-radius-md": "14px",
      } as CSSProperties)
    : undefined;

  return (
    <div className="pg" data-ui={showUi ? "" : undefined}>
      <main className="pg-stage">
        {mounted ? (
          <Player
            ref={handleRef}
            session={session}
            startPositionSec={startPositionSec}
            autoPlay={flag("autoplay", true)}
            autoplayNextEpisode={autoplayNext}
            nextEpisodeCountdownSec={
              params.get("countdown") ? Number(params.get("countdown")) : undefined
            }
            progressIntervalSec={
              params.get("progress") ? Number(params.get("progress")) : undefined
            }
            engine={(params.get("engine") as EnginePreference) ?? "auto"}
            synopsis={
              session.display.episode?.id === "kestrel-s1e1"
                ? "The night the harbour lights fail, a fisherman's daughter finds a ledger that should have gone down with the boat."
                : session.display.titleType === "movie"
                  ? "A bookkeeper inherits a ledger listing every secret in a fishing town, including her own."
                  : "Every page is a name. Mara works out whose — and why one of them is hers."
            }
            episodes={episodes}
            preferenceStorage="webflix.player.playground"
            style={style}
            onBack={() => log("host:back")}
            onProgress={(report) => log("progress", report)}
            onStateChange={(phase) => log("state", phase)}
            onEnded={() => log("ended")}
            onNextEpisode={(next, reason) => {
              log("next-episode", { id: next.episode.id, reason });
              goToEpisode(next.episode.id, reason);
            }}
            onSelectEpisode={(episode) => {
              log("select-episode", episode.id);
              goToEpisode(episode.id, "select");
            }}
            onQualityChange={(change) => log("quality", change)}
            onError={(error) => {
              log("error", error);
              if (error.code === "forbidden") {
                // What the watch page does: create a new session at the failure position.
                setTimeout(() => {
                  log("host:recreate-session", error.positionSec);
                  setStartPositionSec(error.positionSec);
                  setSession(
                    buildSession("episode", assets, {
                      autoplayNext,
                      sessionSuffix: `-renewed-${Date.now()}`,
                    }),
                  );
                }, 2500);
              }
            }}
            onFullscreenChange={(value) => log("fullscreen", value)}
            onPreferencesChange={(prefs: PlayerPreferences, changed) =>
              log("preferences", { prefs, changed })
            }
            renderEndScreen={({ phase }) => <Recommendations phase={phase} />}
            blockingOverlay={
              blocked ? <TooManyScreens onDismiss={() => setBlocked(false)} /> : null
            }
          />
        ) : (
          <div className="pg-message">Player unmounted.</div>
        )}
      </main>
      {showUi ? (
        <aside className="pg-panel">
          <h1>Player playground</h1>
          <section>
            <h2>Scenario</h2>
            <div className="pg-scenarios">
              {SCENARIOS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={scenario === item.id}
                  onClick={() => switchScenario(item.id)}
                  title={item.note}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2>Host</h2>
            <label>
              <input
                type="checkbox"
                checked={autoplayNext}
                onChange={(event) => setAutoplayNext(event.target.checked)}
              />{" "}
              Autoplay next episode
            </label>
            <label>
              <input
                type="checkbox"
                checked={blocked}
                onChange={(event) => setBlocked(event.target.checked)}
              />{" "}
              Blocking overlay (too many screens)
            </label>
            <label>
              <input
                type="checkbox"
                checked={altTheme}
                onChange={(event) => setAltTheme(event.target.checked)}
              />{" "}
              Alternate theme
            </label>
            <label>
              <input
                type="checkbox"
                checked={mounted}
                onChange={(event) => setMounted(event.target.checked)}
              />{" "}
              Mounted
            </label>
          </section>
          <section>
            <h2>Jump</h2>
            <div className="pg-actions">
              <button type="button" onClick={() => handleRef.current?.seek(3)}>
                Recap
              </button>
              <button type="button" onClick={() => handleRef.current?.seek(22)}>
                Intro
              </button>
              <button type="button" onClick={() => handleRef.current?.seek(58)}>
                Bright
              </button>
              <button type="button" onClick={() => handleRef.current?.seek(95)}>
                Dark
              </button>
              <button
                type="button"
                onClick={() =>
                  handleRef.current?.seek(
                    (session.markers.creditsStartSec ?? session.durationSec - 12) - 2,
                  )
                }
              >
                Credits
              </button>
            </div>
          </section>
          <section className="pg-log">
            <h2>Events</h2>
            <ol>
              {events
                .slice()
                .reverse()
                .map((event) => (
                  <li key={`${event.at}-${event.name}`}>
                    <span>{(event.at / 1000).toFixed(1)}s</span> <b>{event.name}</b>{" "}
                    {event.detail === null ? null : <code>{JSON.stringify(event.detail)}</code>}
                  </li>
                ))}
            </ol>
          </section>
        </aside>
      ) : null}
    </div>
  );
}

const RECOMMENDATIONS = [
  { title: "Low Tide", meta: "Series · 16+", colors: ["#0f3b4a", "#3e8ea7"] },
  { title: "The Keeper", meta: "Movie · 13+", colors: ["#4a1d0f", "#c46a2d"] },
  { title: "Saltmarsh", meta: "Series · 16+", colors: ["#1e1b4b", "#6d5bd0"] },
  { title: "North Light", meta: "Movie · 7+", colors: ["#123b22", "#4fa36b"] },
];

function Recommendations({ phase }: { phase: "credits" | "ended" }) {
  return (
    <div className="pg-recs" data-phase={phase}>
      <h3>More Like This</h3>
      <ul>
        {RECOMMENDATIONS.map((rec) => (
          <li key={rec.title}>
            <button
              type="button"
              style={{ background: `linear-gradient(135deg, ${rec.colors[0]}, ${rec.colors[1]})` }}
            >
              <span className="pg-recs__title">{rec.title}</span>
              <span className="pg-recs__meta">{rec.meta}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TooManyScreens({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="pg-blocking">
      <h2>Playback stopped</h2>
      <p>
        Your Webflix account is being used on too many screens right now. Your Standard plan streams
        on 2 screens at a time.
      </p>
      <ul>
        <li>
          <b>Living room TV</b> · Kestrel Bay · started 12 min ago
        </li>
        <li>
          <b>iPhone</b> · The Ledger · started 3 min ago
        </li>
      </ul>
      <div className="pg-blocking__actions">
        <button type="button" className="pg-primary" onClick={onDismiss}>
          Try Again
        </button>
        <button type="button" onClick={onDismiss}>
          Manage Devices
        </button>
      </div>
    </div>
  );
}

function PreviewPage({ assets }: { assets: TestAsset[] }) {
  const [muted, setMuted] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const push = (line: string) => setLog((current) => [...current.slice(-12), line]);
  const billboard = assets[0];
  const cards = [assets[1], assets[0], assets[1], assets[0]];
  if (!billboard) return null;
  return (
    <div className="pv">
      <section className="pv-billboard">
        <PreviewPlayer
          src={`/cdn/${billboard.preview.replace(/^public\//, "")}`}
          poster={`/cdn/img/episodes/${billboard.assetId}/still-640.webp`}
          muted={muted}
          onMutedChange={setMuted}
          showMuteToggle
          onFirstFrame={() => push("billboard: first frame")}
          onEnded={() => push("billboard: ended")}
        >
          <div className="pv-billboard__copy">
            <h1>Kestrel Bay</h1>
            <p>
              The night the harbour lights fail, a fisherman's daughter finds a ledger that should
              have gone down with the boat.
            </p>
          </div>
        </PreviewPlayer>
      </section>
      <section className="pv-row">
        <h2>Hover cards (HLS previews)</h2>
        <div className="pv-cards">
          {cards.map((asset, index) =>
            asset ? (
              <div
                key={index}
                className="pv-card"
                data-hovered={hovered === index ? "" : undefined}
                onPointerEnter={() => setHovered(index)}
                onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
              >
                <PreviewPlayer
                  src={`/media/pg-token/${asset.master}`}
                  poster={`/cdn/img/episodes/${asset.assetId}/still-320.webp`}
                  active={hovered === index}
                  startPositionSec={20}
                  maxVideoHeight={480}
                  onFirstFrame={() => push(`card ${index}: first frame`)}
                />
              </div>
            ) : null,
          )}
        </div>
      </section>
      <ol className="pv-log">
        {log.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
      <div style={{ height: "120vh" }} />
    </div>
  );
}
