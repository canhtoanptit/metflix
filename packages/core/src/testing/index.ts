/**
 * @webflix/core/testing: reusable contract suites, one per port. Every adapter must pass the
 * suite for its port, in the runtime it ships to (Node for adapters-node, workerd for
 * adapters-cloudflare). Imports vitest; never import this from production code.
 *
 * ```ts
 * describeBlobStoreContract("filesystem", async () => {
 *   const root = await mkdtemp(...);
 *   return { store: createFsBlobStore({ root }), cleanup: () => rm(root, { recursive: true }) };
 * });
 * ```
 */
export { ManualClock } from "../ports/clock.ts";
export { MemoryLogger } from "../ports/logger.ts";
export {
  type AdminRepositoryHarness,
  describeAdminRepositoryContract,
} from "./areas/admin.contract.ts";
export {
  type BillingRepositoryHarness,
  describeBillingRepositoryContract,
  makeCheckoutRecord,
  makeMembershipRecord,
} from "./areas/billing.contract.ts";
export {
  describeEventsRepositoryContract,
  type EventsRepositoryHarness,
} from "./areas/events.contract.ts";
export {
  describeExperimentsRepositoryContract,
  type ExperimentsRepositoryHarness,
} from "./areas/experiments.contract.ts";
export {
  describeIdentityRepositoryContract,
  type IdentityRepositoryHarness,
} from "./areas/identity.contract.ts";
export {
  describePersonalisationRepositoryContract,
  type PersonalisationRepositoryHarness,
} from "./areas/personalisation.contract.ts";
export { type BlobStoreHarness, describeBlobStoreContract } from "./blob-store.contract.ts";
export { describeKeyValueCacheContract, type KeyValueCacheHarness } from "./cache.contract.ts";
export {
  describeEmailSenderContract,
  type EmailSenderHarness,
} from "./email-sender.contract.ts";
export { describeEventSinkContract, type EventSinkHarness } from "./event-sink.contract.ts";
export {
  describeExperimentsContract,
  type ExperimentsHarness,
  experimentDefinition,
} from "./experiments.contract.ts";
export * from "./fixture-catalog.ts";
export {
  bytesOf,
  type HarnessBase,
  type HarnessFactory,
  readAll,
  type TimeControl,
  useHarness,
} from "./harness.ts";
export * from "./identity-federation.suite.ts";
export {
  describeIdentityProviderContract,
  type IdentityProviderHarness,
  type IdentitySignIn,
} from "./identity-provider.contract.ts";
export {
  describeJobQueueContract,
  type JobQueueHarness,
  type JobQueueHarnessFactory,
} from "./job-queue.contract.ts";
export * from "./oidc-relying-party.suite.ts";
export {
  describePasswordHasherContract,
  type PasswordHasherHarness,
} from "./password-hasher.contract.ts";
export {
  describePaymentProviderContract,
  type PaymentProviderHarness,
} from "./payment-provider.contract.ts";
export { describeRateLimiterContract, type RateLimiterHarness } from "./rate-limiter.contract.ts";
export {
  describeRecommendationStoreContract,
  type RecommendationStoreHarness,
} from "./recommendation-store.contract.ts";
export * from "./records.ts";
export {
  type RecsVersionInput,
  type WrittenRecsVersion,
  writeRecsVersion,
} from "./recs-artefacts.ts";
export {
  describeRepositoryContract,
  type RepositoryHarness,
} from "./repositories.contract.ts";
export {
  describeSearchIndexContract,
  SEARCH_CONTRACT_CORPUS,
  type SearchIndexHarness,
} from "./search-index.contract.ts";
export {
  createTestServices,
  subscribeForTest,
  TEST_NOW,
  type TestServices,
  type TestServicesOptions,
} from "./services.ts";
export {
  describeStaffVerifierContract,
  type StaffTokenRequest,
  type StaffVerifierHarness,
} from "./staff-verifier.contract.ts";
export { describeStreamGateContract, type StreamGateHarness } from "./stream-gate.contract.ts";
export { describeTokenSignerContract, type TokenSignerHarness } from "./token-signer.contract.ts";
