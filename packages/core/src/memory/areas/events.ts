import type { EventsRepository } from "../../areas/events/repository.ts";

/** In-memory `EventsRepository`: the events area fills it in with its methods. */
export function createMemoryEventsRepository(): EventsRepository {
  return {};
}
