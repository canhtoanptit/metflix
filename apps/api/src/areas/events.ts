import { type AreaPorts, createBlobLakeEventSink } from "@webflix/core";
import { MemoryEventSink } from "@webflix/core/memory";
import type { AreaContext } from "./shared.ts";

/**
 * The events area's port in the Node runtime: in memory, or the event lake in the mode's blob
 * store (`WEBFLIX_EVENT_SINK=lake`: `.data/blobs` in dev, the S3 bucket on k8s). Owned by the
 * events area.
 */
export function createEventsPorts(context: AreaContext): Pick<AreaPorts, "eventSink"> {
  return {
    eventSink:
      context.config.core.events.eventSink === "lake"
        ? createBlobLakeEventSink({ blobs: context.blobs, ids: context.ids })
        : new MemoryEventSink({ ids: context.ids }),
  };
}
