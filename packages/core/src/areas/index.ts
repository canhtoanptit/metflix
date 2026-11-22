/**
 * Milestone 2's areas (docs/FOUNDATION.md §8): one module per area, each owning its service,
 * repository port and configuration, composed by `createServices`.
 */
import type { ServiceDependencies } from "../services/context.ts";
import { type AdminService, createAdminService } from "./admin/service.ts";
import { type BillingService, createBillingService } from "./billing/service.ts";
import { createEventsService, type EventsService } from "./events/service.ts";
import { createExperimentsService, type ExperimentsService } from "./experiments/service.ts";
import { createIdentityService, type IdentityService } from "./identity/service.ts";
import type { AreaSeams } from "./module.ts";
import {
  createPersonalisationService,
  type PersonalisationService,
} from "./personalisation/service.ts";

export interface AreaServices {
  identity: IdentityService;
  billing: BillingService;
  events: EventsService;
  personalisation: PersonalisationService;
  experiments: ExperimentsService;
  admin: AdminService;
}

/** Build every area service and the seams between them. Construction does no I/O. */
export function createAreaServices(deps: ServiceDependencies): {
  areas: AreaServices;
  seams: AreaSeams;
} {
  // The seams call the services built below; nothing calls them during construction.
  const seams: AreaSeams = {
    emitServerEvent: (event) => events.emitServerEvent(event),
    assignments: (unit, context) => experiments.assignments(unit, context),
  };
  const events = createEventsService(deps);
  const experiments = createExperimentsService(deps, seams);
  return {
    areas: {
      identity: createIdentityService(deps, seams),
      billing: createBillingService(deps, seams),
      events,
      personalisation: createPersonalisationService(deps, seams),
      experiments,
      admin: createAdminService(deps, seams),
    },
    seams,
  };
}
