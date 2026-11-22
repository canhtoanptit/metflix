import type { PersonalisationRepository } from "../../areas/personalisation/repository.ts";

/** In-memory `PersonalisationRepository`: the personalisation area fills it in with its methods. */
export function createMemoryPersonalisationRepository(): PersonalisationRepository {
  return {};
}
