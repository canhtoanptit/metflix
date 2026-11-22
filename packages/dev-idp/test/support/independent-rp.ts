/**
 * An independent OpenID Connect relying party, written for the tests only, from the
 * specifications: OpenID Connect Core 1.0 §3.1 (code flow, ID token validation §3.1.3.7, at_hash
 * §3.1.3.8, userinfo §5.3), Discovery 1.0 §4, RFC 7636 (PKCE), RFC 9207 (iss in the response),
 * RFC 9068 (JWT access tokens), RP-Initiated Logout 1.0.
 *
 * It deliberately shares no code with the provider (no import from ../../src): its own base64url,
 * JWS verification, JWKS cache and HTML form reading. Every check fails with an `RpError` whose
 * `code` names the rule, so tests can assert which rule caught a fault.
 */

export class RpError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

type Fetch = (request: Request) => Promise<Response>;
type Json = Record<string, unknown>;

// --- Encoding, written separately from the provider's -------------------------------------------

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new RpError("malformed_jwt", "not base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const text = (value: string) => new TextEncoder().encode(value);

async function s256(value: string): Promise<string> {
  return bytesToB64url(new Uint8Array(await crypto.subtle.digest("SHA-256", text(value))));
}

function randomValue(bytes = 32): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

interface ParsedJwt {
  header: Json;
  claims: Json;
  input: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new RpError("malformed_jwt", "a JWS has three parts");
  const [h = "", c = "", s = ""] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as Json;
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(c))) as Json;
    return { header, claims, input: text(`${h}.${c}`), signature: b64urlToBytes(s) };
  } catch (error) {
    if (error instanceof RpError) throw error;
    throw new RpError("malformed_jwt", "header or claims are not JSON");
  }
}

// --- Configuration -----------------------------------------------------------------------------

export type RpClientAuth =
  | { method: "client_secret_basic"; secret: string }
  | { method: "client_secret_post"; secret: string }
  | { method: "none" }
  | { method: "apple_jwt"; privateJwk: Json; teamId: string; keyId: string };

export interface RpConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  auth: RpClientAuth;
  fetch: Fetch;
  /** Algorithms this client accepts for ID tokens: configuration, never the token header. */
  algorithms?: readonly string[];
  clockSkewSec?: number;
  now?: () => number;
  jwksTimeoutMs?: number;
}

export interface Transaction {
  state: string;
  nonce: string;
  verifier: string;
  maxAge: number | null;
}

export interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  authorization_response_iss_parameter_supported?: boolean;
  [key: string]: unknown;
}

export interface SignInResult {
  idToken: string;
  idClaims: Json;
  accessToken: string;
  refreshToken: string | null;
  tokenResponse: Json;
}

