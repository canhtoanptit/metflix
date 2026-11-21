/** The SQL search index on D1 (FTS5), inside workerd. */
import { describeSearchIndexContract } from "@webflix/core/testing";
import { createSqlSearchIndex } from "../../src/search.ts";
import { freshD1Database } from "./setup.ts";

describeSearchIndexContract("D1 (FTS5)", async () => ({
  index: createSqlSearchIndex(await freshD1Database()),
}));
