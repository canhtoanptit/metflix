import { type CatalogSeedInput, SEED_VERSION } from "@webflix/contracts";
import { ART_DIRECTION } from "./art.ts";
import { assembleCatalog } from "./assemble.ts";
import { demoAccountInput } from "./demo.ts";
import { batchA } from "./titles/batch-a.ts";
import { batchB } from "./titles/batch-b.ts";
import { batchC } from "./titles/batch-c.ts";
import { batchD } from "./titles/batch-d.ts";

/** The full Webflix catalog: 11 open films plus 108 original fictional titles. */
export const fullCatalog: CatalogSeedInput = assembleCatalog(
  [...batchA, ...batchB, ...batchC, ...batchD],
  ART_DIRECTION,
  SEED_VERSION,
);

export const fullDemoAccount = demoAccountInput;
