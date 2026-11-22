import type { AreaPorts } from "@webflix/core";
import { createAdminPorts } from "./admin.ts";
import { createBillingPorts } from "./billing.ts";
import { createEventsPorts } from "./events.ts";
import { createExperimentsPorts } from "./experiments.ts";
import { createIdentityPorts } from "./identity.ts";
import { createPersonalisationPorts } from "./personalisation.ts";
import type { AreaContext } from "./shared.ts";

export type { AreaContext } from "./shared.ts";

/**
 * Milestone 2's ports for the Node runtime, one composition file per area
 * (`src/areas/<area>.ts`), each owned by its area. In-memory unless configured otherwise.
 */
export function createAreaPorts(context: AreaContext): AreaPorts {
  return {
    ...createIdentityPorts(context),
    ...createBillingPorts(context),
    ...createEventsPorts(context),
    ...createPersonalisationPorts(context),
    ...createExperimentsPorts(context),
    ...createAdminPorts(context),
  };
}
