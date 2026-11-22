import type { Kysely } from "kysely";
import type { SqlDialect } from "../dialect.ts";

/** Physical column types per dialect (see `schema.ts` for the representation choices). */
export function columnTypes(dialect: SqlDialect) {
  const postgres = dialect === "postgres";
  return {
    text: "text",
    int: "integer",
    /** Epoch milliseconds. */
    time: postgres ? "bigint" : "integer",
    real: postgres ? "double precision" : "real",
    /** 0/1 everywhere. */
    bool: "integer",
  } as const;
}

/** A schema change authored once for every dialect. */
export interface SchemaMigration {
  /**
   * Sortable and unique, `NNNN_<area>_<change>` (the first milestone 2 ones are
   * `NNNN_<area>`). Also the D1 file name. Take the next free number when adding one.
   */
  name: string;
  /** The source file under `packages/db/src/migrations/` (default `<name>.ts`), for D1 headers. */
  source?: string;
  // biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
  up(db: Kysely<any>, dialect: SqlDialect): Promise<void>;
}
