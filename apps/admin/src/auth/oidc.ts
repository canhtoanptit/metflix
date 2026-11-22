/**
 * The console as an OpenID Connect public client (authorisation code with PKCE, RFC 6749/7636):
 * discovery, the authorisation URL, the token endpoint (code and refresh grants) and
 * RP-initiated sign-out. The console never validates or reads a token's contents: the staff API
 * validates the access token on every call, and who the staff member is comes from `GET /me`.
 * No cookie is sent or kept by these calls (`credentials: "omit"`).
 */
import type { RuntimeConfig } from "../config/runtime.ts";

export interface IssuerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint: string | null;
  /** RFC 9207: the issuer names itself in the authorisation response. */
  issInResponse: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Kept for the sign-out hint only. */
  idToken: string | null;
  /** When the access token stops working (ms, this browser's clock). */
  expiresAt: number;
}

/** An issuer that answered with an OAuth error, or did not answer as the protocol says. */
export class OidcError extends Error {
  override readonly name = "OidcError";
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const TIMEOUT_MS = 15_000;

function absolute(value: unknown, field: string): string {
  if (typeof value !== "string") throw new OidcError("invalid_discovery", `No ${field}`);
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new OidcError("invalid_discovery", `${field} must use https`);
  }
  return url.href;
}

export async function discover(config: Pick<RuntimeConfig, "issuer">): Promise<IssuerMetadata> {
  let response: Response;
  try {
    response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OidcError("issuer_unreachable", "The staff sign-in service did not answer");
  }
  if (!response.ok) {
    throw new OidcError(
      "issuer_unreachable",
      `The staff sign-in service answered ${response.status}`,
    );
  }
  const document = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!document) throw new OidcError("invalid_discovery", "Discovery is not JSON");
  // OpenID Connect Discovery §4.3: the document must name exactly the issuer it was fetched for.
  if (document.issuer !== config.issuer) {
    throw new OidcError("invalid_discovery", "The issuer's discovery names another issuer");
  }
  return {
    issuer: config.issuer,
    authorizationEndpoint: absolute(document.authorization_endpoint, "authorization_endpoint"),
    tokenEndpoint: absolute(document.token_endpoint, "token_endpoint"),
    endSessionEndpoint:
      typeof document.end_session_endpoint === "string"
        ? absolute(document.end_session_endpoint, "end_session_endpoint")
        : null,
    issInResponse: document.authorization_response_iss_parameter_supported === true,
  };
}

export function authorizationUrl(
  metadata: IssuerMetadata,
  config: Pick<RuntimeConfig, "clientId" | "redirectUri" | "scope">,
  request: { state: string; nonce: string; challenge: string; prompt?: "none" | "login" },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state: request.state,
    nonce: request.nonce,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  };
  if (request.prompt) params.prompt = request.prompt;
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}

async function tokenRequest(
  metadata: IssuerMetadata,
  body: Record<string, string>,
  now: () => number,
): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetch(metadata.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OidcError("issuer_unreachable", "The staff sign-in service did not answer");
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !json || typeof json.access_token !== "string") {
    const code = typeof json?.error === "string" ? json.error : "invalid_token_response";
    throw new OidcError(code, `The token endpoint refused (${response.status} ${code})`);
  }
  const lifetime =
    typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 300;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    idToken: typeof json.id_token === "string" ? json.id_token : null,
    expiresAt: now() + lifetime * 1000,
  };
}

export function exchangeCode(
  metadata: IssuerMetadata,
  config: Pick<RuntimeConfig, "clientId" | "redirectUri">,
  code: string,
  verifier: string,
  now: () => number = Date.now,
): Promise<TokenSet> {
  return tokenRequest(
    metadata,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    },
    now,
  );
}

/** The refresh grant; issuers rotate the refresh token, so the old one is dropped. */
export async function refreshTokens(
  metadata: IssuerMetadata,
  config: Pick<RuntimeConfig, "clientId">,
  current: TokenSet,
  now: () => number = Date.now,
): Promise<TokenSet> {
  if (!current.refreshToken) throw new OidcError("no_refresh_token");
  const next = await tokenRequest(
    metadata,
    {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: config.clientId,
    },
    now,
  );
  return {
    ...next,
    refreshToken: next.refreshToken ?? current.refreshToken,
    idToken: next.idToken ?? current.idToken,
  };
}

/** RP-initiated logout (null when the issuer has no end-session endpoint). */
export function endSessionUrl(
  metadata: IssuerMetadata,
  config: Pick<RuntimeConfig, "clientId" | "postLogoutRedirectUri">,
  idToken: string | null,
): string | null {
  if (!metadata.endSessionEndpoint) return null;
  const url = new URL(metadata.endSessionEndpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("post_logout_redirect_uri", config.postLogoutRedirectUri);
  if (idToken) url.searchParams.set("id_token_hint", idToken);
  return url.href;
}
