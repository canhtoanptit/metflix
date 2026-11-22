import type { ServiceDependencies } from "../../services/context.ts";
import { type AreaModule, NO_JOBS, type ServerEventInput } from "../module.ts";

/**
 * The events area (milestone 2 §6): ingestion of client batches, server events, the event lake
 * through `deps.eventSink` (validated `LakeEvent`s, partitioned by receipt hour), consent,
 * pseudonymous subject keys, export and deletion. Owns the `emitServerEvent` seam every other
 * area calls, and milestone 1's playback service (services/playback.ts), which emits the
 * playback events.
 */
export interface EventsService extends AreaModule {
  /** The `AreaSeams.emitServerEvent` seam (see areas/module.ts). Never throws. */
  emitServerEvent(event: ServerEventInput): Promise<void>;
}

export function createEventsService(deps: ServiceDependencies): EventsService {
  return {
    ...NO_JOBS,
    // Not implemented yet: until this area stamps and stores server events, they are dropped
    // (and say so), so other areas can already call the seam.
    async emitServerEvent(event) {
      deps.logger.debug("events.server_event_dropped", {
        type: event.type,
        reason: "not_implemented",
      });
    },
  };
}
