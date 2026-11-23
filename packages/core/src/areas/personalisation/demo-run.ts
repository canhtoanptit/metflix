import type { CatalogSeed, DemoAccountSeed, MediaManifest } from "@webflix/contracts";
import { computePopularity, Popularity } from "../../catalog/cache.ts";
import { CatalogSnapshot } from "../../catalog/snapshot.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import { createSubjectKeys } from "../../ports/event-sink.ts";
import type { Neighbour, ProfileListRow, ProfileLists } from "../../ports/recommendation-store.ts";
import { Personalization } from "../../recommendations/engine.ts";
import { addDays, DAY_MS, utcDay } from "../../recommendations/hash.ts";
import type { CatalogSnapshotData, ProfileSignals } from "../../repositories/records.ts";
import { baselineStats } from "../../services/jobs.ts";
import { standingOf } from "../../services/privileges.ts";
import { buildCatalogWrite } from "../../services/seed.ts";
import { writeRecsVersion } from "./artefact-writer.ts";
import type { RecommendationImportResult } from "./importer.ts";
import type { PersonalisationService } from "./service.ts";
import { DEMO_RUN_RECIPE, isDemoRun } from "./serving.ts";

export { DEMO_RUN_RECIPE, isDemoRun };

/**
 * A demo recommendation run (docs/RECOMMENDATIONS.md, "A demo run"): for showing learned serving
 * (Top Picks, the learned billboard and ordering) on a fresh install, where no pipeline run is
 * fresh. It is plainly not a trained model: its lists are the rule engine's own scores for each
 * of the demo account's profiles (from the seeded library), its neighbours the catalogue's
 * content similarity, its run id ends in `-de00de00` and its manifest says so (`code.demo`).
 * It is written in the pipeline's artefact format (Parquet, manifest with every file's SHA-256)
 * and imported by the real importer like any run. Restricted profiles get no lists, as in the
 * pipeline. Fresh for three days.
 */

const DEMO_LIFETIME_MS = 3 * DAY_MS;
const PERSONAL = 60;
const TOP_PICKS = 30;
const BILLBOARD = 5;
const BECAUSE_SOURCES = 3;
const BECAUSE_ITEMS = 15;
const NEIGHBOURS = 40;

export interface DemoRunResult {
  run: string;
  manifestKey: string;
  neighbourRows: number;
  /** The demo profiles given lists, with the keys they are filed under. */
  profiles: { profileId: string; name: string; profileKey: string }[];
  /** Restricted demo profiles (kids, a lowered ceiling): never given lists. */
  skipped: string[];
}

