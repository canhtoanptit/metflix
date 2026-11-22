/**
 * Rankings from the real milestone 1 rule engine (`Personalization` in @webflix/core), for the
 * offline evaluation of services/recs (docs/RECOMMENDATIONS-ML.md, "Baselines").
 *
 *   node services/recs/scripts/rule-engine-rankings.ts --input <engine-input.ndjson> --out-dir <dir>
 *
 * Input (written by the Python harness): a header line, then one line per profile with its
 * library signals as of the cutoff (My List, ratings, progress records), exactly the
 * `ProfileSignals` the engine reads from the database. The catalogue is built from
 * @webflix/catalog by the seeder's own `buildCatalogWrite`, at the anchor the pipeline's
 * catalogue snapshot used (checked title by title), and popularity from the seed baseline
 * (`baselineStats`) plus the playback views the harness counted, through `computePopularity`,
 * as the API does.
 *
 * Output: `rule-engine.ndjson` (the engine's personal order: `score()` with finished titles
 * sinking, its "suggested" order) and `rule-engine-home.ndjson` (the home page as a member
 * reads it: billboard, then the first six cards of every row in page order, then the next six),
 * both in the external rankings format (services/recs/README.md, "External rankings").
 *
 * Packages are imported read-only through their source paths: services/recs is not a workspace
 * package.
 */
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { catalog } from "../../../packages/catalog/src/index.ts";
import type { MaturityLevel, RatingValue } from "../../../packages/contracts/src/index.ts";
import {
  addDays,
  baselineStats,
  buildCatalogWrite,
  CatalogSnapshot,
  type CatalogSnapshotData,
  computePopularity,
  type DailyViews,
  Personalization,
  Popularity,
  type ProfileSignals,
  utcDay,
} from "../../../packages/core/src/index.ts";

interface InputHeader {
  format: "webflix.rule-engine-input";
  formatVersion: 1;
  asOf: string;
  catalogAnchor: string;
  catalogVersion: string;
  titles: { id: string; addedAt: string }[];
  /** Playback views (a profile credited with at least 60 s of a title that day), per UTC day. */
  views: DailyViews[];
  limit: number;
}

interface InputProfile {
  profileKey: string;
  maturityCeiling: MaturityLevel;
  myList: { titleId: string; addedAt: number }[];
  ratings: { titleId: string; value: RatingValue; ratedAt: number }[];
  progress: {
    itemId: string;
    titleId: string;
    episodeId: string | null;
    positionSec: number;
    durationSec: number;
    completed: boolean;
    updatedAt: number;
  }[];
}

const SCREEN_CARDS = 6;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function buildSnapshot(anchorMs: number, header: InputHeader): CatalogSnapshot {
  const write = buildCatalogWrite(catalog, null, anchorMs, `recs-eval-${header.catalogVersion}`);
  const expected = new Map(header.titles.map((title) => [title.id, Date.parse(title.addedAt)]));
  for (const title of write.titles) {
    if (expected.get(title.id) !== title.addedAt) {
      fail(`catalogue mismatch for ${title.id}: the pipeline's snapshot is not this catalogue`);
    }
  }
  if (expected.size !== write.titles.length) fail("catalogue mismatch: different title count");
  const people = new Map(write.people.map((person) => [person.id, person.name]));
  const data: CatalogSnapshotData = {
    version: write.version,
    genres: write.genres,
    titles: write.titles,
    credits: write.credits.map((credit) => ({
      ...credit,
      personName: people.get(credit.personId) ?? credit.personId,
    })),
    seasons: write.seasons,
    episodes: write.episodes,
    packagedAssets: [],
  };
  return new CatalogSnapshot(data);
}

function buildPopularity(
  snapshot: CatalogSnapshot,
  header: InputHeader,
  nowMs: number,
): Popularity {
  const today = utcDay(nowMs);
  const days = Array.from({ length: 14 }, (_, index) => addDays(today, index - 13));
  const rows: DailyViews[] = [
    ...baselineStats(snapshot.titles, days).map((stat) => ({
      day: stat.day,
      titleId: stat.titleId,
      views: stat.views,
    })),
    ...header.views,
  ];
  return new Popularity(computePopularity(today, rows));
}

