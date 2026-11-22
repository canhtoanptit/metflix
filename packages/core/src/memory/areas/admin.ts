import type { AdminRepository } from "../../areas/admin/repository.ts";

/** In-memory `AdminRepository`: the admin area fills it in with its methods. */
export function createMemoryAdminRepository(): AdminRepository {
  return {};
}
