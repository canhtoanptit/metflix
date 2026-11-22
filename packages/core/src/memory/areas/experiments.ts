import type { ExperimentsRepository } from "../../areas/experiments/repository.ts";

/** In-memory `ExperimentsRepository`: the experiments area fills it in with its methods. */
export function createMemoryExperimentsRepository(): ExperimentsRepository {
  return {};
}
