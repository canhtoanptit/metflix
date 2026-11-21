/**
 * @webflix/core: domain, ports and portable implementations. Web-standard APIs only.
 *
 * - Ports (interfaces) for every infrastructure dependency: `BlobStore`, `KeyValueCache`,
 *   `RateLimiter`, `StreamGate`, `JobQueue`, `SearchIndex`, `PasswordHasher`, `TokenSigner`,
 *   `Clock`, `IdGenerator`, `Logger`.
 * - Portable implementations that run in every mode: system clock, UUIDv7 ids, JSON logger,
 *   HMAC token signer, media tokens, PBKDF2 password hasher.
 * - Domain helpers: maturity, plans, cursors, `AppError`, config.
 *
 * In-memory adapters: `@webflix/core/memory`. Contract suites: `@webflix/core/testing`.
 */

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
export * from "./ports/ids.ts";
export * from "./ports/job-queue.ts";
export * from "./ports/logger.ts";
export * from "./ports/password-hasher.ts";
export * from "./ports/rate-limiter.ts";
export * from "./ports/search-index.ts";
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
} from "./services/subscriptions.ts";
