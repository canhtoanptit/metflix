/**
 * Minting the token response (ID token, access token, refresh token) for a grant, with faults
 * applied, and verifying tokens this issuer signed (userinfo, `id_token_hint`).
 */
import type { NormalizedClient } from "./config.ts";
import { endpoint, type IssuerContext, nowSec, storeKey } from "./context.ts";
import { DEVELOPMENT_UNPUBLISHED_KEYS } from "./development-keys.ts";
import { randomToken, utf8Encode } from "./encoding.ts";
import {
  type DevIdpFaults,
  FAULT_CATALOGUE,
  FAULT_NAMES,
  type TokenTarget,
  targets,
} from "./faults.ts";
import {
  decodeJws,
  generateSigningJwk,
  hmacJws,
  importSigningKey,
  isSigningAlgorithm,
  leftHalfHash,
  type PrivateSigningJwk,
  publicKeyPem,
  type SigningAlgorithm,
  signJws,
  toPublicJwk,
  unsecuredJws,
  verifyJws,
} from "./jose.ts";
import { type Identity, type PersonaRef, resolveIdentity } from "./personas.ts";

/** One authorisation: what a code, and every refresh token rotated from it, carries. */
export interface Grant {
  /** The code's id; also the id of the refresh-token family and of the grant's revocation marker. */
  grantId: string;
  clientId: string;
  scopes: readonly string[];
  nonce: string | null;
  authTime: number;
  sid: string;
  ref: PersonaRef;
  nameIndex: number;
  /** Google's `access_type=offline`. */
  offline: boolean;
  /** Absolute expiry of the refresh-token family (seconds). */
  familyExp: number;
}

/** The identity faults a flow carries into later userinfo calls (sealed access tokens). */
export type IdentityFaults = Pick<
  DevIdpFaults,
  "subjectChanged" | "emailUnverified" | "emailVerifiedAbsent"
>;

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  id_token?: string;
  refresh_token?: string;
}

type Claims = Record<string, unknown>;

const unpublishedKeys = new Map<string, CryptoKey>();

async function unpublishedKey(
  alg: SigningAlgorithm,
): Promise<{ jwk: PrivateSigningJwk; key: CryptoKey }> {
  const jwk = DEVELOPMENT_UNPUBLISHED_KEYS.find(
    (candidate) => candidate.alg === alg,
  ) as PrivateSigningJwk;
  let key = unpublishedKeys.get(jwk.kid);
  if (!key) {
    key = await importSigningKey(jwk);
    unpublishedKeys.set(jwk.kid, key);
  }
  return { jwk, key };
}

/**
 * Fault `jwksRotatedMidFlow`: the tokens of one response are signed with a key published only
 * now. One late key per algorithm per response; the issuer's current key does not change.
 */
type LateKeys = Map<SigningAlgorithm, PrivateSigningJwk> | null;

/** Signs `claims` as the issuer would, unless a signature fault says otherwise. */
async function sign(
  context: IssuerContext,
  typ: string,
  claims: Claims,
  alg: SigningAlgorithm,
  faults: DevIdpFaults,
  token: "id_token" | "access_token",
  late: LateKeys,
): Promise<string> {
  const ring = context.ring;
  if (targets(faults.algNone, token)) return unsecuredJws({ typ }, claims);
  if (targets(faults.hmacKeyConfusion, token)) {
    const current = ring.current(alg);
    const pem = await publicKeyPem(current, alg);
    return hmacJws({ typ, kid: current.kid }, claims, utf8Encode(pem));
  }
  if (targets(faults.unknownKey, token)) {
    const { jwk, key } = await unpublishedKey(alg);
    return signJws({ alg, typ, kid: jwk.kid }, claims, key);
  }
  if (targets(faults.embeddedJwk, token)) {
    const { jwk, key } = await unpublishedKey(alg);
    return signJws({ alg, typ, kid: jwk.kid, jwk: toPublicJwk(jwk) }, claims, key);
  }
  let jwk = ring.current(alg);
  if (late) {
    let key = late.get(alg);
    if (!key) {
      key = await ring.publishLate(alg);
      late.set(alg, key);
    }
    jwk = key;
  }
  if (targets(faults.removedKey, token)) {
    let retired = ring.retired(alg);
    if (!retired) {
      // A ring configured without a retired key: publish a fresh one, then remove it.
      retired = await generateSigningJwk(alg);
      ring.addRetired(retired);
    }
    jwk = retired;
  }
  return signJws({ alg, typ, kid: jwk.kid }, claims, await ring.signingKey(jwk));
}

