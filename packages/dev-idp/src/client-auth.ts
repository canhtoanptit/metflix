/**
 * Client authentication at the token endpoint (RFC 6749 §2.3): `client_secret_basic`,
 * `client_secret_post`, Apple's JWT client secret (sent as `client_secret`), and `none` for
 * public clients. A client may use only the methods it registered, and only one per request.
 */
import type { NormalizedClient } from "./config.ts";
import { type IssuerContext, log, nowSec } from "./context.ts";
import { base64UrlDecode, timingSafeEqual, utf8Decode } from "./encoding.ts";
import { oauthError, param } from "./http.ts";
import { decodeJws, importVerificationKey, verifyJws } from "./jose.ts";

export type ClientAuthResult =
  | { ok: true; client: NormalizedClient }
  | { ok: false; response: Response };

function invalidClient(basic: boolean, description: string): ClientAuthResult {
  return {
    ok: false,
    response: oauthError(
      401,
      "invalid_client",
      description,
      basic ? { "WWW-Authenticate": 'Basic realm="dev-idp", charset="UTF-8"' } : {},
    ),
  };
}

function invalidRequest(description: string): ClientAuthResult {
  return { ok: false, response: oauthError(400, "invalid_request", description) };
}

/** `application/x-www-form-urlencoded` decoding of one Basic credential part (RFC 6749 §2.3.1). */
function formDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

function parseBasic(header: string): { id: string; secret: string } | null {
  const encoded = header.slice("Basic ".length).trim();
  let decoded: string;
  try {
    decoded = utf8Decode(
      base64UrlDecode(encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")),
    );
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const id = formDecode(decoded.slice(0, colon));
  const secret = formDecode(decoded.slice(colon + 1));
  return id === null || secret === null ? null : { id, secret };
}

// Imported client keys by client id, once imported.
const clientKeys = new WeakMap<NormalizedClient, CryptoKey>();

/** Apple's client secret: an ES256 JWT by the client's registered key, checked claim by claim. */
async function verifySignedSecret(
  context: IssuerContext,
  client: NormalizedClient,
  secret: string,
): Promise<string | null> {
  const config = client.signedClientSecret;
  if (!config) return "the client has no signing key";
  const decoded = decodeJws(secret);
  if (!decoded) return "client_secret is not a JWT";
  const { alg, kid, crit } = decoded.header;
  if (alg !== "ES256") return "client_secret must be signed with ES256";
  if (kid !== config.keyId) return "client_secret kid does not name the registered key";
  if (crit !== undefined) return "client_secret has unsupported critical headers";
  let key = clientKeys.get(client);
  if (!key) {
    key = await importVerificationKey(config.publicKey, "ES256");
    clientKeys.set(client, key);
  }
  if (!(await verifyJws(decoded, key, "ES256"))) return "client_secret signature is invalid";
  const { iss, sub, aud, iat, exp } = decoded.payload;
  const now = nowSec(context);
  if (iss !== config.teamId) return "client_secret iss is not the team id";
  if (sub !== client.clientId) return "client_secret sub is not the client id";
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(context.issuer)) return "client_secret aud is not this issuer";
  if (typeof iat !== "number" || typeof exp !== "number") return "client_secret needs iat and exp";
  if (iat > now + 60) return "client_secret was issued in the future";
  if (exp <= now) return "client_secret has expired";
  if (exp - iat > config.maxLifetimeSec) return "client_secret lives longer than allowed";
  return null;
}

async function verifySecret(
  context: IssuerContext,
  client: NormalizedClient,
  secret: string,
): Promise<string | null> {
  if (client.signedClientSecret) return verifySignedSecret(context, client, secret);
  if (client.clientSecret === null) return "the client has no secret";
  return (await timingSafeEqual(secret, client.clientSecret))
    ? null
    : "client authentication failed";
}

export async function authenticateClient(
  context: IssuerContext,
  request: Request,
  params: URLSearchParams,
): Promise<ClientAuthResult> {
  const authorization = request.headers.get("Authorization");
  // Auth schemes are case-insensitive (RFC 7235 §2.1).
  const basic = authorization !== null && /^basic /i.test(authorization);
  const bodyId = param(params, "client_id");
  const bodySecret = param(params, "client_secret");
  if (params.has("client_assertion") || params.has("client_assertion_type")) {
    return invalidClient(
      basic,
      "client_assertion (private_key_jwt, client_secret_jwt) is not supported",
    );
  }
  if (authorization !== null && !basic) {
    return invalidClient(false, "Only the Basic scheme authenticates clients here");
  }
  if (basic && bodySecret !== undefined) {
    return invalidRequest("Use one client authentication method, not two");
  }

  let clientId: string | undefined;
  let secret: string | undefined;
  let method: "client_secret_basic" | "client_secret_post" | "none";
  if (basic) {
    const credentials = parseBasic(authorization ?? "");
    if (!credentials) return invalidClient(true, "Malformed Basic credentials");
    if (bodyId !== undefined && bodyId !== credentials.id) {
      return invalidRequest("client_id differs from the authenticated client");
    }
    clientId = credentials.id;
    secret = credentials.secret;
    method = "client_secret_basic";
  } else if (bodySecret !== undefined) {
    clientId = bodyId;
    secret = bodySecret;
    method = "client_secret_post";
  } else {
    clientId = bodyId;
    method = "none";
  }
  if (clientId === undefined) return invalidClient(basic, "client_id is required");
  const client = context.clients.get(clientId);
  if (!client) {
    log(context, "warn", "unknown client at the token endpoint", { method });
    return invalidClient(basic, "Unknown client or wrong authentication method");
  }
  if (!client.authMethods.includes(method)) {
    log(context, "warn", "client used an authentication method it did not register", {
      clientId,
      method,
    });
    return invalidClient(basic, "Unknown client or wrong authentication method");
  }
  if (method !== "none") {
    const problem = await verifySecret(context, client, secret ?? "");
    if (problem !== null) {
      log(context, "warn", "client authentication failed", { clientId, method });
      return invalidClient(basic, problem);
    }
  }
  return { ok: true, client };
}
