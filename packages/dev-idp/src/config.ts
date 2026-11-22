/**
 * Configuration of one issuer: what callers pass to `createDevIdp`, validated and normalised
 * once at construction so request handling never meets an invalid setting.
 */
import { DEVELOPMENT_KEY_SETS, DEVELOPMENT_RETIRED_KEYS } from "./development-keys.ts";
import { base64UrlDecode, randomBytes, utf8Encode } from "./encoding.ts";
import { type DevIdpFaults, normalizeFaults } from "./faults.ts";
import {
  assertPrivateSigningJwk,
  isSigningAlgorithm,
  type Jwk,
  type PrivateSigningJwk,
  type SigningAlgorithm,
} from "./jose.ts";
import { KeyRing, type SigningKeyInput } from "./keys.ts";
import { defaultPersonas } from "./personas.ts";
import { PROFILE_NAMES, PROFILES, type Profile, type ProfileName } from "./profiles.ts";
import { type Clock, type DevIdpStore, MemoryDevIdpStore, systemClock } from "./store.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Roles in the shape Keycloak puts them in access tokens. */
export interface PersonaRoles {
  /** `realm_access.roles` */
  realm?: readonly string[];
  /** `resource_access.<client>.roles` */
  clients?: Readonly<Record<string, readonly string[]>>;
}

export interface DevIdpPersona {
  /** Stable key, `[a-z0-9-]{1,64}`: what the sign-in page posts and tests name. */
  id: string;
  /** One line on the sign-in page saying what the persona is for. */
  description?: string;
  /** Defaults to a value derived from the issuer and `id`, shaped like the profile's. */
  sub?: string;
  /** `null`: the persona has no email claim at all. */
  email: string | null;
  /** Defaults to true when there is an email. */
  emailVerified?: boolean;
  /** A list makes the name change on every sign-in (cycling), as people rename accounts. */
  name?: string | readonly string[] | null;
  /** Defaults to an avatar the issuer serves itself. `null`: no picture claim. */
  picture?: string | null;
  /** Apple's private relay addresses. */
  isPrivateEmail?: boolean;
  roles?: PersonaRoles;
  /** Extra claims for the ID token, access token and userinfo. Cannot override protocol claims. */
  claims?: Readonly<Record<string, JsonValue>>;
}

export type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

/**
 * Apple's client authentication: `client_secret` is a short-lived ES256 JWT the relying party
 * signs with a key registered with the provider (`iss` team id, `sub` client id, `aud` issuer).
 */
export interface SignedClientSecret {
  teamId: string;
  keyId: string;
  /** The public half of the relying party's P-256 key. */
  publicKey: Jwk;
  /** Longest lifetime (`exp - iat`) accepted. Apple: six months (15777000 s). */
  maxLifetimeSec?: number;
}

export interface DevIdpClient {
  clientId: string;
  /** Shown on the sign-in page. */
  displayName?: string;
  /** Exact-match list. Query strings are allowed (and kept); fragments are not. */
  redirectUris: readonly string[];
  postLogoutRedirectUris?: readonly string[];
  /**
   * Accepted methods. Defaults: `["none"]` for a client without a secret, otherwise
   * `["client_secret_basic"]` (or `["client_secret_post"]` with `signedClientSecret`).
   */
  tokenEndpointAuthMethods?: readonly ClientAuthMethod[];
  /** A shared secret (at least 16 characters). */
  clientSecret?: string;
  /** Apple-style JWT client secret instead of a shared one. */
  signedClientSecret?: SignedClientSecret;
  /** Defaults to RS256 (Google, Apple and Keycloak all sign ID tokens with RS256 by default). */
  idTokenSignedResponseAlg?: SigningAlgorithm;
  accessTokenSignedResponseAlg?: SigningAlgorithm;
  /** Defaults to the profile's. */
  accessTokenFormat?: "jwt" | "opaque";
  /** `aud` of JWT access tokens. Defaults to the client id. */
  accessTokenAudience?: string | readonly string[];
  /** Defaults to every scope the profile supports. */
  allowedScopes?: readonly string[];
  /** PKCE (S256) for confidential clients too. Default true; always required for public clients. */
  requirePkce?: boolean;
  /** Refuse authorisation requests without `state`. Default true. */
  requireState?: boolean;
  /** Refuse authorisation requests without `nonce`. Default true. */
  requireNonce?: boolean;
  /** Browser origins allowed to call the token and userinfo endpoints. Default: the redirect URIs' origins. */
  allowedCorsOrigins?: readonly string[];
  /**
   * A service account: the client-credentials grant (RFC 6749 §4.4) issues this client an access
   * token for itself, shaped like a Keycloak service account's (`preferred_username:
   * service-account-<clientId>`, `azp`, the roles below). Confidential clients only, on a profile
   * with the grant (generic, keycloak); such a client needs no redirect URI.
   */
  serviceAccount?: { roles?: PersonaRoles };
}

