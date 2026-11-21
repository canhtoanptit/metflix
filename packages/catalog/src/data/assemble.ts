/**
 * Turns hand-written drafts into `CatalogSeed` input: episode ids, video assets, preview clips
 * and art direction. Deterministic: the same drafts always produce the same seed.
 *
 * Media distribution (blueprint §5: titles share assets; rules in `footage.ts`). The open
 * films are the only footage, offered as
 *   - `v-<film>`        the whole film, played only by the real title of that film;
 *   - `v-<film>-cut`    its longest text-free stretch (no studio cards, title card or credits):
 *                       the feature fictional movies play;
 *   - `v-<film>-epN`    text-free episode-sized chapters for fictional series; each after the
 *                       first opens with the last `RECAP_SEC` of the one before (a real recap);
 *   - `v-<film>-pvN`    a ~30 s excerpt: the preview of the film itself, or a curated match;
 *   - `v-art-<title>`   a motion-art preview tools/media renders from the title's key art.
 * Playback footage is chosen by medium, then genre affinity, with load balancing so a genre
 * row does not keep playing the same film.
 */
import {
  type CatalogSeedInput,
  MATURITY_LEVELS,
  type MaturityLevel,
  type VideoAssetSeed,
} from "@webflix/contracts";
import { avatarGroups, avatars } from "./avatars.ts";
import type { SeriesDraft, TitleDraft } from "./draft.ts";
import {
  CURATED_PREVIEWS,
  featureCut,
  MOTION_ART_PREVIEW_SEC,
  mediumOfGenres,
  showsSourceText,
} from "./footage.ts";
import { type GenreSlug, genreId, genreSeeds } from "./genres.ts";
import type { Medium, OpenFilm } from "./open-film-types.ts";
import {
  OPEN_FILM_PEOPLE,
  OPEN_FILMS,
  OPEN_TITLES,
  type OpenMovie,
  type OpenSeries,
} from "./open-films.ts";
import { PEOPLE } from "./people.ts";

type TitleInput = CatalogSeedInput["titles"][number];
type ArtDirection = Record<string, unknown>;

const slugOf = (titleId: string) => titleId.replace(/^t-/, "");
export const episodeId = (titleId: string, season: number, episode: number) =>
  `e-${slugOf(titleId)}-s${season}e${episode}`;

const filmAsset = (film: OpenFilm) => `v-${film.key}`;
const cutAsset = (film: OpenFilm) => `v-${film.key}-cut`;
const episodeAsset = (film: OpenFilm, index: number) => `v-${film.key}-ep${index + 1}`;
const previewAsset = (film: OpenFilm, index: number) => `v-${film.key}-pv${index + 1}`;
export const motionArtAsset = (titleId: string) => `v-art-${slugOf(titleId)}`;

function downloadSource(
  film: OpenFilm,
  window?: readonly [number, number],
): VideoAssetSeed["source"] {
  return {
    kind: "download",
    url: film.source.url,
    sha256: film.source.sha256,
    license: film.license,
    ...(window
      ? { startSec: Math.round(window[0]), durationSec: Math.round(window[1] - window[0]) }
      : {}),
  };
}

const languages = (film: OpenFilm) => film.subtitles.map(([language]) => language);

const rank = (level: MaturityLevel) => MATURITY_LEVELS.indexOf(level);

/**
 * Footage a title may borrow: never rated above the title. All-ages titles may use the mild
 * 7+ cartoons, since no all-ages open film is long enough to cut into episodes.
 */
function suitable(film: OpenFilm, maturity: MaturityLevel): boolean {
  return rank(film.maturity) <= Math.max(rank(maturity), rank("7+"));
}

/** Films fictional titles may borrow (the Caminandes shorts are too short to stand in). */
const STAND_INS = OPEN_FILMS.filter((film) => !film.key.startsWith("caminandes"));

/** Cost of playing footage of the other medium (live action under a cartoon, or vice versa). */
const MEDIUM_MISMATCH = 2.5;

class MediaPlanner {
  private readonly filmUse = new Map<string, number>();
  private readonly genreUse = new Map<string, number>();
  private readonly highlightUse = new Set<string>();
  readonly assets = new Map<string, VideoAssetSeed>();
  private readonly films = new Map(OPEN_FILMS.map((film) => [film.key, film]));

  film(key: string): OpenFilm {
    const film = this.films.get(key);
    if (!film) throw new Error(`Unknown open film ${key}`);
    return film;
  }

  private affinity(film: OpenFilm, genres: readonly GenreSlug[]): number {
    let best = Number.POSITIVE_INFINITY;
    genres.forEach((genre, g) => {
      const position = film.standsInFor.indexOf(genre);
      if (position >= 0) best = Math.min(best, g * 1.5 + position);
    });
    return best;
  }

