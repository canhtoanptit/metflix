/**
 * @webflix/core: domain, ports and portable implementations. Web-standard APIs only.
 *
 * - Ports (interfaces) for every infrastructure dependency: `BlobStore`, `KeyValueCache`,
 *   `RateLimiter`, `StreamGate`, `JobQueue`, `SearchIndex`, `PasswordHasher`, `TokenSigner`,
 *   `Clock`, `IdGenerator`, `Logger`; milestone 2's `IdentityProvider`, `PaymentProvider`,
 *   `EmailSender`, `EventSink`, `RecommendationStore`, `Experiments`, `StaffVerifier`.
 * - Portable implementations that run in every mode: system clock, UUIDv7 ids, JSON logger,
 *   HMAC token signer, media tokens, PBKDF2 password hasher.
 * - Domain helpers: maturity, plans, cursors, `AppError`, config.
 *
 * In-memory adapters: `@webflix/core/memory`. Contract suites: `@webflix/core/testing`.
 */

export * from "./areas/admin/config.ts";
export * from "./areas/admin/public.ts";
export type { AdminRepository } from "./areas/admin/repository.ts";
export type { AdminService } from "./areas/admin/service.ts";
export * from "./areas/billing/config.ts";
export type * from "./areas/billing/repository.ts";
export type { BillingService } from "./areas/billing/service.ts";
export type { AreaConfigInput, AreaConfigResult } from "./areas/config.ts";
export * from "./areas/events/config.ts";
export * from "./areas/events/repository.ts";
export type * from "./areas/events/service.ts";
export * from "./areas/experiments/audit.ts";
export * from "./areas/experiments/config.ts";
export * from "./areas/experiments/definitions.ts";
export * from "./areas/experiments/repository.ts";
export type { ExperimentsService } from "./areas/experiments/service.ts";
export * from "./areas/identity/config.ts";
export * from "./areas/identity/public.ts";
export type { AreaServices } from "./areas/index.ts";
export {
  type AreaModule,
  type AreaSeams,
  NO_JOBS,
  type ServerEventInput,
} from "./areas/module.ts";
export * from "./areas/personalisation/config.ts";
export * from "./areas/personalisation/importer.ts";
export * from "./areas/personalisation/repository.ts";
export type { PersonalisationService } from "./areas/personalisation/service.ts";
export type { AreaPorts } from "./areas/ports.ts";
export * from "./catalog/cache.ts";
export * from "./catalog/snapshot.ts";
export * from "./config.ts";
export * from "./domain/cursor.ts";
export * from "./domain/maturity.ts";
export * from "./domain/plans.ts";
export * from "./encoding.ts";
export * from "./errors.ts";
export * from "./ports/blob-store.ts";
export * from "./ports/cache.ts";
export * from "./ports/clock.ts";
export * from "./ports/email-sender.ts";
export * from "./ports/event-sink.ts";
export * from "./ports/experiments.ts";
export * from "./ports/identity-provider.ts";
export * from "./ports/ids.ts";
export * from "./ports/job-queue.ts";
export * from "./ports/logger.ts";
export * from "./ports/password-hasher.ts";
export * from "./ports/payment-provider.ts";
export * from "./ports/rate-limiter.ts";
export * from "./ports/recommendation-store.ts";
export * from "./ports/search-index.ts";
export * from "./ports/staff-verifier.ts";
export * from "./ports/stream-gate.ts";
export * from "./ports/token-signer.ts";
export * from "./recommendations/engine.ts";
export * from "./recommendations/features.ts";
export * from "./recommendations/hash.ts";
export * from "./repositories/ports.ts";
export * from "./repositories/records.ts";
export type { AccountService, ChangePlanInput, UpdateAccountInput } from "./services/account.ts";
export { type AuthService, hashSessionToken, type IssuedSession } from "./services/auth.ts";
export { type BrowseService, ROW_FIRST_PAGE, ROWS_PER_BATCH } from "./services/browse.ts";
export type {
  AuthContext,
  ClientInfo,
  ServiceDependencies,
  ServiceState,
  Viewer,
} from "./services/context.ts";
export type { ChargeCredentialCheck } from "./services/credentials.ts";
export { describeDevice } from "./services/device.ts";
export { createServices, type Services } from "./services/index.ts";
export {
  baselineStat,
  baselineStats,
  createJobBindings,
  createScheduler,
  playbackCleanupJob,
  type Scheduler,
  SESSION_CLEANUP_BATCH,
  sessionCleanupJob,
  statsBaselineJob,
  statsRollupJob,
} from "./services/jobs.ts";
export type { LibraryService } from "./services/library.ts";
export {
  capMasterPlaylist,
  type HeartbeatInput,
  type MediaAccess,
  type PlaybackService,
  renditionsAboveCap,
  type StartPlaybackInput,
} from "./services/playback.ts";
export {
  DEMO_ACCOUNT_ID,
  isDemoAccount,
  type ProfileStanding,
  parentalControlsInUse,
  requireAccountHolder,
  standingOf,
} from "./services/privileges.ts";
export type {
  CreateProfileInput,
  DeleteProfileInput,
  ProfileService,
  UpdateProfileInput,
} from "./services/profiles.ts";
export type { SearchService } from "./services/search.ts";
export {
  buildCatalogWrite,
  buildSearchDocuments,
  SEED_HASH_KEY,
  type Seeder,
  type SeedInput,
  type SeedResult,
  seedHash,
} from "./services/seed.ts";
export {
  BILLING_PERIOD_MS,
  type BillingProvider,
  type CardInput,
  type ChargeResult,
  cardBrand,
  createMockBillingProvider,
  type DeclineReason,
  effectiveSubscription,
  playbackEntitlement,
} from "./services/subscriptions.ts";