export interface DevIdpLifetimes {
  codeSec: number;
  /** How long the sign-in page stays usable. */
  transactionSec: number;
  idTokenSec: number;
  accessTokenSec: number;
  refreshTokenSec: number;
  /** Absolute limit for a chain of rotated refresh tokens. */
  refreshFamilySec: number;
  sessionSec: number;
}

export const DEFAULT_LIFETIMES: DevIdpLifetimes = {
  codeSec: 60,
  transactionSec: 600,
  idTokenSec: 600,
  accessTokenSec: 300,
  refreshTokenSec: 12 * 3600,
  refreshFamilySec: 24 * 3600,
  sessionSec: 12 * 3600,
};

export interface DevIdpLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface DevIdpOptions {
  /**
   * The issuer identifier, exactly as relying parties configure it: `http(s)://host[:port][/path]`
   * without a trailing slash. Requests are routed by this path, so mount the handler where the
   * issuer's path is served. Never derived from the request's Host header.
   */
  issuer: string;
  /** `WEBFLIX_ENV`. Only `development` and `test` are accepted: anything else throws. */
  environment: string;
  profile?: ProfileName;
  clients: readonly DevIdpClient[];
  /** Defaults to the profile's shipped personas. */
  personas?: readonly DevIdpPersona[];
  /**
   * Private JWKs. Defaults to the profile's shipped development keys, so every process, replica
   * and isolate of a local mode signs alike. Per algorithm, the first key is `current`.
   */
  keys?: readonly (PrivateSigningJwk | SigningKeyInput)[];
  /**
   * Seals codes, sessions and refresh tokens (32+ characters). Defaults to random bytes per
   * instance: fine for one process; replicas and Workers isolates must share one.
   */
  secret?: string;
  /** Default `"memory"` (strict within one process). `"none"` is stateless: see the README. */
  store?: DevIdpStore | "memory" | "none";
  clock?: Clock;
  lifetimes?: Partial<DevIdpLifetimes>;
  /** Faults active from the start (see `idp.faults`). */
  faults?: DevIdpFaults;
  /** Offer fault injection on the sign-in page. Default true. */
  faultPicker?: boolean;
  logger?: DevIdpLogger;
}

export interface NormalizedClient {
  clientId: string;
  displayName: string;
  redirectUris: readonly string[];
  postLogoutRedirectUris: readonly string[];
  authMethods: readonly ClientAuthMethod[];
  clientSecret: string | null;
  signedClientSecret: Required<SignedClientSecret> | null;
  idTokenAlg: SigningAlgorithm;
  accessTokenAlg: SigningAlgorithm;
  accessTokenFormat: "jwt" | "opaque";
  accessTokenAudience: string | readonly string[];
  allowedScopes: readonly string[];
  requirePkce: boolean;
  requireState: boolean;
  requireNonce: boolean;
  corsOrigins: readonly string[];
  public: boolean;
  serviceAccount: { roles: PersonaRoles } | null;
}

export interface NormalizedConfig {
  issuer: string;
  issuerUrl: URL;
  /** The issuer's path without a trailing slash: "" at the root. */
  basePath: string;
  profile: Profile;
  clients: ReadonlyMap<string, NormalizedClient>;
  personas: readonly DevIdpPersona[];
  ring: KeyRing;
  secret: Uint8Array<ArrayBuffer>;
  store: DevIdpStore | null;
  clock: Clock;
  lifetimes: DevIdpLifetimes;
  faults: DevIdpFaults;
  faultPicker: boolean;
  logger: DevIdpLogger | null;
}

