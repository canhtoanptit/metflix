/**
 * @webflix/dev-idp: a development OpenID Provider on Web-standard APIs only. Mount it under
 * `/dev-idp/*` when `WEBFLIX_ENV` is not production; it refuses to be constructed otherwise.
 * See README.md.
 */
export type {
  ClientAuthMethod,
  DevIdpClient,
  DevIdpLifetimes,
  DevIdpLogger,
  DevIdpOptions,
  DevIdpPersona,
  JsonValue,
  PersonaRoles,
  SignedClientSecret,
} from "./config.ts";
export {
  assertNonProductionEnvironment,
  DEFAULT_LIFETIMES,
  DevIdpConfigError,
  parsePrivateSigningJwk,
} from "./config.ts";
export {
  DEVELOPMENT_APPLE_CLIENT_KEY,
  DEVELOPMENT_KEY_SETS,
} from "./development-keys.ts";
export type {
  DevIdpFaults,
  FaultDefinition,
  FaultName,
  FaultScope,
  TokenTarget,
} from "./faults.ts";
export { FAULT_CATALOGUE, FAULT_NAMES } from "./faults.ts";
export type {
  DevIdpHost,
  DevIdpHostOptions,
  RealmOptions,
  WebflixDevIdpOptions,
  WebflixRealmsInput,
} from "./host.ts";
export {
  createDevIdpHost,
  createWebflixDevIdp,
  WEBFLIX_DEV_CLIENTS,
  webflixRealms,
} from "./host.ts";
export type { Jwk, PrivateSigningJwk, SigningAlgorithm } from "./jose.ts";
export { generateSigningJwk, toPublicJwk } from "./jose.ts";
export type { KeyStatus, SigningKeyInput } from "./keys.ts";
export {
  CONSUMER_PERSONAS,
  DEMO_ACCOUNT_EMAIL,
  STAFF_PERSONAS,
  STAFF_ROLE_CLIENT,
  STAFF_ROLES,
  type StaffRole,
} from "./personas.ts";
export { PROFILE_NAMES, PROFILES, type Profile, type ProfileName } from "./profiles.ts";
export type { DevIdp, FaultController, KeyController, MintTokensInput } from "./provider.ts";
export { createDevIdp } from "./provider.ts";
export type { Clock, DevIdpStore } from "./store.ts";
export { MemoryDevIdpStore, systemClock } from "./store.ts";
export type { TokenResponse } from "./tokens.ts";
