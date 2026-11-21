/**
 * Authoring format for titles. Drafts are compact and hand-written; `assemble.ts` turns them
 * into `CatalogSeed` titles (episode ids, video assets, preview clips, art direction), so the
 * people writing copy never deal with media plumbing.
 */
import type { MaturityLevel } from "@webflix/contracts";
import type { GenreSlug } from "./genres.ts";
import type { PersonId } from "./people.ts";

/** Controlled vocabulary so mood tags group cleanly across the catalog. */
export const MOODS = [
  "Atmospheric",
  "Bittersweet",
  "Cerebral",
  "Chilling",
  "Cozy",
  "Dark",
  "Emotional",
  "Epic",
  "Exciting",
  "Feel-Good",
  "Goofy",
  "Gritty",
  "Heartfelt",
  "Imaginative",
  "Inspiring",
  "Intimate",
  "Irreverent",
  "Mind-Bending",
  "Offbeat",
  "Ominous",
  "Quirky",
  "Romantic",
  "Scary",
  "Slow Burn",
  "Steamy",
  "Suspenseful",
  "Tense",
  "Thought-Provoking",
  "Understated",
  "Uplifting",
  "Whimsical",
  "Witty",
] as const;
export type Mood = (typeof MOODS)[number];

/** Content advisories shown next to the maturity rating. */
export const ADVISORIES = [
  "language",
  "mild language",
  "violence",
  "mild violence",
  "gore",
  "sex",
  "sexual references",
  "nudity",
  "substances",
  "smoking",
  "fear",
  "peril",
  "self-harm",
  "suicide",
  "discrimination",
  "rude humor",
] as const;
export type Advisory = (typeof ADVISORIES)[number];

/** `[personId, character]`; character is null for presenters credited without a role. */
export type Credit = readonly [person: PersonId | OpenFilmPersonId, character: string | null];

/** `[episode name, runtime in minutes, synopsis]` */
export type EpisodeDraft = readonly [name: string, minutes: number, synopsis: string];

export interface SeasonDraft {
  /** Release year of this season. */
  year: number;
  /** Defaults to "Season N" ("Limited Series" for one-season limited runs). */
  name?: string;
  episodes: readonly EpisodeDraft[];
}

/** People credited on the real open films (see `open-films.ts`). */
export type OpenFilmPersonId = `p-open-${string}`;

interface DraftBase {
  /** `t-<slug>`; stable forever (ratings, history and URLs point at it). */
  id: `t-${string}`;
  name: string;
  tagline: string | null;
  synopsis: string;
  /** First release year (series: the first season). */
  year: number;
  maturity: MaturityLevel;
  advisories: readonly Advisory[];
  /** Most relevant first; the card shows up to three. */
  genres: readonly GenreSlug[];
  moods: readonly Mood[];
  cast: readonly Credit[];
  directors?: readonly (PersonId | OpenFilmPersonId)[];
  creators?: readonly (PersonId | OpenFilmPersonId)[];
  writers?: readonly (PersonId | OpenFilmPersonId)[];
  /** A Webflix Original. */
  original: boolean;
  addedDaysAgo: number;
  /** 0-100 baseline popularity (drives Trending and Top 10). */
  popularity: number;
  /** BCP 47 audio languages, original first. Defaults to `["en"]`. */
  audio?: readonly string[];
}

export interface MovieDraft extends DraftBase {
  type: "movie";
  minutes: number;
}

export interface SeriesDraft extends DraftBase {
  type: "series";
  seasons: readonly SeasonDraft[];
}

export type TitleDraft = MovieDraft | SeriesDraft;