function anotherClientId(context: IssuerContext, clientId: string): string {
  for (const id of context.clients.keys()) if (id !== clientId) return id;
  return "another-client";
}

/** Claim faults shared by ID tokens and JWT access tokens. */
function applyClaimFaults(
  context: IssuerContext,
  claims: Claims,
  client: NormalizedClient,
  faults: DevIdpFaults,
  token: "id_token" | "access_token",
  lifetimeSec: number,
): void {
  const now = nowSec(context);
  if (targets(faults.wrongIssuer, token)) claims.iss = `${context.issuer}-mixup`;
  if (targets(faults.wrongAudience, token)) claims.aud = anotherClientId(context, client.clientId);
  if (targets(faults.extraAudience, token)) {
    const audiences = Array.isArray(claims.aud) ? (claims.aud as string[]) : [String(claims.aud)];
    claims.aud = [...audiences, anotherClientId(context, client.clientId)];
    claims.azp = client.clientId;
  }
  if (targets(faults.expired, token)) {
    claims.iat = now - 3600;
    claims.exp = now - 600;
    if (typeof claims.auth_time === "number")
      claims.auth_time = Math.min(claims.auth_time, now - 3600);
  }
  if (targets(faults.notYetValid, token)) {
    claims.iat = now + 600;
    claims.nbf = now + 600;
    claims.exp = now + 600 + lifetimeSec;
  }
}

function booleanClaim(context: IssuerContext, value: boolean): boolean | string {
  return context.profile.booleanClaimsAsStrings ? String(value) : value;
}

/** The identity claims a scope set releases, shared by ID tokens, access tokens and userinfo. */
export function identityClaims(
  context: IssuerContext,
  identity: Identity,
  scopes: readonly string[],
  faults: IdentityFaults,
  where: "id_token" | "access_token" | "userinfo",
): Claims {
  const profile = context.profile;
  const claims: Claims = {};
  if (scopes.includes("email") && identity.email !== null) {
    claims.email = identity.email;
    if (!faults.emailVerifiedAbsent) {
      claims.email_verified = booleanClaim(
        context,
        faults.emailUnverified ? false : identity.emailVerified === true,
      );
    }
    if (profile.name === "apple")
      claims.is_private_email = booleanClaim(context, identity.isPrivateEmail);
  }
  const profileClaims =
    scopes.includes("profile") && (where !== "id_token" || profile.profileClaimsInIdToken);
  if (profileClaims) {
    if (identity.name !== null) claims.name = identity.name;
    if (identity.givenName !== null) claims.given_name = identity.givenName;
    if (identity.familyName !== null) claims.family_name = identity.familyName;
    if (identity.picture !== null) claims.picture = identity.picture;
    if (profile.name === "keycloak") {
      claims.preferred_username =
        identity.email?.split("@")[0] ?? identity.personaId ?? identity.sub;
    }
  }
  return { ...identity.extra, ...claims };
}

function rolesClaims(identity: Identity): Claims {
  const claims: Claims = {};
  if (identity.roles.realm) claims.realm_access = { roles: [...identity.roles.realm] };
  if (identity.roles.clients) {
    claims.resource_access = Object.fromEntries(
      Object.entries(identity.roles.clients).map(([client, roles]) => [
        client,
        { roles: [...roles] },
      ]),
    );
  }
  return claims;
}

export function identityFaultsOf(faults: DevIdpFaults): IdentityFaults {
  const out: IdentityFaults = {};
  if (faults.subjectChanged) out.subjectChanged = true;
  if (faults.emailUnverified) out.emailUnverified = true;
  if (faults.emailVerifiedAbsent) out.emailVerifiedAbsent = true;
  return out;
}

export async function grantIdentity(
  context: IssuerContext,
  grant: Pick<Grant, "ref" | "nameIndex">,
  faults: IdentityFaults,
): Promise<Identity | null> {
  return resolveIdentity({
    profile: context.profile,
    issuer: context.issuer,
    personas: context.personas,
    ref: grant.ref,
    nameIndex: grant.nameIndex,
    subjectChanged: faults.subjectChanged === true,
  });
}

