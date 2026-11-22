// Regenerates what is derived from the contract: `pnpm --filter @webflix/contracts generate`.
// - src/route-index.gen.ts: the zod-free runtime tables behind the typed clients.
// - services/recs/schemas/event.schema.json: the event schema the pipeline reads (Biome-formatted,
//   since the root lint checks that file).
// Node runs the TypeScript sources directly (type stripping).
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { adminRoutes } from "../src/admin-routes.ts";
import { EVENT_SCHEMA_PATH, eventJsonSchemaFile } from "../src/event-schema.ts";
import { isClientRoute, isNavigationRoute, routeIndexOf } from "../src/route.ts";
import { routes } from "../src/routes.ts";

const pick = (table, keep) =>
  Object.fromEntries(Object.entries(table).filter(([, route]) => keep(route)));

const entries = (table) =>
  Object.entries(routeIndexOf(table))
    .map(([name, { method, path }]) => `  ${name}: { method: "${method}", path: "${path}" },`)
    .join("\n");

const indexOf = (name, table, typeName, doc) => `/**
${doc}
 * The \`satisfies\` clause makes a stale entry a type error.
 */
export const ${name} = {
${entries(table)}
} as const satisfies {
  readonly [K in keyof ${typeName}]: { method: ${typeName}[K]["method"]; path: ${typeName}[K]["path"] };
};
`;

const client = pick(routes, isClientRoute);
const navigation = pick(routes, isNavigationRoute);
const admin = pick(adminRoutes, isClientRoute);

const source = `// GENERATED from src/routes.ts and src/admin-routes.ts by scripts/generate-route-index.mjs.
// Do not edit. Run \`pnpm --filter @webflix/contracts generate\` after changing a route table.
import type { AdminRoutes } from "./admin-routes.ts";
import type { ClientRoutes, NavigationRoutes } from "./route.ts";
import type { Routes } from "./routes.ts";

type MemberClientRoutes = ClientRoutes<Routes>;
type MemberNavigationRoutes = NavigationRoutes<Routes>;
type AdminClientRoutes = ClientRoutes<AdminRoutes>;

${indexOf(
  "ROUTE_INDEX",
  client,
  "MemberClientRoutes",
  " * Method and path per client route of the member API: the zod-free runtime table behind\n * `createApiClient`.",
)}
${indexOf(
  "NAVIGATION_ROUTE_INDEX",
  navigation,
  "MemberNavigationRoutes",
  " * Redirect routes the browser navigates to (`navigationUrl`).",
)}
${indexOf(
  "ADMIN_ROUTE_INDEX",
  admin,
  "AdminClientRoutes",
  " * Method and path per route of the staff API: the runtime table behind `createAdminApiClient`.",
)}`;

const indexFile = fileURLToPath(new URL("../src/route-index.gen.ts", import.meta.url));
await writeFile(indexFile, source);
const schemaFile = fileURLToPath(new URL(`../../../${EVENT_SCHEMA_PATH}`, import.meta.url));
await writeFile(schemaFile, eventJsonSchemaFile());
// Both files are checked by the root `biome check`: write them the way Biome formats them.
execFileSync("pnpm", ["exec", "biome", "format", "--write", indexFile, schemaFile], {
  stdio: "inherit",
});
console.log(
  `route-index.gen.ts: ${Object.keys(client).length} client, ${Object.keys(navigation).length} navigation, ${Object.keys(admin).length} admin routes; ${EVENT_SCHEMA_PATH}`,
);
