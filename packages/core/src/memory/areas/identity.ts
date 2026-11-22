import type { IdentityRepository } from "../../areas/identity/repository.ts";

/** In-memory `IdentityRepository`: the identity area fills it in with its methods. */
export function createMemoryIdentityRepository(): IdentityRepository {
  return {};
}
