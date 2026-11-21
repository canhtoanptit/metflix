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
