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
   * the title card, end credits and licence cards (read off a 3 s frame grid of the whole
   * film). Footage lent to another title never overlaps these.
   */
  textSpans: readonly Span[];
  /** Opening titles (Skip Intro on the film itself). */
  intro: Span | null;
  /** Where the end credits begin. */
  creditsStartSec: number;
  /**
   * Episode-sized chunks for fictional series, inside the text-free story. Each chapter after
   * the first starts `RECAP_SEC` before the previous one ends, so its opening really is a
   * recap of the episode before.
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
