/** The userinfo endpoint (OpenID Connect Core §5.3), bearer tokens per RFC 6750 §2.1 only. */
import type { IssuerContext } from "../context.ts";
import { randomToken } from "../encoding.ts";
import { json, methodNotAllowed } from "../http.ts";
import {
  grantIdentity,
  grantRevokedKey,
  identityClaims,
  sessionEndedKey,
  verifyOwnJwt,
} from "../tokens.ts";
import { parseRef } from "./authorize.ts";

function bearerError(status: 400 | 401 | 403, error: string | null, description: string): Response {
  const challenge =
    error === null
      ? 'Bearer realm="dev-idp"'
      : `Bearer realm="dev-idp", error="${error}", error_description="${description}"`;
  return json(error === null ? {} : { error, error_description: description }, {
    status,
    headers: { "WWW-Authenticate": challenge },
  });
}

const invalidToken = (description: string) => bearerError(401, "invalid_token", description);

async function revoked(
  context: IssuerContext,
  grantId: string | null,
  sid: string | null,
): Promise<boolean> {
  if (!context.store) return false;
  if (grantId !== null && (await context.store.has(grantRevokedKey(context, grantId)))) return true;
  return sid !== null && (await context.store.has(sessionEndedKey(context, sid)));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Claims for a sealed (opaque) access token: the identity is re-resolved from the grant. */
async function opaqueClaims(
  context: IssuerContext,
  token: string,
): Promise<Response | Record<string, unknown>> {
  const payload = await context.sealer.unseal("access", token);
  if (!payload || payload.bad === true)
    return invalidToken("The access token is invalid or expired");
  const ref = parseRef(payload.ref);
  if (!ref || typeof payload.ni !== "number" || typeof payload.g !== "string") {
    return invalidToken("The access token is invalid");
  }
  const sid = typeof payload.sid === "string" ? payload.sid : null;
  if (await revoked(context, payload.g, sid)) return invalidToken("The access token was revoked");
  const scopes = stringArray(payload.scp);
  if (!scopes.includes("openid"))
    return bearerError(403, "insufficient_scope", "The openid scope is required");
  const faults =
    typeof payload.f === "object" && payload.f !== null ? (payload.f as Record<string, true>) : {};
  const identity = await grantIdentity(context, { ref, nameIndex: payload.ni }, faults);
  if (!identity) return invalidToken("The persona no longer exists");
  return { sub: identity.sub, ...identityClaims(context, identity, scopes, faults, "userinfo") };
}

const USERINFO_CLAIMS = [
  "email",
  "email_verified",
  "name",
  "given_name",
  "family_name",
  "picture",
  "preferred_username",
];

/** Claims for a JWT access token: it carries the identity this grant asserted. */
async function jwtClaims(
  context: IssuerContext,
  token: string,
): Promise<Response | Record<string, unknown>> {
  const result = await verifyOwnJwt(context, token, { allowExpired: false });
  if (!result.ok) return invalidToken(`The access token is not valid: ${result.reason}`);
  const { header, claims } = result;
  // An ID token is not an access token, whatever it says.
  const isAccessToken =
    context.profile.accessTokenStyle === "keycloak"
      ? claims.typ === "Bearer"
      : header.typ === "at+jwt";
  if (!isAccessToken) return invalidToken("The token is not an access token");
  const jti = typeof claims.jti === "string" ? claims.jti : "";
  const grantId = jti.includes(".") ? (jti.split(".")[0] ?? null) : null;
  const sid = typeof claims.sid === "string" ? claims.sid : null;
  if (await revoked(context, grantId, sid)) return invalidToken("The access token was revoked");
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  if (!scopes.includes("openid"))
    return bearerError(403, "insufficient_scope", "The openid scope is required");
  const out: Record<string, unknown> = { sub: claims.sub };
  for (const name of USERINFO_CLAIMS) if (claims[name] !== undefined) out[name] = claims[name];
  return out;
}

export async function handleUserinfo(context: IssuerContext, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return methodNotAllowed(["GET", "POST"]);
  if (new URL(request.url).searchParams.has("access_token")) {
    return bearerError(400, "invalid_request", "Send the access token in the Authorization header");
  }
  const authorization = request.headers.get("Authorization");
  if (!authorization) return bearerError(401, null, "");
  // Auth schemes are case-insensitive (RFC 7235 §2.1).
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
  if (!match?.[1]) return bearerError(400, "invalid_request", "Malformed Authorization header");
  const token = match[1];
  const opaque = token.split(".").length !== 3;
  const claims = opaque ? await opaqueClaims(context, token) : await jwtClaims(context, token);
  if (claims instanceof Response) return claims;
  if (context.standingFaults.userinfoSubjectMismatch)
    claims.sub = `${String(claims.sub)}-${randomToken(4)}`;
  return json(claims);
}