function scoreOrder(engine: Personalization): { ids: string[]; scores: number[] } {
  const ranked = engine
    .visibleTitles()
    .filter((title) => engine.rating(title.id) !== "dislike")
    .map((title) => ({
      id: title.id,
      rank: engine.score(title.id) - (engine.progress(title.id)?.finished ? 1 : 0),
    }))
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  return { ids: ranked.map((entry) => entry.id), scores: ranked.map((entry) => entry.rank) };
}

function homeOrder(engine: Personalization): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  const billboard = engine.billboard("home");
  if (billboard) push(billboard);
  const rows = engine.rows("home");
  const longest = Math.max(0, ...rows.map((row) => row.titleIds.length));
  for (let start = 0; start < longest; start += SCREEN_CARDS) {
    for (const row of rows) {
      for (const id of row.titleIds.slice(start, start + SCREEN_CARDS)) push(id);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { input: { type: "string" }, "out-dir": { type: "string" } },
    strict: true,
  });
  const input = values.input;
  const outDir = values["out-dir"];
  if (!input || !outDir) fail("usage: rule-engine-rankings.ts --input <file> --out-dir <dir>");
  const lines = createInterface({
    input: createReadStream(input),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let header: InputHeader | null = null;
  let snapshot: CatalogSnapshot | null = null;
  let popularity: Popularity | null = null;
  let nowMs = 0;
  mkdirSync(outDir, { recursive: true });
  const scoreFile = createWriteStream(join(outDir, "rule-engine.ndjson"));
  const homeFile = createWriteStream(join(outDir, "rule-engine-home.ndjson"));
  let profiles = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (header === null) {
      header = JSON.parse(line) as InputHeader;
      if (header.format !== "webflix.rule-engine-input" || header.formatVersion !== 1) {
        fail(`unsupported input format: ${header.format}/${header.formatVersion}`);
      }
      nowMs = Date.parse(header.asOf);
      snapshot = buildSnapshot(Date.parse(header.catalogAnchor), header);
      popularity = buildPopularity(snapshot, header, nowMs);
      const generatedAt = new Date().toISOString();
      for (const [file, system, description] of [
        [scoreFile, "rule-engine", "Personalization.score() order, finished titles sink"],
        [
          homeFile,
          "rule-engine-home",
          "home page reading order: billboard, then rows six cards at a time",
        ],
      ] as const) {
        file.write(
          `${JSON.stringify({
            format: "webflix.rankings",
            formatVersion: 1,
            system,
            description,
            asOf: header.asOf,
            generatedAt,
            catalogVersion: header.catalogVersion,
          })}\n`,
        );
      }
      continue;
    }
    if (!snapshot || !popularity) fail("input header missing");
    const profile = JSON.parse(line) as InputProfile;
    const signals: ProfileSignals = {
      myList: profile.myList,
      ratings: profile.ratings,
      progress: profile.progress.map((entry) => ({
        profileId: profile.profileKey,
        hidden: false,
        ...entry,
      })),
    };
    const engine = new Personalization({
      snapshot,
      popularity,
      signals,
      profile: { id: profile.profileKey, name: "Member", maturityCeiling: profile.maturityCeiling },
      now: nowMs,
    });
    const scored = scoreOrder(engine);
    const limit = header.limit;
    scoreFile.write(
      `${JSON.stringify({
        profileKey: profile.profileKey,
        titleIds: scored.ids.slice(0, limit),
        scores: scored.scores.slice(0, limit),
      })}\n`,
    );
    homeFile.write(
      `${JSON.stringify({ profileKey: profile.profileKey, titleIds: homeOrder(engine).slice(0, limit), scores: null })}\n`,
    );
    profiles += 1;
  }
  await Promise.all(
    [scoreFile, homeFile].map((file) => new Promise<void>((resolve) => file.end(() => resolve()))),
  );
  console.log(JSON.stringify({ event: "rule-engine.ranked", profiles }));
}

await main();