const ALG_PARAMS: Record<string, { kty: string; import: Json; verify: Json }> = {
  RS256: {
    kty: "RSA",
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
  },
  ES256: {
    kty: "EC",
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
};

export class IndependentRp {
  readonly config: Required<Omit<RpConfig, "now">> & { now: () => number };
  private metadata: Metadata | null = null;
  private jwks: Json[] | null = null;

  constructor(config: RpConfig) {
    this.config = {
      algorithms: ["RS256", "ES256"],
      clockSkewSec: 60,
      jwksTimeoutMs: 2000,
      ...config,
      now: config.now ?? (() => Date.now()),
    };
  }

  private nowSec(): number {
    return Math.floor(this.config.now() / 1000);
  }

  private async getJson(
    url: string,
    init: { headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: Json; headers: Headers }> {
    const response = await this.config.fetch(new Request(url, { headers: init.headers }));
    const body = (await response.json()) as Json;
    return { status: response.status, body, headers: response.headers };
  }

  /** Discovery §4: fetched from issuer + /.well-known/openid-configuration, issuer must match exactly. */
  async discover(): Promise<Metadata> {
    if (this.metadata) return this.metadata;
    const { status, body } = await this.getJson(
      `${this.config.issuer}/.well-known/openid-configuration`,
    );
    if (status !== 200) throw new RpError("discovery_failed", `status ${status}`);
    if (body.issuer !== this.config.issuer) {
      throw new RpError("discovery_issuer_mismatch", `discovery names ${String(body.issuer)}`);
    }
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      if (typeof body[field] !== "string") throw new RpError("discovery_incomplete", field);
    }
    this.metadata = body as Metadata;
    return this.metadata;
  }

  async begin(options: {
    scope: string;
    maxAge?: number;
    prompt?: string;
    responseMode?: string;
    loginHint?: string;
  }): Promise<{ url: URL; transaction: Transaction }> {
    const metadata = await this.discover();
    const transaction: Transaction = {
      state: randomValue(),
      nonce: randomValue(),
      verifier: randomValue(48),
      maxAge: options.maxAge ?? null,
    };
    const url = new URL(metadata.authorization_endpoint);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: options.scope,
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await s256(transaction.verifier),
      code_challenge_method: "S256",
    };
    if (options.maxAge !== undefined) params.max_age = String(options.maxAge);
    if (options.prompt !== undefined) params.prompt = options.prompt;
    if (options.responseMode !== undefined) params.response_mode = options.responseMode;
    if (options.loginHint !== undefined) params.login_hint = options.loginHint;
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return { url, transaction };
  }

  /** The authorisation response: error, state and RFC 9207 iss checks, before touching the code. */
  async callback(params: URLSearchParams, transaction: Transaction): Promise<string> {
    const metadata = await this.discover();
    const iss = params.get("iss");
    if (metadata.authorization_response_iss_parameter_supported === true && iss === null) {
      throw new RpError("response_iss_missing");
    }
    if (iss !== null && iss !== this.config.issuer) throw new RpError("response_iss_mismatch", iss);
    if (params.get("state") !== transaction.state) throw new RpError("state_mismatch");
    const error = params.get("error");
    if (error !== null)
      throw new RpError(`authorization_error:${error}`, params.get("error_description") ?? "");
    const code = params.get("code");
    if (!code) throw new RpError("code_missing");
    return code;
  }

  private async clientAuth(): Promise<{
    headers: Record<string, string>;
    body: Record<string, string>;
  }> {
    const auth = this.config.auth;
    const id = this.config.clientId;
    switch (auth.method) {
      case "client_secret_basic": {
        const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
        return {
          headers: { Authorization: `Basic ${btoa(`${encode(id)}:${encode(auth.secret)}`)}` },
          body: {},
        };
      }
      case "client_secret_post":
        return { headers: {}, body: { client_id: id, client_secret: auth.secret } };
      case "none":
        return { headers: {}, body: { client_id: id } };
      case "apple_jwt": {
        const { d, x, y, crv, kty } = auth.privateJwk as Record<string, string>;
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty, crv, x, y, d },
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"],
        );
        const now = this.nowSec();
        const header = bytesToB64url(text(JSON.stringify({ alg: "ES256", kid: auth.keyId })));
        const claims = bytesToB64url(
          text(
            JSON.stringify({
              iss: auth.teamId,
              sub: id,
              aud: this.config.issuer,
              iat: now,
              exp: now + 300,
            }),
          ),
        );
        const signature = await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          text(`${header}.${claims}`),
        );
        return {
          headers: {},
          body: {
            client_id: id,
            client_secret: `${header}.${claims}.${bytesToB64url(new Uint8Array(signature))}`,
          },
        };
      }
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<Json> {
    const metadata = await this.discover();
    const auth = await this.clientAuth();
    const response = await this.config.fetch(
      new Request(metadata.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...auth.headers },
        body: new URLSearchParams({ ...params, ...auth.body }).toString(),
      }),
    );
    const body = (await response.json()) as Json;
    if (response.status !== 200)
      throw new RpError(`token_error:${String(body.error)}`, String(body.error_description));
    if (response.headers.get("Cache-Control") !== "no-store")
      throw new RpError("token_response_cacheable");
    if (
      typeof body.access_token !== "string" ||
      String(body.token_type).toLowerCase() !== "bearer"
    ) {
      throw new RpError("token_response_invalid");
    }
    return body;
  }

  async exchange(code: string, transaction: Transaction): Promise<SignInResult> {
    const body = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: transaction.verifier,
    });
    if (typeof body.id_token !== "string") throw new RpError("id_token_missing");
    const accessToken = body.access_token as string;
    const idClaims = await this.validateIdToken(body.id_token, {
      nonce: transaction.nonce,
      maxAge: transaction.maxAge,
      accessToken,
    });
    return {
      idToken: body.id_token,
      idClaims,
      accessToken,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      tokenResponse: body,
    };
  }

  /** Refresh (OpenID Connect Core §12): a new ID token must keep iss, sub, aud and auth_time. */
  async refresh(refreshToken: string, previous: Json): Promise<SignInResult> {
    const body = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const accessToken = body.access_token as string;
    let idClaims: Json = previous;
    if (typeof body.id_token === "string") {
      idClaims = await this.validateIdToken(body.id_token, {
        nonce: null,
        maxAge: null,
        accessToken,
      });
      for (const claim of ["iss", "sub", "auth_time"]) {
        if (idClaims[claim] !== previous[claim]) throw new RpError("refresh_claim_changed", claim);
      }
    }
    return {
      idToken: typeof body.id_token === "string" ? body.id_token : "",
      idClaims,
      accessToken,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      tokenResponse: body,
    };
  }

  private async fetchJwks(): Promise<Json[]> {
    const metadata = await this.discover();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new RpError("jwks_timeout")), this.config.jwksTimeoutMs),
    );
    const { status, body } = await Promise.race([this.getJson(metadata.jwks_uri), timeout]);
    if (status !== 200 || !Array.isArray(body.keys))
      throw new RpError("jwks_unavailable", `status ${status}`);
    this.jwks = body.keys as Json[];
    return this.jwks;
  }

  /** The key for (kid, alg) from the JWKS, refetching once for an unknown kid. Header keys are ignored. */
  private async keyFor(kid: unknown, alg: string): Promise<CryptoKey> {
    const params = ALG_PARAMS[alg];
    if (!params) throw new RpError("alg_not_allowed", alg);
    const find = (keys: Json[]) =>
      keys.find(
        (key) =>
          key.kid === kid &&
          key.kty === params.kty &&
          (key.alg === undefined || key.alg === alg) &&
          key.use !== "enc",
      );
    let jwk = find(this.jwks ?? (await this.fetchJwks()));
    if (!jwk && this.jwks) jwk = find(await this.fetchJwks());
    if (!jwk) throw new RpError("unknown_kid", String(kid));
    const { kty, n, e, crv, x, y } = jwk as Record<string, string>;
    const material = kty === "RSA" ? { kty, n, e } : { kty, crv, x, y };
    return crypto.subtle.importKey(
      "jwk",
      material,
      params.import as unknown as Parameters<typeof crypto.subtle.importKey>[2],
      false,
      ["verify"],
    );
  }

  /** Signature against the issuer's JWKS, with the algorithm chosen by configuration. */
  private async verifySignature(token: string, allowed: readonly string[]): Promise<ParsedJwt> {
    const parsed = parseJwt(token);
    const alg = parsed.header.alg;
    if (typeof alg !== "string" || !allowed.includes(alg))
      throw new RpError("alg_not_allowed", String(alg));
    if (parsed.header.crit !== undefined) throw new RpError("crit_unsupported");
    const key = await this.keyFor(parsed.header.kid, alg);
    const params = ALG_PARAMS[alg]?.verify as unknown as Parameters<typeof crypto.subtle.verify>[0];
    if (!(await crypto.subtle.verify(params, key, parsed.signature, parsed.input))) {
      throw new RpError("bad_signature");
    }
    return parsed;
  }

  /** OpenID Connect Core §3.1.3.7, rule by rule. */
  async validateIdToken(
    token: string,
    expected: { nonce: string | null; maxAge: number | null; accessToken: string | null },
  ): Promise<Json> {
    const { header, claims } = await this.verifySignature(token, this.config.algorithms);
    if (header.typ !== undefined && String(header.typ).toLowerCase() === "at+jwt")
      throw new RpError("not_an_id_token");
    const now = this.nowSec();
    const skew = this.config.clockSkewSec;
    if (claims.iss !== this.config.issuer) throw new RpError("iss_mismatch", String(claims.iss));
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.clientId)) throw new RpError("aud_mismatch");
    if (aud.some((value) => value !== this.config.clientId))
      throw new RpError("untrusted_audience");
    if (claims.azp !== undefined && claims.azp !== this.config.clientId)
      throw new RpError("azp_mismatch");
    if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) {
      throw new RpError("sub_invalid");
    }
    if (typeof claims.exp !== "number" || claims.exp <= now - skew) throw new RpError("expired");
    if (typeof claims.iat !== "number" || claims.iat > now + skew)
      throw new RpError("issued_in_future");
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + skew)) {
      throw new RpError("not_yet_valid");
    }
    if (expected.nonce !== null) {
      if (claims.nonce === undefined) throw new RpError("nonce_missing");
      if (claims.nonce !== expected.nonce) throw new RpError("nonce_mismatch");
    }
    if (expected.maxAge !== null) {
      if (typeof claims.auth_time !== "number") throw new RpError("auth_time_missing");
      if (now - claims.auth_time > expected.maxAge + skew) throw new RpError("auth_too_old");
    }
    if (claims.at_hash !== undefined && expected.accessToken !== null) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", text(expected.accessToken)),
      );
      if (claims.at_hash !== bytesToB64url(digest.subarray(0, 16)))
        throw new RpError("at_hash_mismatch");
    }
    return claims;
  }

  /** §5.3: the userinfo sub must equal the ID token's. */
  async userinfo(accessToken: string, expectedSub: string): Promise<Json> {
    const metadata = await this.discover();
    if (!metadata.userinfo_endpoint) throw new RpError("userinfo_unsupported");
    const { status, body } = await this.getJson(metadata.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (status !== 200) throw new RpError(`userinfo_error:${status}`);
    if (body.sub !== expectedSub) throw new RpError("userinfo_sub_mismatch");
    return body;
  }

  /**
   * A resource server's check of a JWT access token: RFC 9068 (`typ: at+jwt`) or Keycloak's
   * shape (`typ` claim `Bearer`). An ID token presented as an access token must fail.
   */
  async validateAccessToken(
    token: string,
    audience: string,
    style: "rfc9068" | "keycloak",
  ): Promise<Json> {
    const { header, claims } = await this.verifySignature(token, this.config.algorithms);
    if (style === "rfc9068" && String(header.typ).toLowerCase() !== "at+jwt")
      throw new RpError("not_an_access_token");
    if (style === "keycloak" && claims.typ !== "Bearer") throw new RpError("not_an_access_token");
    const now = this.nowSec();
    if (claims.iss !== this.config.issuer) throw new RpError("iss_mismatch");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new RpError("aud_mismatch");
    if (typeof claims.exp !== "number" || claims.exp <= now - this.config.clockSkewSec)
      throw new RpError("expired");
    if (typeof claims.iat !== "number" || claims.iat > now + this.config.clockSkewSec) {
      throw new RpError("issued_in_future");
    }
    if (claims.nbf !== undefined && Number(claims.nbf) > now + this.config.clockSkewSec)
      throw new RpError("not_yet_valid");
    return claims;
  }

  async logoutUrl(idToken: string, postLogoutRedirectUri: string, state: string): Promise<URL> {
    const metadata = await this.discover();
    if (!metadata.end_session_endpoint) throw new RpError("end_session_unsupported");
    const url = new URL(metadata.end_session_endpoint);
    url.searchParams.set("id_token_hint", idToken);
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
    url.searchParams.set("state", state);
    return url;
  }
}

