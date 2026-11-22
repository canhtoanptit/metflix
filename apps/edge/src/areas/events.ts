import { createR2BlobStore } from "@webflix/adapters-cloudflare";
import { type AreaPorts, createBlobLakeEventSink } from "@webflix/core";
import { MemoryEventSink } from "@webflix/core/memory";
import type { AreaContext } from "./shared.ts";

/**
 * The events area's port in the Worker: in memory (per isolate: nothing outlives the isolate,
 * so only for tests), or the event lake in R2 (`WEBFLIX_EVENT_SINK=lake`). The lake uses the R2
 * binding directly, never the edge-cached media store: reads through the media cache are keyed
 * by media generation, so a deleted export document could still be served from the cache.
 * Owned by the events area.
 */
export function createEventsPorts(context: AreaContext): Pick<AreaPorts, "eventSink"> {
  return {
    eventSink:
      context.config.core.events.eventSink === "lake"
        ? createBlobLakeEventSink({ blobs: createR2BlobStore(context.env.MEDIA), ids: context.ids })
        : new MemoryEventSink({ ids: context.ids }),
  };
}
