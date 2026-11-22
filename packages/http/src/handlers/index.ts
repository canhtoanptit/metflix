import type { routes } from "@webflix/contracts";
import type { AppContainer, AppEnv } from "../container.ts";
import type { RouteHandlers } from "../routing.ts";
import { createBillingHandlers } from "./billing.ts";
import { createEventsHandlers } from "./events.ts";
import { createExperimentsHandlers } from "./experiments.ts";
import { createIdentityHandlers } from "./identity.ts";
import { createPersonalisationHandlers } from "./personalisation.ts";
import { createStreamingHandlers } from "./streaming.ts";

export { createAdminHandlers } from "./admin.ts";
export type { AdminHandlers, AreaHandlers } from "./types.ts";

/**
 * One handler per route of the member contract, composed from one module per area
 * (`handlers/<area>.ts`), so areas implement their routes without touching each other's files.
 * Authentication, CSRF, rate limits, validation and error mapping happen around them (guard,
 * `bindRoutes`, problem handler).
 */
export function createHandlers(container: AppContainer): RouteHandlers<typeof routes, AppEnv> {
  return {
    ...createIdentityHandlers(container),
    ...createBillingHandlers(container),
    ...createPersonalisationHandlers(container),
    ...createStreamingHandlers(container),
    ...createEventsHandlers(container),
    ...createExperimentsHandlers(container),
  };
}