export function demoRunId(now: number): string {
  const iso = new Date(now).toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${DEMO_RUN_RECIPE}`;
}

/**
 * Writes a demo run into `blobs` (`recs/v={run}/…`; the pointer `recs/current.json` too when
 * `publish`). Profile keys are derived with `pseudonymKey`: the serving runtime's own.
 */
export async function writeDemoRecommendations(options: {
  blobs: BlobStore;
  catalog: CatalogSeed;
  demoAccount: DemoAccountSeed;
  manifest?: MediaManifest | null;
  pseudonymKey: string;
  now: number;
  publish: boolean;
}): Promise<DemoRunResult> {
  const { now } = options;
  const run = demoRunId(now);
  const write = buildCatalogWrite(options.catalog, options.manifest ?? null, now, `demo-${run}`);
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
  const snapshot = new CatalogSnapshot(data);
  const today = utcDay(now);
  const days = Array.from({ length: 14 }, (_, index) => addDays(today, index - 13));
  const popularity = new Popularity(computePopularity(today, baselineStats(snapshot.titles, days)));

  // Content neighbours of every title (support 0: no co-watching behind them).
  const neighbours: Neighbour[] = [];
  const neighbourMap = new Map<string, Neighbour[]>();
  for (const title of snapshot.titles) {
    const rows = [...snapshot.similar(title.id)]
      .filter((entry) => entry.similarity > 0 && entry.id !== title.id)
      .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1))
      .slice(0, NEIGHBOURS)
      .map((entry, index) => ({
        titleId: title.id,
        rank: index + 1,
        neighbourId: entry.id,
        score: Math.min(1, Math.round(entry.similarity * 1e5) / 1e5),
        support: 0,
      }));
    neighbours.push(...rows);
    neighbourMap.set(title.id, rows);
  }

  const keys = createSubjectKeys(options.pseudonymKey);
  const lists: ProfileLists[] = [];
  const result: DemoRunResult = {
    run,
    manifestKey: "",
    neighbourRows: neighbours.length,
    profiles: [],
    skipped: [],
  };
  for (const profile of options.demoAccount.profiles) {
    if (standingOf(profile) !== "unrestricted") {
      result.skipped.push(profile.id);
      continue;
    }
    const engine = new Personalization({
      snapshot,
      popularity,
      signals: signalsOf(profile, snapshot, now),
      profile: { id: profile.id, name: profile.name, maturityCeiling: profile.maturityCeiling },
      now,
    });
    const profileKey = await keys.profile(profile.id);
    lists.push({
      profileKey,
      run,
      generatedAt: now,
      expiresAt: now + DEMO_LIFETIME_MS,
      rows: rowsFor(engine, snapshot, neighbourMap),
    });
    result.profiles.push({ profileId: profile.id, name: profile.name, profileKey });
  }

  const written = await writeRecsVersion(options.blobs, {
    run,
    asOf: now,
    expiresAt: now + DEMO_LIFETIME_MS,
    neighbours,
    profiles: lists,
    publish: options.publish,
    catalogVersion: write.version,
    provenance: {
      code: {
        demo: true,
        builtBy: "webflix demo run (node apps/api/src/recs.ts demo)",
        note: "Not a trained model: per-profile lists are the rule engine's scores for the demo account's seeded library, neighbours are content similarity.",
      },
      data: { demoAccount: options.demoAccount.email },
    },
  });
  result.manifestKey = written.manifestKey;
  return result;
}

/** Why a demo run was not published (nothing was written). */
export class DemoRunRefusedError extends Error {
  override readonly name = "DemoRunRefusedError";
}

/**
 * Publishes a demo run as the pipeline publishes a run (the version, then the pointer
 * `recs/current.json`, into `blobs`: the mode's artefact store), then imports it with the real
 * importer, which verifies the pointer's manifest digest and every file's. Because it is the
 * published run, the scheduled import (a CronJob, the Worker's job) finds it already served
 * until the pipeline publishes a run of its own, which then replaces it.
 *
 * Refused while a fresh pipeline run is served (a demo run would replace a trained model for
 * everyone), unless `replace`.
 */
export async function publishDemoRecommendations(options: {
  personalisation: Pick<PersonalisationService, "importRecommendations" | "recommendationStatus">;
  blobs: BlobStore;
  catalog: CatalogSeed;
  demoAccount: DemoAccountSeed;
  manifest?: MediaManifest | null;
  pseudonymKey: string;
  now: number;
  replace?: boolean;
}): Promise<{ demo: DemoRunResult; imported: RecommendationImportResult }> {
  const { personalisation, now } = options;
  const served = (await personalisation.recommendationStatus()).activeModel;
  if (served && !options.replace && !isDemoRun(served.run) && Date.parse(served.expiresAt) > now) {
    throw new DemoRunRefusedError(
      `A fresh pipeline run (${served.run}, until ${served.expiresAt}) is served; a demo run would replace it for every profile. Pass --replace to do it anyway.`,
    );
  }
  const demo = await writeDemoRecommendations({ ...options, publish: true });
  const imported = await personalisation.importRecommendations({ artefacts: options.blobs });
  return { demo, imported };
}

/** The profile's library as the seeder writes it (positions on the catalogue runtime). */
function signalsOf(
  profile: DemoAccountSeed["profiles"][number],
  snapshot: CatalogSnapshot,
  now: number,
): ProfileSignals {
  return {
    myList: profile.myList.map((titleId, index) => ({
      titleId,
      addedAt: now - (index + 1) * 3_600_000,
    })),
    ratings: profile.ratings.map((rating, index) => ({
      titleId: rating.titleId,
      value: rating.value,
      ratedAt: now - (index + 1) * DAY_MS,
    })),
    progress: profile.viewing.flatMap((entry) => {
      const title = snapshot.title(entry.titleId);
      if (!title) return [];
      const episode = entry.episodeId ? snapshot.episode(entry.episodeId) : undefined;
      const durationSec = episode?.runtimeSec ?? title.runtimeSec ?? 0;
      return [
        {
          profileId: profile.id,
          itemId: episode?.id ?? title.id,
          titleId: title.id,
          episodeId: episode?.id ?? null,
          positionSec: Math.round(durationSec * entry.progress),
          durationSec,
          completed: entry.completed,
          hidden: false,
          updatedAt: now - entry.daysAgo * DAY_MS,
        },
      ];
    }),
  };
}

/** The four row types of the pipeline's payload, from the rule engine's scores. */
function rowsFor(
  engine: Personalization,
  snapshot: CatalogSnapshot,
  neighbours: ReadonlyMap<string, readonly Neighbour[]>,
): ProfileListRow[] {
  const ranked = engine
    .visibleTitles()
    .filter((title) => engine.rating(title.id) !== "dislike" && !engine.progress(title.id)?.anchor)
    .map((title) => ({ id: title.id, score: engine.score(title.id) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, PERSONAL);
  // A score in (0, 1), as the pipeline's "probability of a qualified play".
  const probability = (score: number) =>
    Math.round(Math.min(0.99, Math.max(0.01, (score + 0.6) / 1.8)) * 1e5) / 1e5;
  const personal: [string, number][] = ranked.map((entry) => [entry.id, probability(entry.score)]);

  // Top Picks: the same candidates with genres spread out (the pipeline re-ranks for diversity).
  const picks: [string, number][] = [];
  const remaining = [...personal];
  const recentGenres: string[] = [];
  while (picks.length < TOP_PICKS && remaining.length > 0) {
    const index = Math.max(
      0,
      remaining.findIndex(([id]) => !recentGenres.includes(snapshot.title(id)?.genreIds[0] ?? "")),
    );
    const [chosen] = remaining.splice(index, 1);
    if (!chosen) break;
    picks.push(chosen);
    recentGenres.push(snapshot.title(chosen[0])?.genreIds[0] ?? "");
    if (recentGenres.length > 2) recentGenres.shift();
  }
  const billboard = picks.filter(([id]) => snapshot.title(id)?.isPlayable).slice(0, BILLBOARD);

  // Because You Watched: the most recent titles watched far enough, their neighbours unwatched.
  const watched = engine.watchAgain().concat(engine.continueWatching().map((item) => item.titleId));
  const percentile = new Map(personal.map(([id], index) => [id, 1 - index / personal.length]));
  const because: ProfileListRow[] = [...new Set(watched)]
    .slice(0, BECAUSE_SOURCES)
    .flatMap((source) => {
      const items = (neighbours.get(source) ?? [])
        .filter(
          (row) => !engine.progress(row.neighbourId)?.anchor && engine.isVisible(row.neighbourId),
        )
        .slice(0, BECAUSE_ITEMS)
        .map((row): [string, number] => [
          row.neighbourId,
          Math.round((0.6 * row.score + 0.4 * (percentile.get(row.neighbourId) ?? 0)) * 1e5) / 1e5,
        ])
        .sort((a, b) => b[1] - a[1]);
      return items.length > 0 ? [{ type: "because-you-watched", param: source, items }] : [];
    });

  return [
    { type: "personal", param: null, items: personal },
    { type: "top-picks", param: null, items: picks },
    { type: "billboard", param: null, items: billboard },
    ...because,
  ];
}
