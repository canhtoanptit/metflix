import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describePaymentProviderContract } from "@webflix/core/testing";
import { resetDatabase } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { createSqlFakeStore } from "../../src/sql-store.ts";
import { fakeContractHarness } from "../harness.ts";

let migrated: Promise<void> | undefined;

async function d1Store() {
  migrated ??= applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await migrated;
  const database = createD1Database(env.DB);
  await resetDatabase(database);
  return createSqlFakeStore(database);
}

describePaymentProviderContract("fake (D1 store, workerd)", async () =>
  fakeContractHarness(await d1Store()),
);

// The Worker's configuration (apps/edge/src/areas/billing.ts): no in-memory queues, since one
// request may not await a promise another request settles (docs/CLOUDFLARE.md §2).
describePaymentProviderContract("fake (D1 store, workerd, no in-process queues)", async () =>
  fakeContractHarness(await d1Store(), { inProcessQueues: false }),
);
