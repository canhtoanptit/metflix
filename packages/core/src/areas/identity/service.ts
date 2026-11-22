import type { ServiceDependencies } from "../../services/context.ts";
import { type AreaModule, type AreaSeams, NO_JOBS } from "../module.ts";

/**
 * The identity area (milestone 2 §4, §8.2): federated sign-in through `deps.identityProviders`,
 * linked identities, the account-holder proof (`sessions.elevated_until`, granted only by
 * services/credentials.ts), email verification, password reset, and sending email through
 * `deps.email` as jobs with idempotency keys. Emits `auth.signin` / `auth.signup` through
 * `seams.emitServerEvent`. Milestone 1's sign-in, profiles and devices (services/auth.ts,
 * profiles.ts, credentials.ts, privileges.ts) are this area's too.
 *
 * Skeleton: the routes of this area answer `not_implemented` until their handlers call methods
 * added here.
 */
export interface IdentityService extends AreaModule {}

export function createIdentityService(
  _deps: ServiceDependencies,
  _seams: AreaSeams,
): IdentityService {
  return { ...NO_JOBS };
}
