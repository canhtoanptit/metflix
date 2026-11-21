// Regenerates src/route-index.gen.ts from the route table: `pnpm --filter @webflix/contracts generate`.
// Node runs the TypeScript sources directly (type stripping).
import { writeFile } from "node:fs/promises";
import { routeIndexOf } from "../src/route.ts";
import { routes } from "../src/routes.ts";

const entries = Object.entries(routeIndexOf(routes))
  .map(([name, { method, path }]) => `  ${name}: { method: "${method}", path: "${path}" },`)
  .join("\n");

const source = `// GENERATED from src/routes.ts by scripts/generate-route-index.mjs. Do not edit.
// Run \`pnpm --filter @webflix/contracts generate\` after changing the route table.
import type { Routes } from "./routes.ts";

/**
 * Method and path per route: the zod-free runtime table behind \`createApiClient\`.
 * The \`satisfies\` clause makes a stale entry a type error.
 */
export const ROUTE_INDEX = {
${entries}
} as const satisfies {
  readonly [K in keyof Routes]: { method: Routes[K]["method"]; path: Routes[K]["path"] };
};
`;

await writeFile(new URL("../src/route-index.gen.ts", import.meta.url), source);
console.log(`route-index.gen.ts: ${Object.keys(routes).length} routes`);
