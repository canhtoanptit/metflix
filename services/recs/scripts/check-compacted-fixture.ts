/**
 * Reads services/recs/tests/fixtures/compacted the way the README's reader contract says
 * ("Compacted hours: the contract for readers"), with hyparquet (the JavaScript Parquet reader
 * @webflix/core already depends on; no WASM codec), and checks every account's export against
 * the fixture's expected.json: the right events, each once, the covered raw objects never read,
 * and only the row groups whose `account` statistics admit the account fetched.
 *
 *   node services/recs/scripts/check-compacted-fixture.ts
 *
 * Run by `make recs-test`. It proves the format is readable as specified; it is not the
 * product's reader (the events area owns the data export).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const HERE = import.meta.dirname;
const FIXTURE = resolve(HERE, "../tests/fixtures/compacted");
const STORE = join(FIXTURE, "store");
const HYPARQUET = resolve(HERE, "../../../packages/core/node_modules/hyparquet/src/index.js");

interface ColumnChunk {
  meta_data?: {
    path_in_schema: string[];
    data_page_offset: bigint | number;
    dictionary_page_offset?: bigint | number;
    total_compressed_size: bigint | number;
    codec: string;
    statistics?: {
      min_value?: unknown;
      max_value?: unknown;
      null_count?: bigint | number;
    };
  };
}
interface Metadata {
  row_groups: { columns: ColumnChunk[]; num_rows: bigint | number }[];
}
interface AsyncBuffer {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer;
}
interface Hyparquet {
  parquetMetadata(buffer: ArrayBuffer): Metadata;
  parquetReadObjects(options: {
    file: AsyncBuffer;
    metadata: Metadata;
    columns: string[];
    rowStart: number;
    rowEnd: number;
  }): Promise<Record<string, unknown>[]>;
}
interface Expected {
  accounts: Record<string, { eventIds: string[] }>;
  hours: Record<
    string,
    {
      compacted: boolean;
      readRawObjects: string[];
      skipRawObjects: string[];
      rowGroupsAReaderOfThisAccountReads?: Record<string, number[]>;
    }
  >;
}
interface Event {
  eventId: string;
  subject: { account: string | null };
}

const { parquetMetadata, parquetReadObjects } = (await import(HYPARQUET)) as Hyparquet;
const expected = JSON.parse(readFileSync(join(FIXTURE, "expected.json"), "utf8")) as Expected;

function keysUnder(prefix: string): string[] {
  const directory = join(STORE, prefix);
  return readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isFile())
    .map((name) => `${prefix}${name}`)
    .sort();
}

function bytes(key: string): ArrayBuffer {
  const buffer = readFileSync(join(STORE, key));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function fail(message: string): never {
  console.error(`check-compacted-fixture: ${message}`);
  process.exit(1);
}

/** One account's events in one hour, per the contract. Returns what was read. */
async function readHour(prefix: string, account: string) {
  const keys = keysUnder(prefix);
  const events: Event[] = [];
  const rawRead: string[] = [];
  const groupsRead = new Set<number>();
  let covered = new Set<string>();
  const manifestKey = `${prefix}_compaction.json`;
  if (keys.includes(manifestKey)) {
    const manifest = JSON.parse(new TextDecoder().decode(bytes(manifestKey))) as {
      format: string;
      formatVersion: number;
      parquet: string;
      sources: { key: string }[];
    };
    if (manifest.format !== "webflix.events-compaction" || manifest.formatVersion !== 2) {
      fail(`${manifestKey}: not a version 2 compaction manifest`);
    }
    if (keys.includes(manifest.parquet)) {
      covered = new Set(manifest.sources.map((source) => source.key));
      const whole = bytes(manifest.parquet);
      const metadata = parquetMetadata(whole);
      // The byte span of each row group's column chunks.
      const spans = metadata.row_groups.map((group) => {
        let low = Number.POSITIVE_INFINITY;
        let high = 0;
        for (const column of group.columns) {
          const meta = column.meta_data;
          if (!meta) fail(`${manifest.parquet}: a column chunk without metadata`);
          if (meta.codec !== "SNAPPY") fail(`${manifest.parquet}: ${meta.codec}, not Snappy`);
          const offset = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
          low = Math.min(low, offset);
          high = Math.max(high, offset + Number(meta.total_compressed_size));
        }
        return { low, high };
      });
      const file: AsyncBuffer = {
        byteLength: whole.byteLength,
        slice(start, end = whole.byteLength) {
          spans.forEach((span, index) => {
            if (start < span.high && end > span.low) groupsRead.add(index);
          });
          return whole.slice(start, end);
        },
      };
      // Row groups whose `account` statistics admit the account (byte order; an all-null
      // group has no min/max and holds only signed-out events), read one by one.
      const accountColumn = metadata.row_groups[0]?.columns.findIndex(
        (column) => column.meta_data?.path_in_schema[0] === "account",
      );
      if (accountColumn === undefined || accountColumn < 0) fail("no account column");
      let rowStart = 0;
      for (const group of metadata.row_groups) {
        const rowEnd = rowStart + Number(group.num_rows);
        const stats = group.columns[accountColumn]?.meta_data?.statistics;
        const min = stats?.min_value;
        const max = stats?.max_value;
        if (
          typeof min === "string" &&
          typeof max === "string" &&
          min <= account &&
          account <= max
        ) {
          const rows = await parquetReadObjects({
            file,
            metadata,
            columns: ["account", "raw"],
            rowStart,
            rowEnd,
          });
          for (const row of rows) {
            if (row.account === account) events.push(JSON.parse(String(row.raw)) as Event);
          }
        }
        rowStart = rowEnd;
      }
    }
  }
  for (const key of keys) {
    if (!key.endsWith(".ndjson.gz") || covered.has(key)) continue;
    rawRead.push(key);
    const text = gunzipSync(Buffer.from(bytes(key))).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const event = JSON.parse(line) as Event;
      if (event.subject.account === account) events.push(event);
    }
  }
  return { events, rawRead, groupsRead: [...groupsRead].sort((a, b) => a - b) };
}

let checked = 0;
for (const [account, want] of Object.entries(expected.accounts)) {
  const found = new Map<string, Event>();
  for (const [prefix, hour] of Object.entries(expected.hours)) {
    const result = await readHour(prefix, account);
    if (JSON.stringify(result.rawRead) !== JSON.stringify(hour.readRawObjects)) {
      fail(`${prefix}: read raw objects ${result.rawRead.join(", ")}`);
    }
    for (const skipped of hour.skipRawObjects) {
      if (result.rawRead.includes(skipped)) fail(`${prefix}: read ${skipped}, which is covered`);
    }
    const groups = hour.rowGroupsAReaderOfThisAccountReads?.[account];
    if (groups && JSON.stringify(result.groupsRead) !== JSON.stringify(groups)) {
      fail(`${prefix}: ${account} read row groups [${result.groupsRead}], expected [${groups}]`);
    }
    for (const event of result.events) found.set(event.eventId, event);
  }
  const ids = [...found.keys()].sort();
  if (JSON.stringify(ids) !== JSON.stringify(want.eventIds)) {
    fail(`${account}: ${ids.length} events, expected ${want.eventIds.length}`);
  }
  checked += 1;
}
console.log(`check-compacted-fixture: ${checked} accounts read as the contract says (hyparquet)`);
