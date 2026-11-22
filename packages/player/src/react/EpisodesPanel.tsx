/**
 * Episodes panel: season picker and episode list, fed lazily by the host's
 * `episodes.loadEpisodes(season, signal)`. Results are cached per source object, so reopening
 * the panel or switching back to a season does not refetch.
 */
import {
  formatTimeLeft,
  formatTimeLeftSpoken,
  imageUrl,
  type PlaybackPoint,
  pickImageWidth,
  progressFraction,
  timeLeftSec,
} from "@webflix/contracts";
import { useEffect, useRef, useState } from "react";
import { formatRuntime, formatSpokenDuration } from "../core/format.ts";
import type { EpisodeSummary, EpisodesSource } from "../types.ts";
import { usePlayer, usePlayerState } from "./context.ts";
import { Icon } from "./icons.tsx";

type SeasonState =
  | { status: "loading" }
  | { status: "ready"; items: readonly EpisodeSummary[] }
  | { status: "error" };

const caches = new WeakMap<EpisodesSource, Map<number, readonly EpisodeSummary[]>>();

interface EpisodeTime {
  text: string;
  spoken: string;
  /** Bar fill, 0–1 (0: no bar). */
  fraction: number;
}

function timeLeft(point: PlaybackPoint): EpisodeTime {
  return {
    text: formatTimeLeft(point),
    spoken: formatTimeLeftSpoken(point),
    fraction: progressFraction(point),
  };
}

/** Re-render the live row when its words change or its bar moves visibly, not at 4 Hz. */
function sameTime(a: EpisodeTime | null, b: EpisodeTime | null): boolean {
  if (a === null || b === null) return a === b;
  return a.text === b.text && Math.abs(a.fraction - b.fraction) < 0.005;
}

/**
 * Started episodes say what is left, with a bar from the same numbers, and completed ones
 * "Finished" under a full bar (the shared wording of `@webflix/contracts`); unwatched ones say
 * their runtime. The playing episode uses the live position, the others the host's progress.
 */
function episodeTime(episode: EpisodeSummary, live: EpisodeTime | null): EpisodeTime {
  if (live) return live;
  const progress = episode.progress;
  const runtime = {
    text: formatRuntime(episode.runtimeSec),
    spoken: formatSpokenDuration(
      episode.runtimeSec >= 60 ? Math.round(episode.runtimeSec / 60) * 60 : episode.runtimeSec,
    ),
  };
  if (progress?.completed) return timeLeft(progress);
  if (progress && progress.positionSec > 0 && timeLeftSec(progress) > 0) return timeLeft(progress);
  return { ...runtime, fraction: 0 };
}

function cacheFor(source: EpisodesSource): Map<number, readonly EpisodeSummary[]> {
  let cache = caches.get(source);
  if (!cache) {
    cache = new Map();
    caches.set(source, cache);
  }
  return cache;
}

