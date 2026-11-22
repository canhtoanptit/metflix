import { type AreaPorts, createBlobLakeEventSink } from "@webflix/core";
import { MemoryEventSink } from "@webflix/core/memory";
import type { AreaContext } from "./shared.ts";

/**
 * The events area's port in the Worker: in memory (per isolate), or the event lake in R2
 * (`WEBFLIX_EVENT_SINK=lake`). Owned by the events area.
 */
export function createEventsPorts(context: AreaContext): Pick<AreaPorts, "eventSink"> {
  return {
    eventSink:
      context.config.core.events.eventSink === "lake"
        ? createBlobLakeEventSink({ blobs: context.blobs, ids: context.ids })
        : new MemoryEventSink({ ids: context.ids }),
  };
}
