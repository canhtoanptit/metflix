/**
 * Export the catalogue snapshot the recommendation pipeline reads (format:
 * services/recs/schemas/catalog-snapshot.schema.json; documented in services/recs/README.md).
 *
 *   node services/recs/scripts/export-catalog.ts --store <blob-store-dir> [--anchor <ISO instant>]
 *
 * Writes `catalog/v={catalogVersion}/snapshot.json`, then the pointer `catalog/current.json`,
 * through the filesystem `BlobStore` adapter (the dev mode's store; its on-disk layout is what
 * the Python pipeline's local storage reads and writes). `--anchor` is the instant the seed's
 * relative times are resolved against, as the seeder does with its clock; it defaults to now.
 *
 * @webflix/catalog, @webflix/contracts and @webflix/adapters-node are imported read-only through
 * their source paths, because services/recs is not a workspace package. A production export job
 * would hand the same bytes to the S3 or R2 store.
 */
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createFsBlobStore } from "../../../packages/adapters-node/src/index.ts";
import { catalog } from "../../../packages/catalog/src/index.ts";
import { MATURITY_LEVELS } from "../../../packages/contracts/src/constants.ts";

const DAY_MS = 86_400_000;

interface SnapshotCredit {
  personId: string;
  role: "cast" | "director" | "creator" | "writer";
  position: number;
}

interface SnapshotEpisode {
  id: string;
  seasonNumber: number;
  number: number;
  seq: number;
  runtimeSec: number;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function buildSnapshot(anchorMs: number) {
  const titles = catalog.titles.map((title) => {
    const credits: SnapshotCredit[] = title.cast.map((credit, position) => ({
      personId: credit.personId,
      role: "cast",
      position,
    }));
    for (const [role, ids] of [
      ["director", title.directorIds],
      ["creator", title.creatorIds],
      ["writer", title.writerIds],
    ] as const) {
      ids.forEach((personId, position) => {
        credits.push({ personId, role, position });
      });
    }
    const episodes: SnapshotEpisode[] = [];
    if (title.type === "series") {
      let seq = 0;
      for (const season of title.seasons) {
        for (const episode of season.episodes) {
          seq += 1;
          episodes.push({
            id: episode.id,
            seasonNumber: season.number,
            number: episode.number,
            seq,
            runtimeSec: episode.runtimeSec,
          });
        }
      }
    }
    return {
      id: title.id,
      type: title.type,
      name: title.name,
      tagline: title.tagline,
      synopsis: title.synopsis,
      releaseYear: title.releaseYear,
      maturity: title.maturity,
      genreIds: title.genreIds,
      moods: title.moods,
      isOriginal: title.isOriginal,
      // The seeder's rule (buildCatalogWrite): addedAt = now - addedDaysAgo days.
      addedAt: iso(anchorMs - title.addedDaysAgo * DAY_MS),
      popularity: title.popularity,
      runtimeSec: title.type === "movie" ? title.runtimeSec : null,
      episodes,
      credits,
    };
  });
  const content = {
    seedVersion: catalog.version,
    anchor: iso(anchorMs),
    maturityLevels: [...MATURITY_LEVELS],
    genres: catalog.genres.map((genre, position) => ({
      id: genre.id,
      slug: genre.slug,
      name: genre.name,
      position,
    })),
    people: catalog.people.map((person) => ({ id: person.id, name: person.name })),
    titles,
  };
  // The version is a hash of the canonical JSON of the content (insertion-ordered keys, no
  // whitespace); the Python loader recomputes it to detect a corrupted or hand-edited file.
  const catalogVersion = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex")
    .slice(0, 16);
  return {
    format: "webflix.catalog-snapshot",
    formatVersion: 1,
    catalogVersion,
    ...content,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { store: { type: "string" }, anchor: { type: "string" } },
    strict: true,
  });
  if (!values.store) {
    console.error("usage: export-catalog.ts --store <blob-store-dir> [--anchor <ISO instant>]");
    process.exit(2);
  }
  const anchorMs = values.anchor ? Date.parse(values.anchor) : Date.now();
  if (Number.isNaN(anchorMs)) {
    console.error(`invalid --anchor: ${values.anchor}`);
    process.exit(2);
  }
  const store = createFsBlobStore({ root: values.store });
  const snapshot = buildSnapshot(anchorMs);
  const body = `${JSON.stringify(snapshot)}\n`;
  const key = `catalog/v=${snapshot.catalogVersion}/snapshot.json`;
  await store.put(key, body);
  // The pointer is written last: a reader that follows it always finds a complete snapshot.
  const pointer = {
    format: "webflix.catalog-pointer",
    formatVersion: 1,
    catalogVersion: snapshot.catalogVersion,
    key,
    sha256: createHash("sha256").update(body).digest("hex"),
    anchor: snapshot.anchor,
  };
  await store.put("catalog/current.json", `${JSON.stringify(pointer)}\n`);
  console.log(
    JSON.stringify({
      event: "catalog.exported",
      key,
      catalogVersion: snapshot.catalogVersion,
      titles: snapshot.titles.length,
      anchor: snapshot.anchor,
    }),
  );
}

await main();