// --- A minimal user agent, also independent of the provider's test kit -------------------------

export interface UserAgentChoice {
  persona?: string;
  email?: string;
  faults?: readonly string[];
}

/** What the redirect URI receives: query parameters, or the fields of a form_post. */
export interface Delivered {
  mode: "query" | "form_post";
  target: string;
  params: URLSearchParams;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readDelivered(location: string): Delivered {
  const url = new URL(location);
  const params = new URLSearchParams(url.search);
  return { mode: "query", target: `${url.origin}${url.pathname}`, params };
}

function readFormPost(html: string): Delivered | null {
  if (
    !/<script nonce="[^"]+">document\.getElementById\("form-post"\)\.submit\(\);<\/script>/.test(
      html,
    )
  )
    return null;
  const action = /action="([^"]+)"/.exec(html)?.[1];
  if (!action) return null;
  const params = new URLSearchParams();
  for (const match of html.matchAll(/name="([^"]+)" value="([^"]*)"/g)) {
    params.append(decodeEntities(match[1] ?? ""), decodeEntities(match[2] ?? ""));
  }
  return { mode: "form_post", target: decodeEntities(action), params };
}

/** Loads the authorisation URL like a browser, submits the picker, returns what the RP receives. */
export class UserAgent {
  private readonly cookies = new Map<string, string>();
  private readonly fetchImpl: Fetch;