  /**
   * Best-fitting film for a fictional title: same medium first, then genre affinity. Reusing
   * a film costs a little across the catalog and a lot within the same primary genre, so a
   * genre row spreads across several films.
   */
  chooseFilm(
    genres: readonly GenreSlug[],
    maturity: MaturityLevel,
    medium: Medium,
    options: { minChapters?: number } = {},
  ): OpenFilm {
    let choice: OpenFilm | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const primary = genres[0] ?? "drama";
    for (const film of STAND_INS) {
      if (film.chapters.length < (options.minChapters ?? 1) || !suitable(film, maturity)) continue;
      const fit = this.affinity(film, genres);
      const inGenre = this.genreUse.get(`${primary}:${film.key}`) ?? 0;
      const score =
        (Number.isFinite(fit) ? fit : 6) +
        (film.medium === medium ? 0 : MEDIUM_MISMATCH) +
        (this.filmUse.get(film.key) ?? 0) * 0.35 +
        inGenre * 3;
      if (score < bestScore) {
        bestScore = score;
        choice = film;
      }
    }
    if (!choice) throw new Error(`No stand-in film for ${genres.join(", ")}`);
    this.filmUse.set(choice.key, (this.filmUse.get(choice.key) ?? 0) + 1);
    const key = `${primary}:${choice.key}`;
    this.genreUse.set(key, (this.genreUse.get(key) ?? 0) + 1);
    return choice;
  }

  private add(asset: VideoAssetSeed): string {
    if (!this.assets.has(asset.id)) this.assets.set(asset.id, asset);
    return asset.id;
  }

  /** The complete film, for the real title of that film only. */
  wholeFilm(film: OpenFilm): string {
    return this.add({
      id: filmAsset(film),
      label: `${film.name} (complete film)`,
      source: downloadSource(film),
      externalHlsUrl: film.externalHlsUrl,
      subtitleLanguages: languages(film),
    });
  }

  /** The text-free feature cut fictional movies play. */
  cut(film: OpenFilm): string {
    return this.add({
      id: cutAsset(film),
      label: `${film.name}, text-free feature cut`,
      source: downloadSource(film, featureCut(film)),
      externalHlsUrl: null,
      subtitleLanguages: languages(film),
    });
  }

  chapter(film: OpenFilm, index: number): string {
    const chapterIndex = index % film.chapters.length;
    const span = film.chapters[chapterIndex];
    if (!span) throw new Error(`${film.key} has no chapters`);
    if (showsSourceText(film, span)) throw new Error(`${film.key} chapter ${index} shows text`);
    return this.add({
      id: episodeAsset(film, chapterIndex),
      label: `${film.name}, text-free chapter ${chapterIndex + 1}`,
      source: downloadSource(film, span),
      externalHlsUrl: null,
      subtitleLanguages: languages(film),
    });
  }

  /**
   * An excerpt nobody uses yet: highlight `index` of `film`, or its first free one (text-free
   * highlights first, so even a film's own preview opens on story, not on credits).
   */
  excerpt(film: OpenFilm, index?: number): string {
    const clean = (i: number) => {
      const span = film.highlights[i];
      return span && !showsSourceText(film, span) ? 0 : 1;
    };
    const indices =
      index === undefined
        ? film.highlights.map((_, i) => i).sort((a, b) => clean(a) - clean(b) || a - b)
        : [index];
    for (const i of indices) {
      const span = film.highlights[i];
      const id = previewAsset(film, i);
      if (!span || this.highlightUse.has(id)) continue;
      this.highlightUse.add(id);
      return this.add({
        id,
        label: `${film.name}, preview excerpt ${i + 1}`,
        source: downloadSource(film, span),
        externalHlsUrl: null,
        subtitleLanguages: [],
      });
    }
    throw new Error(
      `No free preview excerpt in ${film.key}${index === undefined ? "" : ` #${index}`}`,
    );
  }

  /**
   * A fictional title's preview: its curated match when it has one (checked for medium and
   * burned-in text here, so a bad entry fails the build), else motion art from its key art.
   */
  previewFor(draft: TitleDraft): string {
    const curated = CURATED_PREVIEWS[draft.id];
    if (curated) {
      const film = this.film(curated.film);
      const span = film.highlights[curated.highlight];
      if (!span) throw new Error(`${draft.id}: ${film.key} has no highlight ${curated.highlight}`);
      if (film.medium !== mediumOfGenres(draft.genres))
        throw new Error(`${draft.id}: curated preview is ${film.medium} footage`);
      if (showsSourceText(film, span)) throw new Error(`${draft.id}: curated preview shows text`);
      if (!suitable(film, draft.maturity))
        throw new Error(`${draft.id}: curated preview rated ${film.maturity}`);
      return this.excerpt(film, curated.highlight);
    }
    return this.add({
      id: motionArtAsset(draft.id),
      label: `${draft.name}: motion-art preview from its key art`,
      source: { kind: "synthetic", durationSec: MOTION_ART_PREVIEW_SEC },
      externalHlsUrl: null,
      subtitleLanguages: [],
    });
  }
}