/** Whether this grant gets a refresh token, by the profile's rule. */
export function refreshAllowed(context: IssuerContext, grant: Grant): boolean {
  switch (context.profile.refreshTokens) {
    case "always":
      return true;
    case "offline_access":
      return grant.scopes.includes("offline_access");
    case "access_type_offline":
      return grant.offline;
  }
}

async function accessToken(
  context: IssuerContext,
  client: NormalizedClient,
  grant: Grant,
  identity: Identity,
  faults: DevIdpFaults,
  late: LateKeys,
): Promise<string> {
  const now = nowSec(context);
  const lifetime = context.lifetimes.accessTokenSec;
  if (client.accessTokenFormat === "opaque") {
    // Nobody but the issuer reads an opaque token, so a token fault aimed at it can only show as
    // the issuer refusing it: userinfo answers invalid_token (expired: by its expiry).
    const aimed = FAULT_NAMES.filter(
      (name) =>
        FAULT_CATALOGUE[name].scope === "token" &&
        targets(faults[name] as true | { target: TokenTarget } | undefined, "access_token"),
    );
    return context.sealer.seal("access", {
      exp: targets(faults.expired, "access_token") ? now - 600 : now + lifetime,
      bad: aimed.length > 0,
      g: grant.grantId,
      sid: grant.sid,
      cid: client.clientId,
      scp: grant.scopes,
      ref: grant.ref,
      ni: grant.nameIndex,
      f: identityFaultsOf(faults),
    });
  }
  const scopes = grant.scopes;
  // The grant id rides in the jti so userinfo can honour the grant's revocation.
  const jti = `${grant.grantId}.${randomToken(9)}`;
  const keycloak = context.profile.accessTokenStyle === "keycloak";
  const claims: Claims = keycloak
    ? {
        exp: now + lifetime,
        iat: now,
        auth_time: grant.authTime,
        jti,
        iss: context.issuer,
        aud: client.accessTokenAudience,
        sub: identity.sub,
        typ: "Bearer",
        azp: client.clientId,
        sid: grant.sid,
        scope: scopes.join(" "),
        ...rolesClaims(identity),
        ...identityClaims(context, identity, scopes, faults, "access_token"),
      }
    : {
        iss: context.issuer,
        sub: identity.sub,
        aud: client.accessTokenAudience,
        exp: now + lifetime,
        iat: now,
        jti,
        client_id: client.clientId,
        scope: scopes.join(" "),
        auth_time: grant.authTime,
        sid: grant.sid,
        ...rolesClaims(identity),
        ...identityClaims(context, identity, scopes, faults, "access_token"),
      };
  applyClaimFaults(context, claims, client, faults, "access_token", lifetime);
  return sign(
    context,
    keycloak ? "JWT" : "at+jwt",
    claims,
    client.accessTokenAlg,
    faults,
    "access_token",
    late,
  );
}

async function idToken(
  context: IssuerContext,
  client: NormalizedClient,
  grant: Grant,
  identity: Identity,
  faults: DevIdpFaults,
  atHash: string | null,
  includeNonce: boolean,
  late: LateKeys,
): Promise<string> {
  const now = nowSec(context);
  const profile = context.profile;
  const lifetime = context.lifetimes.idTokenSec;
  const claims: Claims = {
    iss: context.issuer,
    sub: identity.sub,
    aud: client.clientId,
    exp: now + lifetime,
    iat: now,
    auth_time: grant.authTime,
  };
  if (includeNonce && grant.nonce !== null) claims.nonce = grant.nonce;
  if (atHash !== null) claims.at_hash = atHash;
  if (profile.azp) claims.azp = client.clientId;
  if (profile.claimsSupported.includes("sid")) claims.sid = grant.sid;
  if (profile.name === "keycloak") claims.typ = "ID";
  if (profile.name === "apple") {
    claims.nonce_supported = true;
    claims.real_user_status = 2;
  }
  Object.assign(claims, identityClaims(context, identity, grant.scopes, faults, "id_token"));

  if (faults.wrongNonce) claims.nonce = randomToken(16);
  if (faults.missingNonce) delete claims.nonce;
  if (faults.wrongAtHash) claims.at_hash = await leftHalfHash(randomToken(32));
  if (faults.staleAuthTime) claims.auth_time = now - 86_400;
  if (faults.missingAuthTime) delete claims.auth_time;
  applyClaimFaults(context, claims, client, faults, "id_token", lifetime);
  return sign(context, "JWT", claims, client.idTokenAlg, faults, "id_token", late);
}

