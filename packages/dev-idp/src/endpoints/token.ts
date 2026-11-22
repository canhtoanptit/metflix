/**
 * The token endpoint (RFC 6749 §3.2, OpenID Connect Core §3.1.3): the authorisation code grant
 * with PKCE and the refresh token grant with rotation.
 */
import { authenticateClient } from "../client-auth.ts";
import type { NormalizedClient } from "../config.ts";
import { type IssuerContext, log, nowSec, revocationTtlMs, storeKey } from "../context.ts";
import { base64UrlEncode, sha256, timingSafeEqual } from "../encoding.ts";
import { type DevIdpFaults, mergeFaults, parseFlowFaults } from "../faults.ts";
import {
  duplicateParameter,
  json,
  methodNotAllowed,
  oauthError,
  param,
  readForm,
} from "../http.ts";
import {
  type Grant,
  grantRevokedKey,
  type IdentityFaults,
  identityFaultsOf,
  mintTokenResponse,
  refreshAllowed,
  sealRefreshToken,
  sessionEndedKey,
} from "../tokens.ts";
import { parseRef } from "./authorize.ts";

const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function invalidGrant(description: string): Response {
  return oauthError(400, "invalid_grant", description);
}

/** The identity faults a sealed refresh token carries, read defensively. */
function identityFaults(value: unknown): IdentityFaults {
  if (typeof value !== "object" || value === null) return {};
  const faults = value as Record<string, unknown>;
  const out: IdentityFaults = {};
  if (faults.subjectChanged === true) out.subjectChanged = true;
  if (faults.emailUnverified === true) out.emailUnverified = true;
  if (faults.emailVerifiedAbsent === true) out.emailVerifiedAbsent = true;
  return out;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/** Revokes everything issued from a grant: its refresh tokens and (at userinfo) its access tokens. */
async function revokeGrant(context: IssuerContext, grantId: string): Promise<void> {
  if (!context.store) return;
  await context.store.claim(
    grantRevokedKey(context, grantId),
    context.clock.now() + revocationTtlMs(context),
  );
}

async function grantIsRevoked(context: IssuerContext, grant: Grant): Promise<boolean> {
  if (!context.store) return false;
  return (
    (await context.store.has(grantRevokedKey(context, grant.grantId))) ||
    (await context.store.has(sessionEndedKey(context, grant.sid)))
  );
}

async function codeGrant(
  context: IssuerContext,
  client: NormalizedClient,
  params: URLSearchParams,
): Promise<Response> {
  const code = param(params, "code");
  if (code === undefined) return oauthError(400, "invalid_request", "code is required");
  const redirectUri = param(params, "redirect_uri");
  const verifier = param(params, "code_verifier");
  const payload = await context.sealer.unseal("code", code);
  // One description for every reason a code is refused: the response is no oracle.
  const refused =
    "The authorization code is invalid, expired, already used or was issued to another client";
  if (!payload) return invalidGrant(refused);
  const ref = parseRef(payload.ref);
  const scopes = strings(payload.s);
  const faultEntries = strings(payload.f) ?? [];
  if (
    typeof payload.j !== "string" ||
    typeof payload.c !== "string" ||
    typeof payload.r !== "string" ||
    typeof payload.at !== "number" ||
    typeof payload.sid !== "string" ||
    typeof payload.ni !== "number" ||
    !ref ||
    !scopes
  ) {
    return invalidGrant(refused);
  }
  if (payload.c !== client.clientId) {
    log(context, "warn", "code redeemed by another client", { clientId: client.clientId });
    return invalidGrant(refused);
  }
  if (redirectUri === undefined || redirectUri !== payload.r) {
    return invalidGrant("redirect_uri must be identical to the one in the authorization request");
  }
  const challenge = typeof payload.cc === "string" ? payload.cc : null;
  if (challenge !== null) {
    if (verifier === undefined || !CODE_VERIFIER.test(verifier)) {
      return invalidGrant("code_verifier is missing or malformed");
    }
    const computed = base64UrlEncode(await sha256(verifier));
    if (!(await timingSafeEqual(computed, challenge))) {
      log(context, "warn", "PKCE verifier mismatch", { clientId: client.clientId });
      return invalidGrant("code_verifier does not match the code_challenge");
    }
  } else if (verifier !== undefined) {
    // RFC 9700 §2.1.1: a verifier for a code issued without a challenge is a downgrade attempt.
    return invalidGrant("code_verifier sent for a code issued without code_challenge");
  }

  // Single use, checked last so a wrong client or verifier cannot burn the legitimate one's code.
  if (context.store) {
    const first = await context.store.claim(
      storeKey(context, "code", payload.j),
      payload.exp * 1000,
    );
    if (!first) {
      // RFC 6749 §4.1.2: revoke what the first redemption obtained.
      await revokeGrant(context, payload.j);
      log(context, "warn", "authorization code replayed; grant revoked", {
        clientId: client.clientId,
      });
      return invalidGrant(refused);
    }
  }
  const now = nowSec(context);
  const grant: Grant = {
    grantId: payload.j,
    clientId: client.clientId,
    scopes,
    nonce: typeof payload.n === "string" ? payload.n : null,
    authTime: payload.at,
    sid: payload.sid,
    ref,
    nameIndex: payload.ni,
    offline: payload.off === true,
    familyExp: now + context.lifetimes.refreshFamilySec,
  };
  const flowFaults: DevIdpFaults = parseFlowFaults(faultEntries) ?? {};
  const faults = mergeFaults(context.standingFaults, flowFaults);
  const refreshToken = refreshAllowed(context, grant)
    ? await sealRefreshToken(context, grant, identityFaultsOf(faults))
    : null;
  const response = await mintTokenResponse(context, client, grant, faults, {
    fromRefresh: false,
    refreshToken,
  });
  if (!response) return invalidGrant("The persona no longer exists");
  log(context, "info", "code exchanged", { clientId: client.clientId });
  return json(response);
}

async function refreshGrant(
  context: IssuerContext,
  client: NormalizedClient,
  params: URLSearchParams,
): Promise<Response> {
  const token = param(params, "refresh_token");
  if (token === undefined) return oauthError(400, "invalid_request", "refresh_token is required");
  const payload = await context.sealer.unseal("refresh", token);
  const refused = "The refresh token is invalid, expired, revoked or was issued to another client";
  if (!payload) return invalidGrant(refused);
  const ref = parseRef(payload.ref);
  const scopes = strings(payload.scp);
  if (
    typeof payload.jti !== "string" ||
    typeof payload.g !== "string" ||
    typeof payload.cid !== "string" ||
    typeof payload.at !== "number" ||
    typeof payload.sid !== "string" ||
    typeof payload.ni !== "number" ||
    typeof payload.fexp !== "number" ||
    !ref ||
    !scopes
  ) {
    return invalidGrant(refused);
  }
  if (payload.cid !== client.clientId) return invalidGrant(refused);
  const grant: Grant = {
    grantId: payload.g,
    clientId: client.clientId,
    scopes,
    nonce: typeof payload.n === "string" ? payload.n : null,
    authTime: payload.at,
    sid: payload.sid,
    ref,
    nameIndex: payload.ni,
    offline: payload.off === true,
    familyExp: payload.fexp,
  };
  // RFC 6749 §6: a narrower scope applies to the tokens issued now; the new refresh token keeps
  // the original scope.
  let issuedScopes = scopes;
  const requested = param(params, "scope");
  if (requested !== undefined) {
    issuedScopes = [...new Set(requested.split(" ").filter(Boolean))];
    if (issuedScopes.some((scope) => !scopes.includes(scope))) {
      return oauthError(400, "invalid_scope", "A refresh may only narrow the original scope");
    }
  }
  if (await grantIsRevoked(context, grant)) return invalidGrant(refused);
  if (context.store) {
    const first = await context.store.claim(
      storeKey(context, "refresh", payload.jti),
      payload.exp * 1000,
    );
    if (!first) {
      // A rotated-out refresh token came back: someone holds a copy. Revoke the whole family.
      await revokeGrant(context, grant.grantId);
      log(context, "warn", "refresh token reused; grant revoked", { clientId: client.clientId });
      return invalidGrant(refused);
    }
  }
  // The identity faults of the original sign-in stay with the grant (same sub, §12.2).
  const carried = identityFaults(payload.f);
  const response = await mintTokenResponse(
    context,
    client,
    { ...grant, scopes: issuedScopes },
    { ...context.standingFaults, ...carried },
    { fromRefresh: true, refreshToken: await sealRefreshToken(context, grant, carried) },
  );
  if (!response) return invalidGrant("The persona no longer exists");
  return json(response);
}

export async function handleToken(context: IssuerContext, request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const form = await readForm(request);
  if (!form.ok) {
    return form.reason === "too_large"
      ? oauthError(413, "invalid_request", "The request body is too large")
      : oauthError(400, "invalid_request", "Send application/x-www-form-urlencoded parameters");
  }
  const params = form.params;
  const duplicate = duplicateParameter(params);
  if (duplicate !== undefined)
    return oauthError(400, "invalid_request", `Parameter ${duplicate} is repeated`);
  const grantType = param(params, "grant_type");
  if (grantType === undefined) return oauthError(400, "invalid_request", "grant_type is required");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(400, "unsupported_grant_type", `grant_type ${grantType} is not supported`);
  }
  const auth = await authenticateClient(context, request, params);
  if (!auth.ok) return auth.response;
  return grantType === "authorization_code"
    ? codeGrant(context, auth.client, params)
    : refreshGrant(context, auth.client, params);
}