function baseTitle(draft: TitleDraft, art: ArtDirection | undefined) {
  return {
    id: draft.id,
    name: draft.name,
    tagline: draft.tagline,
    synopsis: draft.synopsis,
    releaseYear: draft.year,
    maturity: draft.maturity,
    maturityDescriptors: [...draft.advisories],
    genreIds: draft.genres.map(genreId),
    moods: [...draft.moods],
    cast: draft.cast.map(([personId, character]) => ({ personId, character })),
    directorIds: [...(draft.directors ?? [])],
    creatorIds: [...(draft.creators ?? [])],
    writerIds: [...(draft.writers ?? [])],
    isOriginal: draft.original,
    addedDaysAgo: draft.addedDaysAgo,
    popularity: draft.popularity,
    audioLanguages: [...(draft.audio ?? ["en"])],
    ...(art ? { art } : {}),
  };
}

function seasons(
  draft: SeriesDraft,
  assetFor: (index: number, episodeNumber: number) => string,
): Extract<TitleInput, { type: "series" }>["seasons"] {
  let index = 0;
  return draft.seasons.map((season, s) => ({
    number: s + 1,
    name: season.name ?? `Season ${s + 1}`,
    releaseYear: season.year,
    episodes: season.episodes.map(([name, minutes, synopsis], e) => {
      const asset = assetFor(index, e + 1);
      index += 1;
      return {
        id: episodeId(draft.id, s + 1, e + 1),
        number: e + 1,
        name,
        synopsis,
        runtimeSec: Math.round(minutes * 60),
        videoAssetId: asset,
      };
    }),
  }));
}

export function assembleCatalog(
  drafts: readonly TitleDraft[],
  art: Readonly<Record<string, ArtDirection>>,
  version: CatalogSeedInput["version"],
): CatalogSeedInput {
  const planner = new MediaPlanner();
  const titles: TitleInput[] = [];

  // Real films first: they claim their own footage and their own first free excerpt.
  for (const open of OPEN_TITLES) {
    if (open.type === "movie") {
      const film = planner.film((open as OpenMovie).film);
      titles.push({
        ...baseTitle(open, art[open.id]),
        type: "movie",
        runtimeSec: film.durationSec,
        videoAssetId: planner.wholeFilm(film),
        previewAssetId: planner.excerpt(film),
        license: film.license,
      });
    } else {
      const films = (open as OpenSeries).films.map((key) => planner.film(key));
      const first = films[0];
      if (!first) throw new Error(`${open.id} has no films`);
      titles.push({
        ...baseTitle(open, art[open.id]),
        type: "series",
        seasons: seasons(open, (index) => {
          const film = films[index % films.length] ?? first;
          return planner.wholeFilm(film);
        }).map((season) => ({
          ...season,
          episodes: season.episodes.map((episode, e) => ({
            ...episode,
            runtimeSec: films[e]?.durationSec ?? episode.runtimeSec,
          })),
        })),
        previewAssetId: planner.excerpt(films[1] ?? first),
        license: first.license,
      });
    }
  }

  // Curated previews claim their excerpts before anything else is planned.
  const ordered = [...drafts].sort(
    (a, b) => b.popularity - a.popularity || a.id.localeCompare(b.id),
  );
  const previews = new Map(ordered.map((draft) => [draft.id, planner.previewFor(draft)]));

  // Fictional titles, most popular first so the titles people see most get the best fits.
  for (const draft of ordered) {
    const medium = mediumOfGenres(draft.genres);
    const previewAssetId = previews.get(draft.id) ?? null;
    if (draft.type === "movie") {
      const film = planner.chooseFilm(draft.genres, draft.maturity, medium);
      titles.push({
        ...baseTitle(draft, art[draft.id]),
        type: "movie",
        runtimeSec: Math.round(draft.minutes * 60),
        videoAssetId: planner.cut(film),
        previewAssetId,
        license: null,
      });
    } else {
      const film = planner.chooseFilm(draft.genres, draft.maturity, medium, { minChapters: 2 });
      titles.push({
        ...baseTitle(draft, art[draft.id]),
        type: "series",
        // Episodes play the film's chapters in story order, so each recap (the opening of a
        // later chapter) replays the end of the episode before.
        seasons: seasons(draft, (_index, episodeNumber) =>
          planner.chapter(film, episodeNumber - 1),
        ),
        previewAssetId,
        license: null,
      });
    }
  }

  // Keep catalog order stable and readable: real films, then drafts as written.
  const order = new Map<string, number>(
    [...OPEN_TITLES, ...drafts].map((draft, index) => [draft.id, index]),
  );
  titles.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const credited = new Set<string>();
  for (const title of titles) {
    for (const credit of title.cast) credited.add(credit.personId);
    for (const id of [...title.directorIds, ...title.creatorIds, ...title.writerIds])
      credited.add(id);
  }
  const people = [...PEOPLE, ...OPEN_FILM_PEOPLE]
    .filter(([id]) => credited.has(id))
    .map(([id, name]) => ({ id, name }));

  return {
    version,
    genres: genreSeeds,
    people,
    videoAssets: [...planner.assets.values()].sort((a, b) => a.id.localeCompare(b.id)),
    titles,
    avatarGroups,
    avatars,
  };
}
