import type { MaturityLevel, MediaLicense } from "@webflix/contracts";
import type { GenreSlug } from "./genres.ts";

/** `[startSec, endSec]` in the film's own timeline. */
export type Span = readonly [startSec: number, endSec: number];

/** How footage looks on screen: a clip never previews a title of the other medium. */
export type Medium = "animation" | "live-action";

/**
 * A freely licensed source film. The real open films appear as titles with their true credits;
 * their footage also stands in for the fictional catalog (blueprint §5: titles share assets),
 * cut into chapters (episodes) and short excerpts (previews).
 */
export interface OpenFilm {
  /** Stable key: asset ids derive from it (`v-<key>`, `v-<key>-ch2`, `v-<key>-pv7`). */
  key: string;
  name: string;
  year: number;
  durationSec: number;
  source: {
    /** A 1080p-class master that is reliably downloadable. */
    url: string;
    sha256: string | null;
    bytes: number;
  };
  license: MediaLicense;
  /** Side-car subtitles for the whole film, `[language, url]` (SRT or WebVTT). */
  subtitles: readonly (readonly [language: string, url: string])[];
  /** Absolute HLS fallback served when the film has not been packaged (blueprint §5). */
  externalHlsUrl: string | null;
  medium: Medium;
  /**
   * Every stretch with burned-in text that names the source: studio logos, "presents" cards,
   * the title card, end credits and licence cards, as measured: found on a 1 fps grid of the
   * whole film, then each edge located to 1/8 s (every third frame) on a fine strip, from the
   * first frame where any of the text is visible (fades included) to the first clean frame.
   * Footage lent to another title, and any frame used as art, stays `TEXT_MARGIN_SEC` clear.
   */
  textSpans: readonly Span[];
  /**
   * On-screen text that belongs to the story (holographic UI, signs): fine in playback, but
   * never in key art, where the title's logo is laid over the frame.
   */
  screenText?: readonly Span[];
  /** Opening titles (Skip Intro on the film itself). */
  intro: Span | null;
  /**
   * Where the end credits begin: the whole second at or just before the first credit text, so
   * text-free cuts and chapters always end before it (they carry no credits marker).
   */
  creditsStartSec: number;
  /**
   * Episode-sized chunks for fictional series, inside the text-free story (whole seconds, at
   * least `TEXT_MARGIN_SEC` from any text span). Each chapter after the first starts
   * `RECAP_SEC` before the previous one ends, so its opening really is a recap of the episode
   * before.
   */
  chapters: readonly Span[];
  /**
   * Visually strong windows (about 30 s): the film's own previews, and curated excerpts for
   * fictional titles (only those clear of `textSpans`).
   */
  highlights: readonly Span[];
  /** The film's own rating: its footage only stands in for titles rated at least this. */
  maturity: MaturityLevel;
  /** Genres whose fictional titles this footage stands in for (best fit first). */
  standsInFor: readonly GenreSlug[];
}