export class DevIdpConfigError extends Error {
  override name = "DevIdpConfigError";
}

const ALLOWED_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * The hard guard: the development issuer signs anyone in as anyone, so it must never exist in
 * production. An allow-list, so a typo or an unset variable fails closed too.
 */
export function assertNonProductionEnvironment(environment: unknown): void {
  if (typeof environment !== "string" || !ALLOWED_ENVIRONMENTS.has(environment)) {
    throw new DevIdpConfigError(
      `The development issuer refuses to start in environment ${JSON.stringify(environment)}: ` +
        "it is only for development and test.",
    );
  }
}

const CLIENT_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const PERSONA_ID = /^[a-z0-9-]{1,64}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,63}$/;
/** Claims only the issuer sets; persona `claims` may not override them. */
const PROTOCOL_CLAIMS = new Set([
  "iss",
  "sub",
  "aud",
  "exp",
  "iat",
  "nbf",
  "auth_time",
  "nonce",
  "at_hash",
  "c_hash",
  "azp",
  "sid",
  "jti",
  "typ",
  "scope",
  "client_id",
  "acr",
  "amr",
  "cnf",
  "realm_access",
  "resource_access",
]);

export function isValidEmail(value: string): boolean {
  // No control or invisible formatting characters (NUL, bidi overrides): relying parties store it.
  return value.length <= 254 && EMAIL.test(value) && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validateRedirectUri(uri: string, what: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new DevIdpConfigError(`${what} is not an absolute URL: ${uri}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DevIdpConfigError(`${what} must be http or https: ${uri}`);
  }
  if (uri.includes("#")) throw new DevIdpConfigError(`${what} must not have a fragment: ${uri}`);
  if (uri.length > 2048) throw new DevIdpConfigError(`${what} is longer than 2048 characters`);
}

function normalizeIssuer(issuer: string): { issuer: string; url: URL; basePath: string } {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new DevIdpConfigError(`issuer is not an absolute URL: ${issuer}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DevIdpConfigError("issuer must be an http or https URL");
  }
  if (url.search || url.hash || issuer.includes("?") || issuer.includes("#")) {
    throw new DevIdpConfigError("issuer must not have a query or fragment");
  }
  if (url.username || url.password) throw new DevIdpConfigError("issuer must not have credentials");
  if (issuer.endsWith("/")) throw new DevIdpConfigError("issuer must not end with a slash");
  // The string relying parties compare with `iss` must be exactly what we put there.
  const canonical = `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  if (canonical !== issuer) {
    throw new DevIdpConfigError(`issuer is not in canonical form (expected ${canonical})`);
  }
  return { issuer, url, basePath: url.pathname === "/" ? "" : url.pathname };
}

function normalizeClient(
  client: DevIdpClient,
  profile: Profile,
  algorithms: readonly SigningAlgorithm[],
): NormalizedClient {
  const id = client.clientId;
  if (!CLIENT_ID.test(id)) {
    throw new DevIdpConfigError(`Client id ${JSON.stringify(id)} must match ${CLIENT_ID}`);
  }
  if (client.redirectUris.length === 0 && !client.serviceAccount) {
    throw new DevIdpConfigError(`Client ${id} needs at least one redirect URI`);
  }
  for (const uri of client.redirectUris) validateRedirectUri(uri, `Client ${id} redirect URI`);
  for (const uri of client.postLogoutRedirectUris ?? []) {
    validateRedirectUri(uri, `Client ${id} post-logout redirect URI`);
  }
  if (client.clientSecret !== undefined && client.signedClientSecret !== undefined) {
    throw new DevIdpConfigError(`Client ${id}: use clientSecret or signedClientSecret, not both`);
  }
  if (client.clientSecret !== undefined && client.clientSecret.length < 16) {
    throw new DevIdpConfigError(`Client ${id}: clientSecret needs at least 16 characters`);
  }
  const hasSecret = client.clientSecret !== undefined || client.signedClientSecret !== undefined;
  const methods: readonly ClientAuthMethod[] =
    client.tokenEndpointAuthMethods ??
    (!hasSecret
      ? ["none"]
      : client.signedClientSecret
        ? ["client_secret_post"]
        : ["client_secret_basic"]);
  if (methods.length === 0) throw new DevIdpConfigError(`Client ${id}: no authentication method`);
  const isPublic = methods.includes("none");
  if (isPublic && (methods.length > 1 || hasSecret)) {
    throw new DevIdpConfigError(`Client ${id}: a public client ("none") has no secret`);
  }
  if (!isPublic && !hasSecret) {
    throw new DevIdpConfigError(`Client ${id}: ${methods.join(", ")} needs a client secret`);
  }
  if (isPublic && client.requirePkce === false) {
    throw new DevIdpConfigError(`Client ${id}: public clients always use PKCE`);
  }
  if (client.serviceAccount) {
    if (!profile.clientCredentials) {
      throw new DevIdpConfigError(
        `Client ${id}: the ${profile.name} profile has no client-credentials grant`,
      );
    }
    if (isPublic || client.clientSecret === undefined) {
      throw new DevIdpConfigError(`Client ${id}: a service account needs a client secret`);
    }
  }
  let signed: Required<SignedClientSecret> | null = null;
  if (client.signedClientSecret) {
    const { teamId, keyId, publicKey, maxLifetimeSec = 15_777_000 } = client.signedClientSecret;
    if (publicKey.kty !== "EC" || publicKey.crv !== "P-256" || publicKey.d !== undefined) {
      throw new DevIdpConfigError(
        `Client ${id}: signedClientSecret.publicKey must be a public P-256 JWK`,
      );
    }
    if (!teamId || !keyId)
      throw new DevIdpConfigError(`Client ${id}: teamId and keyId are required`);
    signed = { teamId, keyId, publicKey, maxLifetimeSec };
  }
  const idTokenAlg = client.idTokenSignedResponseAlg ?? "RS256";
  const accessTokenAlg = client.accessTokenSignedResponseAlg ?? idTokenAlg;
  for (const alg of [idTokenAlg, accessTokenAlg]) {
    if (!isSigningAlgorithm(alg))
      throw new DevIdpConfigError(`Client ${id}: unsupported alg ${alg}`);
    if (!algorithms.includes(alg)) {
      throw new DevIdpConfigError(
        `Client ${id} signs with ${alg} but the issuer has no ${alg} key`,
      );
    }
  }
  const allowedScopes = client.allowedScopes ?? profile.scopes;
  for (const scope of allowedScopes) {
    if (!profile.scopes.includes(scope)) {
      throw new DevIdpConfigError(
        `Client ${id}: scope ${scope} is not supported by the ${profile.name} profile`,
      );
    }
  }
  const corsOrigins = client.allowedCorsOrigins ?? [
    ...new Set(client.redirectUris.map((uri) => new URL(uri).origin)),
  ];
  return {
    clientId: id,
    displayName: client.displayName ?? id,
    redirectUris: [...client.redirectUris],
    postLogoutRedirectUris: [...(client.postLogoutRedirectUris ?? [])],
    authMethods: methods,
    clientSecret: client.clientSecret ?? null,
    signedClientSecret: signed,
    idTokenAlg,
    accessTokenAlg,
    accessTokenFormat: client.accessTokenFormat ?? profile.accessTokenFormat,
    accessTokenAudience: client.accessTokenAudience ?? id,
    allowedScopes,
    requirePkce: isPublic || client.requirePkce !== false,
    requireState: client.requireState !== false,
    requireNonce: client.requireNonce !== false,
    corsOrigins,
    public: isPublic,
    serviceAccount: client.serviceAccount ? { roles: client.serviceAccount.roles ?? {} } : null,
  };
}

function validatePersonas(personas: readonly DevIdpPersona[]): void {
  const ids = new Set<string>();
  for (const persona of personas) {
    if (!PERSONA_ID.test(persona.id)) {
      throw new DevIdpConfigError(
        `Persona id ${JSON.stringify(persona.id)} must match ${PERSONA_ID}`,
      );
    }
    if (ids.has(persona.id)) throw new DevIdpConfigError(`Duplicate persona ${persona.id}`);
    ids.add(persona.id);
    if (persona.email !== null && !isValidEmail(persona.email)) {
      throw new DevIdpConfigError(`Persona ${persona.id}: invalid email`);
    }
    if (persona.sub !== undefined && !/^[\x21-\x7e]{1,255}$/.test(persona.sub)) {
      throw new DevIdpConfigError(
        `Persona ${persona.id}: sub must be 1-255 printable ASCII characters`,
      );
    }
    if (Array.isArray(persona.name) && persona.name.length === 0) {
      throw new DevIdpConfigError(`Persona ${persona.id}: an empty list of names`);
    }
    for (const claim of Object.keys(persona.claims ?? {})) {
      if (PROTOCOL_CLAIMS.has(claim)) {
        throw new DevIdpConfigError(`Persona ${persona.id}: claim ${claim} is set by the issuer`);
      }
    }
  }
}

function signingKeys(keys: DevIdpOptions["keys"], profile: ProfileName): SigningKeyInput[] {
  if (keys) {
    return keys.map((key) => ("jwk" in key ? key : { jwk: key as PrivateSigningJwk }));
  }
  return [
    ...DEVELOPMENT_KEY_SETS[profile].map((jwk) => ({ jwk: jwk as PrivateSigningJwk })),
    ...DEVELOPMENT_RETIRED_KEYS.map((jwk) => ({
      jwk: jwk as PrivateSigningJwk,
      status: "retired" as const,
    })),
  ];
}

function secretBytes(secret: string | undefined): Uint8Array<ArrayBuffer> {
  if (secret === undefined) return randomBytes(32);
  if (secret.length < 32) throw new DevIdpConfigError("secret needs at least 32 characters");
  return utf8Encode(secret);
}

function positiveLifetimes(input: Partial<DevIdpLifetimes> | undefined): DevIdpLifetimes {
  const lifetimes = { ...DEFAULT_LIFETIMES, ...input };
  for (const [name, value] of Object.entries(lifetimes)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new DevIdpConfigError(`lifetimes.${name} must be a positive integer (seconds)`);
    }
  }
  if (lifetimes.codeSec > 600) throw new DevIdpConfigError("lifetimes.codeSec is at most 600");
  return lifetimes;
}

export function normalizeConfig(options: DevIdpOptions): NormalizedConfig {
  assertNonProductionEnvironment(options.environment);
  const { issuer, url, basePath } = normalizeIssuer(options.issuer);
  const profileName = options.profile ?? "generic";
  if (!PROFILE_NAMES.includes(profileName)) {
    throw new DevIdpConfigError(`Unknown profile ${JSON.stringify(profileName)}`);
  }
  const profile = PROFILES[profileName];
  const ring = new KeyRing(signingKeys(options.keys, profileName));
  const algorithms = ring.algorithms();
  if (algorithms.length === 0) throw new DevIdpConfigError("No current signing key");

  const clients = new Map<string, NormalizedClient>();
  for (const client of options.clients) {
    if (clients.has(client.clientId)) {
      throw new DevIdpConfigError(`Duplicate client ${client.clientId}`);
    }
    clients.set(client.clientId, normalizeClient(client, profile, algorithms));
  }
  if (clients.size === 0) throw new DevIdpConfigError("At least one client is required");

  const personas = options.personas ?? defaultPersonas(profileName);
  validatePersonas(personas);

  const clock = options.clock ?? systemClock;
  const store =
    options.store === "none"
      ? null
      : options.store === undefined || options.store === "memory"
        ? new MemoryDevIdpStore({ clock })
        : options.store;
  let faults: DevIdpFaults;
  try {
    faults = normalizeFaults(options.faults ?? {});
  } catch (error) {
    throw new DevIdpConfigError(error instanceof Error ? error.message : String(error));
  }
  if (faults.codeReplay && !store) throw new DevIdpConfigError("Fault codeReplay needs a store");
  return {
    issuer,
    issuerUrl: url,
    basePath,
    profile,
    clients,
    personas,
    ring,
    secret: secretBytes(options.secret),
    store,
    clock,
    lifetimes: positiveLifetimes(options.lifetimes),
    faults,
    faultPicker: options.faultPicker !== false,
    logger: options.logger ?? null,
  };
}

/** Validates a private JWK handed in from configuration (for example an environment variable). */
export function parsePrivateSigningJwk(value: unknown): PrivateSigningJwk {
  assertPrivateSigningJwk(value);
  // Fail at startup rather than at the first signature.
  base64UrlDecode(value.d);
  return value;
}