/**
 * The token response for `grant`. `fromRefresh`: OpenID Connect Core §12.2 (same `auth_time`,
 * no `nonce`). `refreshToken`: the new refresh token to include, if any.
 */
export async function mintTokenResponse(
  context: IssuerContext,
  client: NormalizedClient,
  grant: Grant,
  faults: DevIdpFaults,
  options: { fromRefresh: boolean; refreshToken: string | null },
): Promise<TokenResponse | null> {
  const identity = await grantIdentity(context, grant, identityFaultsOf(faults));
  if (!identity) return null;
  const late: LateKeys = faults.jwksRotatedMidFlow ? new Map() : null;
  const access = await accessToken(context, client, grant, identity, faults, late);
  const response: TokenResponse = {
    access_token: access,
    token_type: "Bearer",
    expires_in: context.lifetimes.accessTokenSec,
    scope: grant.scopes.join(" "),
  };
  if (grant.scopes.includes("openid")) {
    // An ID token cannot carry the hash of itself.
    const atHash = faults.idTokenAsAccessToken ? null : await leftHalfHash(access);
    response.id_token = await idToken(
      context,
      client,
      grant,
      identity,
      faults,
      atHash,
      !options.fromRefresh,
      late,
    );
    if (faults.idTokenAsAccessToken) response.access_token = response.id_token;
  }
  if (options.refreshToken !== null) response.refresh_token = options.refreshToken;
  return response;
}

/**
 * A refresh token for `grant`. It carries the grant's identity faults, so a refreshed ID token
 * asserts the same identity (OpenID Connect Core §12.2: same `sub`).
 */
export async function sealRefreshToken(
  context: IssuerContext,
  grant: Grant,
  identityFaults: IdentityFaults,
): Promise<string> {
  const now = nowSec(context);
  return context.sealer.seal("refresh", {
    exp: Math.min(now + context.lifetimes.refreshTokenSec, grant.familyExp),
    jti: randomToken(16),
    g: grant.grantId,
    cid: grant.clientId,
    scp: grant.scopes,
    n: grant.nonce,
    at: grant.authTime,
    sid: grant.sid,
    ref: grant.ref,
    ni: grant.nameIndex,
    off: grant.offline,
    fexp: grant.familyExp,
    f: identityFaults,
  });
}

// --- Verifying tokens this issuer signed --------------------------------------------------------

export type OwnJwtResult =
  | { ok: true; header: Claims; claims: Claims }
  | { ok: false; reason: string };

/**
 * Verifies a JWT against the keys this issuer publishes (retired keys no longer count), and its
 * `iss`. Expiry is checked unless `allowExpired` (an `id_token_hint` may be expired).
 */
export async function verifyOwnJwt(
  context: IssuerContext,
  token: string,
  options: { allowExpired: boolean },
): Promise<OwnJwtResult> {
  const decoded = decodeJws(token);
  if (!decoded) return { ok: false, reason: "malformed" };
  const { alg, kid, crit } = decoded.header;
  if (!isSigningAlgorithm(alg) || typeof kid !== "string" || crit !== undefined) {
    return { ok: false, reason: "unacceptable header" };
  }
  const entry = context.ring.find(kid);
  if (!entry || entry.status === "retired") return { ok: false, reason: "unknown key" };
  const key = await context.ring.verificationKey(kid, alg);
  if (!key || !(await verifyJws(decoded, key, alg))) return { ok: false, reason: "bad signature" };
  const claims = decoded.payload;
  if (claims.iss !== context.issuer) return { ok: false, reason: "wrong issuer" };
  const now = nowSec(context);
  if (!options.allowExpired && (typeof claims.exp !== "number" || claims.exp <= now)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && claims.nbf > now)
    return { ok: false, reason: "not yet valid" };
  return { ok: true, header: decoded.header, claims };
}

export function grantRevokedKey(context: IssuerContext, grantId: string): string {
  return storeKey(context, "grant-revoked", grantId);
}

export function sessionEndedKey(context: IssuerContext, sid: string): string {
  return storeKey(context, "session-ended", sid);
}

export function userinfoEndpoint(context: IssuerContext): string {
  return endpoint(context, "/userinfo");
}
