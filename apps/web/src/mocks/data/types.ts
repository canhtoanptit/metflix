/**
 * Shape of the hand-written mock catalogue that drives mock mode (development, component and
 * end-to-end tests without a backend). The mock API turns these seeds into contract DTOs.
 */
export type MockMaturity = "ALL" | "7+" | "13+" | "16+" | "18+";

/** Art direction for the procedurally generated placeholder artwork. */
export type MockMotif =
  | "orbit"
  | "waves"
  | "city"
  | "forest"
  | "desert"
  | "neon"
  | "mountains"
  | "space"
  | "storm"
  | "sunset"
  | "grid"
  | "bloom";

export interface MockGenreSeed {
  slug: string;
  name: string;
  description: string;
}

export interface MockTitleSeed {
  /** Stable kebab-case slug; the title id is `t-<slug>`. */
  slug: string;
  name: string;
  type: "movie" | "series";
  year: number;
  maturity: MockMaturity;
  /** 1–4 genre slugs from MOCK_GENRES, most relevant first. */
  genres: string[];
  /** 2–4 mood tags, e.g. "Suspenseful", "Witty", "Heartfelt". */
  moods: string[];
  /** One or two sentences, at most 220 characters. */
  synopsis: string;
  tagline: string | null;
  /** Movies only: runtime in minutes. */
  runtimeMin?: number;
  /** Series only: episode titles per season (index 0 = season 1). */
  seasons?: string[][];
  /** A Webflix Original. */
  original: boolean;
  cast: Array<{ name: string; character: string | null }>;
  directors: string[];
  /** Series only. */
  creators?: string[];
  /** Content advisories, lowercase: "violence", "language", "peril", "smoking"… */
  maturityDescriptors: string[];
  /** Two lowercase #rrggbb colours evocative of the title (artwork gradient). */
  palette: [string, string];
  motif: MockMotif;
  /** Real, freely licensed films only (e.g. Blender Studio open movies). */
  attribution?: { text: string; license: string; licenseUrl: string; sourceUrl: string | null };
}
