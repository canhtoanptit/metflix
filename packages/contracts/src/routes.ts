import { billingRoutes } from "./routes/billing.ts";
import { eventsRoutes } from "./routes/events.ts";
import { identityRoutes } from "./routes/identity.ts";
import { personalisationRoutes } from "./routes/personalisation.ts";
import { streamingRoutes } from "./routes/streaming.ts";

/**
 * THE route table: the single source of truth for the member HTTP API (blueprint §6,
 * milestone 2 §4-§6). The typed client, the server bindings (`@webflix/http`) and the OpenAPI
 * document are all derived from it. Keys are stable operation ids (also the client method
 * names). Every route names the `area` whose handler module implements it, and lives in that
 * area's file under `src/routes/`, so areas change their routes without touching each other's.
 * The staff API is `adminRoutes` (src/admin-routes.ts).
 */
export const routes = {
  ...identityRoutes,
  ...billingRoutes,
  ...personalisationRoutes,
  ...streamingRoutes,
  ...eventsRoutes,
} as const;

export type Routes = typeof routes;
export type RouteName = keyof Routes;