export function EpisodesPanel() {
  const { controller, labels, session, episodes, selectEpisode, rootRef } = usePlayer();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const currentId = episodes?.currentEpisodeId ?? session.display.episode?.id ?? null;
  const [season, setSeason] = useState(
    () =>
      episodes?.initialSeasonNumber ??
      session.display.episode?.seasonNumber ??
      episodes?.seasons[0]?.number ??
      1,
  );
  const [state, setState] = useState<SeasonState>(() => {
    const cached = episodes ? cacheFor(episodes).get(season) : undefined;
    return cached ? { status: "ready", items: cached } : { status: "loading" };
  });
  const [attempt, setAttempt] = useState(0);
  // The playing episode's position as the progress reports carry it (same two numbers).
  const live = usePlayerState((s) => {
    const durationSec = s.duration || (s.source?.durationHint ?? 0);
    return durationSec > 0 ? timeLeft({ positionSec: s.currentTime, durationSec }) : null;
  }, sameTime);

  useEffect(() => {
    if (!episodes) return;
    const cache = cacheFor(episodes);
    const cached = cache.get(season);
    if (cached) {
      setState({ status: "ready", items: cached });
      return;
    }
    setState({ status: "loading" });
    const abort = new AbortController();
    episodes.loadEpisodes(season, abort.signal).then(
      (items) => {
        if (abort.signal.aborted) return;
        cache.set(season, items);
        setState({ status: "ready", items });
      },
      () => {
        if (!abort.signal.aborted) setState({ status: "error" });
      },
    );
    return () => abort.abort();
  }, [episodes, season, attempt]);

  // Focus the playing episode (or the season picker) when the panel opens; give focus back to
  // the player when it closes from inside.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel.contains(target) || target.closest?.("[aria-controls='wfp-episodes']")) return;
      controller.openPanel(null);
    };
    const doc = panel.ownerDocument;
    doc.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      if (panel.contains(doc.activeElement)) rootRef.current?.focus({ preventScroll: true });
    };
  }, [controller, rootRef]);

  const focused = useRef(false);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || focused.current || state.status === "loading") return;
    focused.current = true;
    const current = panel.querySelector<HTMLElement>("[aria-current='true']");
    (current ?? panel.querySelector<HTMLElement>("select, button"))?.focus({ preventScroll: true });
    current?.scrollIntoView?.({ block: "nearest" });
  }, [state.status]);

  if (!episodes) return null;
  const multipleSeasons = episodes.seasons.length > 1;
  const seasonInfo = episodes.seasons.find((s) => s.number === season);

  return (
    <div
      ref={panelRef}
      id="wfp-episodes"
      className="wfp-episodes"
      role="dialog"
      aria-label={labels.episodes}
    >
      <div className="wfp-episodes__header">
        {multipleSeasons ? (
          <label className="wfp-episodes__season">
            <span className="wfp-sr-only">{labels.season}</span>
            <select value={season} onChange={(event) => setSeason(Number(event.target.value))}>
              {episodes.seasons.map((s) => (
                <option key={s.number} value={s.number}>
                  {labels.seasonOption(s.number, s.name)}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" />
          </label>
        ) : (
          <h2 className="wfp-episodes__heading">
            {labels.seasonOption(season, seasonInfo?.name ?? "")}
          </h2>
        )}
        <button
          type="button"
          className="wfp-btn wfp-btn--plain"
          aria-label={labels.close}
          onClick={() => controller.openPanel(null)}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="wfp-episodes__body">
        {state.status === "loading" ? (
          <ul className="wfp-episodes__list" aria-busy="true" aria-label={labels.episodesLoading}>
            {Array.from({ length: Math.min(4, seasonInfo?.episodeCount ?? 4) }, (_, i) => (
              <li key={i} className="wfp-episode wfp-episode--skeleton" aria-hidden="true">
                <span className="wfp-episode__number" />
                <span className="wfp-episode__still" />
                <span className="wfp-episode__body">
                  <span className="wfp-skeleton-line" />
                  <span className="wfp-skeleton-line wfp-skeleton-line--short" />
                </span>
              </li>
            ))}
          </ul>
        ) : state.status === "error" ? (
          <div className="wfp-episodes__error" role="alert">
            <p>{labels.episodesError}</p>
            <button type="button" className="wfp-pill" onClick={() => setAttempt((n) => n + 1)}>
              {labels.retry}
            </button>
          </div>
        ) : (
          <ul className="wfp-episodes__list">
            {state.items.map((episode) => {
              const current = episode.id === currentId;
              const time = episodeTime(episode, current ? live : null);
              const still = episode.still;
              return (
                <li key={episode.id}>
                  <button
                    type="button"
                    className="wfp-episode"
                    aria-current={current ? "true" : undefined}
                    disabled={!episode.isPlayable}
                    onClick={() => {
                      controller.openPanel(null);
                      if (!current) selectEpisode(episode);
                    }}
                  >
                    <span className="wfp-episode__number">{episode.number}</span>
                    <span
                      className="wfp-episode__still"
                      style={still ? { backgroundColor: still.dominantColor } : undefined}
                    >
                      {still ? (
                        <img
                          src={imageUrl(
                            still,
                            pickImageWidth(still, 160, 2),
                            still.formats[0] ?? "webp",
                          )}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                      ) : null}
                      {time.fraction > 0 ? (
                        <span className="wfp-episode__progress">
                          <span style={{ transform: `scaleX(${time.fraction})` }} />
                        </span>
                      ) : null}
                    </span>
                    <span className="wfp-episode__body">
                      <span className="wfp-episode__head">
                        <span className="wfp-episode__name">{episode.name}</span>
                        <span className="wfp-episode__runtime">
                          <span aria-hidden="true">{time.text}</span>
                          <span className="wfp-sr-only">{time.spoken}</span>
                        </span>
                      </span>
                      {current ? (
                        <span className="wfp-episode__badge">{labels.nowPlaying}</span>
                      ) : null}
                      <span className="wfp-episode__synopsis">{episode.synopsis}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
