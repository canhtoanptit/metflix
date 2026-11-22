import { describePaymentProviderContract } from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import { fakeContractHarness } from "../harness.ts";

describePaymentProviderContract("fake (SQLite store)", async () => {
  const database = createSqliteDatabase({ path: ":memory:" });
  await migrateToLatest(database);
  return fakeContractHarness(createSqlFakeStore(database), {}, () => database.close());
});
