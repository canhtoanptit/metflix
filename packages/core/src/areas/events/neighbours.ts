import type { AreaServices } from "../index.ts";

/**
 * The other areas' services, as the events area asks them (resolved lazily: they are built
 * after it). Their data is reached through these, never their repositories: the member's plan
 * (`billing.currentPlan`), the account behind an export (`identity.getMemberIdentity`), and
 * every area's export and erasure hooks.
 */
export type OtherAreaServices = Omit<AreaServices, "events">;
export type OtherAreas = () => OtherAreaServices;
