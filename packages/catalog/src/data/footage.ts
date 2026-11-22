/**
 * Footage rules: which clip may stand for which title.
 *
 * A preview or billboard clip must never contradict the title it sits under. So each title's
 * preview comes from, in order:
 *   a. own      a real open film under its own name: its own footage;
 *   b. curated  a hand-reviewed excerpt of an open film that a member would believe is a clip
 *               of this title (same medium, plausible genre and tone, no burned-in text);
 *   c. art      a motion-art clip rendered by tools/media from the title's own key art (slow
 *               push, light and grain, no text). Never unrelated footage.
 *
 * Feature and episode playback of fictional titles necessarily borrows the open films; it is
 * cut from their text-free story only (no studio cards, title cards or credit rolls) and
 * matched by medium and genre as far as the small pool allows.
 */
import type { Medium, OpenFilm, Span } from "./open-film-types.ts";

/** Chapters after the first open with this much of the previous chapter (a real recap). */
export const RECAP_SEC = 20;

/**
 * Safety margin kept on both sides of every measured text span (and screen-text span, for
 * art): a cut, chapter, excerpt or art frame never comes closer than this to a card, so a
 * fade the measurement under-read, or a decoder landing a frame early, still shows no text.
 */
export const TEXT_MARGIN_SEC = 1;

/** Length of a motion-art preview (tools/media renders it from the key art). */
export const MOTION_ART_PREVIEW_SEC = 16;

/**
 * Motion-art recipe revision. Preview files are public and cached as immutable under their
 * asset id, so a motion-art id carries this revision and a hash of the title's art direction:
 * a new recipe or new key art always ships under a new id. Bump it whenever tools/media's
 * motion-art rendering changes (its upload refuses to overwrite a published preview).
 */
export const MOTION_ART_RECIPE = 2;

/**
 * Footage-preview recipe revision, part of every footage preview id (see `MOTION_ART_RECIPE`).
 * Bump it whenever tools/media's footage preview encode changes its bytes.
 */
export const FOOTAGE_PREVIEW_RECIPE = 1;

/** Medium of a fictional title: animation only when the catalogue presents it as animation. */
export function mediumOfGenres(genres: readonly string[]): Medium {
  return genres.includes("animation") ? "animation" : "live-action";
}

export function overlaps(a: Span, b: Span): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

const padded = (spans: readonly Span[], margin: number): Span[] =>
  spans.map(([start, end]) => [start - margin, end + margin] as const);

/** True when `window` shows, or comes within `TEXT_MARGIN_SEC` of, burned-in source text. */
export function showsSourceText(film: OpenFilm, window: Span): boolean {
  return padded(film.textSpans, TEXT_MARGIN_SEC).some((span) => overlaps(span, window));
}

/**
 * True when a frame at `atSec` may show any text at all (source text or the story's own
 * on-screen text), margin included: such a frame is never used as art under a logo.
 */
export function frameShowsText(film: OpenFilm, atSec: number): boolean {
  return padded([...film.textSpans, ...(film.screenText ?? [])], TEXT_MARGIN_SEC).some(
    ([start, end]) => atSec >= start && atSec <= end,
  );
}

/** The film's text-free stretches (margin applied, cut to whole seconds), in order. */
export function cleanSpans(film: OpenFilm): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  const sorted = [...film.textSpans].sort((a, b) => a[0] - b[0]);
  for (const [start, end] of padded(sorted, TEXT_MARGIN_SEC)) {
    const from = Math.ceil(cursor);
    const to = Math.floor(start);
    if (to > from) spans.push([from, to]);
    cursor = Math.max(cursor, end);
  }
  const from = Math.ceil(cursor);
  const to = Math.floor(film.durationSec);
  if (to > from) spans.push([from, to]);
  return spans;
}

/** The longest text-free stretch: the "feature cut" fictional movies play. */
export function featureCut(film: OpenFilm): Span {
  const [longest] = cleanSpans(film).sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
  if (!longest) throw new Error(`${film.key} has no text-free footage`);
  return longest;
}

export type PreviewClass = "own" | "curated" | "art";

export interface CuratedPreview {
  film: string;
  /** Index into the film's `highlights`. */
  highlight: number;
  /** Why a member would believe this is a clip of the title (reviewed on the preview sheet). */
  why: string;
}

/**
 * (b) Curated matches, each reviewed frame by frame on the preview contact sheet. Everything
 * else that is not a real open film gets motion art from its own key art. (Rejected on review:
 * Cosmos Laundromat's sheep field for Last Stop Diner — nothing in it reads as a diner.)
 */
export const CURATED_PREVIEWS: Readonly<Record<string, CuratedPreview>> = {
  "t-the-burrow-brigade": {
    film: "big-buck-bunny",
    highlight: 4,
    why: "animated woodland: a rabbit and his small neighbours by an old tree",
  },
  "t-max-and-the-moon-balloon": {
    film: "wing-it",
    highlight: 6,
    why: "animated home-built flying machine lifting off past the moon",
  },
  "t-the-kite-maker": {
    film: "spring",
    highlight: 8,
    why: "animated mountain valley where the wind returns and blossoms fly",
  },
  "t-uplink": {
    film: "tears-of-steel",
    // Not highlight 8 (285-315 s): its last seconds float a line of dialogue naming a
    // character of the source film. Interface words (PLAYBACK) are fine; captions are not.
    highlight: 18,
    why: "live-action near-future lab: hands on a holographic memory overwrite, the team at work",
  },
};
