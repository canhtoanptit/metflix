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
 * Learned home: when the header carries a run's neighbours (`learned`) and the profile lines
 * their lists (`lists`, the rows `score` writes for that profile), a third file,
 * `learned-home.ndjson`, holds the home page the product serves under the learned policy: the
 * same engine, given that run as `learned` (the model proposes, the rules dispose), read in the
 * same order. That is what members see; the gate compares it with `rule-engine-home`.
 *
 * Sections: an input may hold several sections, each starting with its own header line (one per
 * backtest cutoff of the gate). A header with `section: NAME` sends that section's output to
 * `<out-dir>/NAME/`; without one, to `<out-dir>` itself.
 *
 * Packages are imported read-only through their source paths: services/recs is not a workspace
 * package.
 */
import { createReadStream, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
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
  type LearnedInput,
  Personalization,
  Popularity,
  type ProfileLists,
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
  /** Output subdirectory of this section (absent: the output directory itself). */
  section?: string;
  /** A scored run's neighbours, to rank the learned home page with (absent: no such page). */
  learned?: {
    run: string;
    generatedAt: string;
    expiresAt: string;
    /** [source title, [[neighbour, score], ...] best first]. */
    neighbours: [string, [string, number][]][];
  };
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
  /** The run's lists for this profile (the rows of its artefact payload), or null. */
  lists?: { type: string; param: string | null; items: [string, number][] }[] | null;
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

interface Section {
  header: InputHeader;
  snapshot: CatalogSnapshot;
  popularity: Popularity;
  nowMs: number;
  learned: LearnedInput | null;
  files: { score: WriteStream; home: WriteStream; learned: WriteStream | null };
  profiles: number;
}

function openSection(header: InputHeader, outDir: string): Section {
  if (header.format !== "webflix.rule-engine-input" || header.formatVersion !== 1) {
    fail(`unsupported input format: ${header.format}/${header.formatVersion}`);
  }
  const dir = header.section ? join(outDir, header.section) : outDir;
  mkdirSync(dir, { recursive: true });
  const nowMs = Date.parse(header.asOf);
  const snapshot = buildSnapshot(Date.parse(header.catalogAnchor), header);
  const popularity = buildPopularity(snapshot, header, nowMs);
  const files = {
    score: createWriteStream(join(dir, "rule-engine.ndjson")),
    home: createWriteStream(join(dir, "rule-engine-home.ndjson")),
    learned: header.learned ? createWriteStream(join(dir, "learned-home.ndjson")) : null,
  };
  const generatedAt = new Date().toISOString();
  const outputs: [WriteStream | null, string, string][] = [
    [files.score, "rule-engine", "Personalization.score() order, finished titles sink"],
    [
      files.home,
      "rule-engine-home",
      "home page reading order: billboard, then rows six cards at a time",
    ],
    [
      files.learned,
      "learned-home",
      `home page reading order with run ${header.learned?.run ?? ""} as the learned candidates`,
    ],
  ];
  for (const [file, system, description] of outputs) {
    file?.write(
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
  const learned: LearnedInput | null = header.learned
    ? {
        run: header.learned.run,
        neighbours: new Map(
          header.learned.neighbours.map(([titleId, rows]) => [
            titleId,
            rows.map(([neighbourId, score]) => ({ neighbourId, score })),
          ]),
        ),
        lists: null,
      }
    : null;
  return { header, snapshot, popularity, nowMs, learned, files, profiles: 0 };
}

async function closeSection(section: Section): Promise<void> {
  const files = [section.files.score, section.files.home, section.files.learned];
  await Promise.all(
    files.map((file) =>
      file ? new Promise<void>((resolve) => file.end(() => resolve())) : Promise.resolve(),
    ),
  );
}

function rankProfile(section: Section, profile: InputProfile): void {
  const { header, snapshot, popularity, nowMs } = section;
  const signals: ProfileSignals = {
    myList: profile.myList,
    ratings: profile.ratings,
    progress: profile.progress.map((entry) => ({
      profileId: profile.profileKey,
      hidden: false,
      ...entry,
    })),
  };
  const member = {
    id: profile.profileKey,
    name: "Member",
    maturityCeiling: profile.maturityCeiling,
  };
  const engine = new Personalization({
    snapshot,
    popularity,
    signals,
    profile: member,
    now: nowMs,
  });
  const scored = scoreOrder(engine);
  const limit = header.limit;
  section.files.score.write(
    `${JSON.stringify({
      profileKey: profile.profileKey,
      titleIds: scored.ids.slice(0, limit),
      scores: scored.scores.slice(0, limit),
    })}\n`,
  );
  section.files.home.write(
    `${JSON.stringify({ profileKey: profile.profileKey, titleIds: homeOrder(engine).slice(0, limit), scores: null })}\n`,
  );
  if (section.files.learned && section.learned && header.learned) {
    // What serving hands the engine for this profile (areas/personalisation/serving.ts): the
    // run's neighbours, and its lists when it scored the profile.
    const lists: ProfileLists | null = profile.lists
      ? {
          profileKey: profile.profileKey,
          run: header.learned.run,
          generatedAt: Date.parse(header.learned.generatedAt),
          expiresAt: Date.parse(header.learned.expiresAt),
          rows: profile.lists,
        }
      : null;
    const withModel = new Personalization({
      snapshot,
      popularity,
      signals,
      profile: member,
      now: nowMs,
      learned: { ...section.learned, lists },
    });
    section.files.learned.write(
      `${JSON.stringify({ profileKey: profile.profileKey, titleIds: homeOrder(withModel).slice(0, limit), scores: null })}\n`,
    );
  }
  section.profiles += 1;
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
  mkdirSync(outDir, { recursive: true });
  let section: Section | null = null;
  const done: { section: string | null; profiles: number }[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as InputHeader | InputProfile;
    if ("format" in value) {
      if (section) {
        await closeSection(section);
        done.push({ section: section.header.section ?? null, profiles: section.profiles });
      }
      section = openSection(value, outDir);
      continue;
    }
    if (!section) fail("input header missing");
    rankProfile(section, value);
  }
  if (section) {
    await closeSection(section);
    done.push({ section: section.header.section ?? null, profiles: section.profiles });
  }
  const profiles = done.reduce((sum, entry) => sum + entry.profiles, 0);
  console.log(JSON.stringify({ event: "rule-engine.ranked", profiles, sections: done }));
}

await main();
