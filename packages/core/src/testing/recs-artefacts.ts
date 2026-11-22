import { parquetWriteBuffer } from "hyparquet-writer/src/index.js";
import { sha256Hex, utf8Encode } from "../encoding.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import {
  encodeProfileLists,
  type Neighbour,
  type ProfileLists,
} from "../ports/recommendation-store.ts";

/**
 * Writes a recommendation version exactly as the pipeline's `score` and `publish` do
 * (services/recs/README.md, "Artefacts"): Snappy Parquet tables under `recs/v={run}/`, the
 * manifest with every file's byte count and SHA-256, then (when `publish`) the pointer
 * `recs/current.json`. For importer and serving tests without running the Python pipeline.
 */
export interface RecsVersionInput {
  run: string;
  asOf: number;
  expiresAt: number;
  neighbours: readonly Neighbour[];
  /** Lists per profile (`run` and `expiresAt` of each list are taken as given). */
  profiles: readonly ProfileLists[];
  /** Profile rows per shard file (default: one shard). */
  shardSize?: number;
  /** Rows per Parquet row group (default 10,000, the pipeline's cap). */
  rowGroupSize?: number;
  /** Write `recs/current.json` pointing at this version (default true). */
  publish?: boolean;
  /** The pointer's `previous` (default null). */
  previous?: string | null;
}

export interface WrittenRecsVersion {
  manifestKey: string;
  manifestSha256: string;
  files: { path: string; bytes: number; sha256: string }[];
}

export async function writeRecsVersion(
  blobs: BlobStore,
  input: RecsVersionInput,
): Promise<WrittenRecsVersion> {
  const base = `recs/v=${input.run}/`;
  const rowGroupSize = input.rowGroupSize ?? 10_000;
  const files: {
    path: string;
    table: string;
    rows: number;
    bytes: number;
    sha256: string;
    firstKey: string;
    lastKey: string;
  }[] = [];

  async function put(
    path: string,
    table: string,
    buffer: ArrayBuffer,
    rows: number,
    keys: string[],
  ) {
    const bytes = new Uint8Array(buffer);
    await blobs.put(`${base}${path}`, bytes);
    files.push({
      path,
      table,
      rows,
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      firstKey: keys[0] ?? "",
      lastKey: keys.at(-1) ?? "",
    });
  }

  const neighbours = [...input.neighbours].sort((a, b) =>
    a.titleId < b.titleId ? -1 : a.titleId > b.titleId ? 1 : a.rank - b.rank,
  );
  await put(
    "neighbours/part-00000.parquet",
    "neighbours",
    parquetWriteBuffer({
      rowGroupSize,
      columnData: [
        { name: "title_id", type: "STRING", data: neighbours.map((row) => row.titleId) },
        { name: "rank", type: "INT32", data: neighbours.map((row) => row.rank) },
        { name: "neighbour_id", type: "STRING", data: neighbours.map((row) => row.neighbourId) },
        { name: "score", type: "FLOAT", data: neighbours.map((row) => row.score) },
        { name: "support", type: "INT32", data: neighbours.map((row) => row.support) },
      ],
    }),
    neighbours.length,
    neighbours.map((row) => row.titleId),
  );

  const profiles = [...input.profiles].sort((a, b) =>
    a.profileKey < b.profileKey ? -1 : a.profileKey > b.profileKey ? 1 : 0,
  );
  const shardSize = Math.max(1, input.shardSize ?? Math.max(1, profiles.length));
  const shards = Math.max(1, Math.ceil(profiles.length / shardSize));
  for (let shard = 0; shard < shards; shard += 1) {
    const rows = profiles.slice(shard * shardSize, (shard + 1) * shardSize);
    const payloads = rows.map((list) => encodeProfileLists(list));
    await put(
      `profiles/part-${String(shard).padStart(5, "0")}.parquet`,
      "profiles",
      parquetWriteBuffer({
        rowGroupSize,
        columnData: [
          { name: "profile_key", type: "STRING", data: rows.map((list) => list.profileKey) },
          { name: "payload", type: "STRING", data: payloads },
          {
            name: "items",
            type: "INT32",
            data: rows.map((list) => list.rows.reduce((sum, row) => sum + row.items.length, 0)),
          },
          {
            name: "bytes",
            type: "INT32",
            data: payloads.map((payload) => utf8Encode(payload).byteLength),
          },
        ],
      }),
      rows.length,
      rows.map((list) => list.profileKey),
    );
  }

  const manifest = {
    format: "webflix.recs",
    formatVersion: 1,
    formatMinor: 0,
    run: input.run,
    recipeHash: input.run.slice(-8).padEnd(16, "0"),
    createdAt: new Date(input.asOf).toISOString(),
    asOf: new Date(input.asOf).toISOString(),
    expiresAt: new Date(input.expiresAt).toISOString(),
    catalogVersion: "test",
    code: {},
    data: {},
    evaluation: null,
    counts: {
      profiles: profiles.length,
      titles: new Set(neighbours.map((row) => row.titleId)).size,
      neighbourRows: neighbours.length,
      profileItems: profiles.reduce(
        (sum, list) => sum + list.rows.reduce((inner, row) => inner + row.items.length, 0),
        0,
      ),
    },
    rowTypes: ["personal", "top-picks", "billboard", "because-you-watched"],
    tables: {},
    files,
  };
  const manifestBytes = utf8Encode(JSON.stringify(manifest));
  const manifestKey = `${base}manifest.json`;
  await blobs.put(manifestKey, manifestBytes);
  const manifestSha256 = await sha256Hex(manifestBytes);
  if (input.publish ?? true) {
    await blobs.put(
      "recs/current.json",
      JSON.stringify({
        format: "webflix.recs-pointer",
        formatVersion: 1,
        run: input.run,
        manifest: manifestKey,
        manifestSha256,
        publishedAt: new Date(input.asOf).toISOString(),
        previous: input.previous ?? null,
        gate: null,
      }),
    );
  }
  return {
    manifestKey,
    manifestSha256,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
}
