/**
 * @webflix/catalog: the seed dataset. Public API (stable; the backend seeder imports it):
 *
 * - `catalog`: titles, seasons, episodes, people, genres, video assets, avatars.
 * - `demoAccount`: the demo account seeded in every mode (blueprint §8).
 * - `openFilms`: the freely licensed source films behind every video asset, with the facts
 *   the seed schema does not carry (subtitle URLs, chapters, credits timecodes, medium and
 *   burned-in text spans). Read by `tools/media`; the API does not need it.
 * - footage rules (`footage.ts`): which clip may stand for which title, for tools/media's
 *   review sheets and the tests.
 *
 * Both seeds are validated against the contract schemas at import time, including
 * referential integrity, so a broken seed fails fast. Author the data in `src/data/`.
 */
import {
  CatalogSeed,
  type CatalogSeedInput,
  DemoAccountSeed,
  demoSeedIssues,
} from "@webflix/contracts";
import { fullCatalog, fullDemoAccount } from "./data/full.ts";
import type { OpenFilm } from "./data/open-film-types.ts";
import { OPEN_FILMS } from "./data/open-films.ts";

export { footagePreviewAsset, motionArtAsset } from "./data/assemble.ts";
export {
  CURATED_PREVIEWS,
  type CuratedPreview,
  cleanSpans,
  FOOTAGE_PREVIEW_RECIPE,
  featureCut,
  frameShowsText,
  MOTION_ART_PREVIEW_SEC,
  MOTION_ART_RECIPE,
  mediumOfGenres,
  type PreviewClass,
  RECAP_SEC,
  showsSourceText,
  TEXT_MARGIN_SEC,
} from "./data/footage.ts";
export type { Medium, OpenFilm, Span } from "./data/open-film-types.ts";

/** Parse catalog data, throwing one error that lists every problem. */
export function defineCatalog(input: CatalogSeedInput): CatalogSeed {
  const result = CatalogSeed.safeParse(input);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid catalog seed:\n  - ${lines.join("\n  - ")}`);
  }
  return result.data;
}

/** Parse the demo account and cross-check it against `forCatalog`. */
export function defineDemoAccount(input: unknown, forCatalog: CatalogSeed): DemoAccountSeed {
  const demo = DemoAccountSeed.parse(input);
  const issues = demoSeedIssues(demo, forCatalog);
  if (issues.length > 0) throw new Error(`Invalid demo account:\n  - ${issues.join("\n  - ")}`);
  return demo;
}

export const catalog: CatalogSeed = defineCatalog(fullCatalog);
export const demoAccount: DemoAccountSeed = defineDemoAccount(fullDemoAccount, catalog);
export const openFilms: readonly OpenFilm[] = OPEN_FILMS;
