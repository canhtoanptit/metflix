import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describePaymentProviderContract } from "@webflix/core/testing";
import { resetDatabase } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import { fakeContractHarness } from "../harness.ts";

let migrated: Promise<void> | undefined;

describePaymentProviderContract("fake (D1 store, workerd)", async () => {
  migrated ??= applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await migrated;
  const database = createD1Database(env.DB);
  await resetDatabase(database);
  return fakeContractHarness(createSqlFakeStore(database));
});
