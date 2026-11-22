import type { SchemaMigration } from "../types.ts";
import * as m0003 from "./0003_billing.ts";
import * as m0008 from "./0008_billing_projection.ts";
import * as m0019 from "./0019_billing_next_invoice.ts";

/**
 * The billing area's migrations, oldest first. Add a migration here (a new file, the next free
 * `NNNN_billing_<change>` name) and run `pnpm --filter @webflix/db generate` for D1.
 */
export const BILLING_MIGRATIONS: readonly SchemaMigration[] = [
  { name: "0003_billing", source: "billing/0003_billing.ts", up: m0003.up },
  {
    name: "0008_billing_projection",
    source: "billing/0008_billing_projection.ts",
    up: m0008.up,
  },
  {
    name: "0019_billing_next_invoice",
    source: "billing/0019_billing_next_invoice.ts",
    up: m0019.up,
  },
];