  constructor(fetchImpl: Fetch) {
    this.fetchImpl = fetchImpl;
  }

  private cookieHeader(): Record<string, string> {
    return this.cookies.size
      ? { Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") }
      : {};
  }

  private remember(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const [name = "", value = ""] = pair.split("=");
      if (/Max-Age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private async land(response: Response): Promise<Delivered | string> {
    this.remember(response);
    if (response.status === 302 || response.status === 303)
      return readDelivered(response.headers.get("Location") ?? "");
    const html = await response.text();
    if (response.status !== 200) throw new RpError("issuer_error_page", `${response.status}`);
    return readFormPost(html) ?? html;
  }

  async authorize(url: URL, choice: UserAgentChoice): Promise<Delivered> {
    const first = await this.land(
      await this.fetchImpl(new Request(url, { headers: this.cookieHeader(), redirect: "manual" })),
    );
    if (typeof first !== "string") return first;
    const html = first;
    const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1];
    const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
    if (!action || !txn) throw new RpError("no_sign_in_form");
    const form = new URLSearchParams({ txn: decodeEntities(txn), action: "continue" });
    if (choice.persona) form.set("persona", choice.persona);
    if (choice.email) {
      form.set("persona", "__email__");
      form.set("email", choice.email);
      form.set("email_verified", "true");
    }
    for (const fault of choice.faults ?? []) form.append("fault", fault);
    const response = await this.fetchImpl(
      new Request(decodeEntities(action), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Sec-Fetch-Site": "same-origin",
          ...this.cookieHeader(),
        },
        body: form.toString(),
        redirect: "manual",
      }),
    );
    const delivered = await this.land(response);
    if (typeof delivered === "string") throw new RpError("unexpected_page");
    return delivered;
  }

  async get(url: URL): Promise<Response> {
    const response = await this.fetchImpl(
      new Request(url, { headers: this.cookieHeader(), redirect: "manual" }),
    );
    this.remember(response);
    return response;
  }
}

/** One full sign-in: begin, user agent, callback, exchange. */
export async function signInWith(
  rp: IndependentRp,
  agent: UserAgent,
  choice: UserAgentChoice,
  options: { scope: string; maxAge?: number; prompt?: string; responseMode?: string },
): Promise<SignInResult & { delivered: Delivered; transaction: Transaction }> {
  const { url, transaction } = await rp.begin(options);
  const delivered = await agent.authorize(url, choice);
  if (delivered.target !== rp.config.redirectUri)
    throw new RpError("redirected_elsewhere", delivered.target);
  const code = await rp.callback(delivered.params, transaction);
  const result = await rp.exchange(code, transaction);
  return { ...result, delivered, transaction };
}
