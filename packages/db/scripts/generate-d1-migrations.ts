// Writes migrations/d1/<name>.sql from the TypeScript migrations (the single source).
// `pnpm --filter @webflix/db generate`; a test fails while the files are stale.
import { writeFile } from "node:fs/promises";
import { d1MigrationFile, MIGRATIONS } from "../src/index.ts";

for (const migration of MIGRATIONS) {
  const file = new URL(`../migrations/d1/${migration.name}.sql`, import.meta.url);
  await writeFile(file, await d1MigrationFile(migration));
  console.log(`migrations/d1/${migration.name}.sql`);
}
