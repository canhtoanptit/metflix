/**
 * What the identity area exports from `@webflix/core` (re-exported by the package index, so the
 * area adds exports here without touching the shared index).
 */
export * from "./email.ts";
export * from "./jose.ts";
export * from "./oidc.ts";
export * from "./outbox.ts";
export * from "./providers.ts";
export * from "./repository.ts";
export * from "./seal.ts";
export {
  type ChargeRecipient,
  type IdentityService,
  type MemberIdentity,
  type MemberIdentitySummary,
  OIDC_TRANSACTION_TTL_SEC,
  type OidcCompletion,
  type OidcStart,
} from "./service.ts";
export { presentIdentityAccount, type SessionIssuer } from "./sessions.ts";
