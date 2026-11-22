/**
 * Starting an issuer inside a test, in-process (a fetch handler: works on Node and in workerd).
 * For a real port on Node, see `@webflix/dev-idp/node`.
 */
import type { DevIdpClient, DevIdpOptions } from "../config.ts";
import { DEVELOPMENT_APPLE_CLIENT_KEY } from "../development-keys.ts";
import { base64UrlEncode, randomToken, sha256 } from "../encoding.ts";
import { importSigningKey, type PrivateSigningJwk, signJws, toPublicJwk } from "../jose.ts";
import { PROFILES, type ProfileName } from "../profiles.ts";
import { createDevIdp, type DevIdp } from "../provider.ts";
import type { TokenResponse } from "../tokens.ts";
import {
  type AuthorizationOutcome,
  CookieJar,
  completeAuthorization,
  type FetchLike,
  type SignInChoice,
} from "./browser.ts";

/** Milliseconds since the epoch that only move when told to. Same shape as `ManualClock` in core. */
export class ManualClock {
  private current: number;

  /** Starts at the real time (whole seconds), so a relying party on the system clock agrees. */
  constructor(startMs: number = Math.floor(Date.now() / 1000) * 1000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError("ManualClock cannot go backwards");
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

export const TEST_REDIRECT_URI = "https://rp.test/callback";
export const TEST_POST_LOGOUT_URI = "https://rp.test/signed-out";

/** Secrets of the test clients (development values). */
export const TEST_CLIENT_SECRETS: Readonly<Record<string, string>> = {
  "confidential-basic": "confidential-basic-secret",
  "confidential-post": "confidential-post-secret",
  "es256-client": "es256-client-secret-value",
};

const APPLE_STYLE = { teamId: "DEVTEAM001", keyId: "DEVKEY0001" } as const;

/** One client per authentication method and algorithm, all redirecting to `https://rp.test`. */
export const TEST_CLIENTS: readonly DevIdpClient[] = [
  {
    clientId: "confidential-basic",
    displayName: "Test application (client_secret_basic)",
    clientSecret: "confidential-basic-secret",
    tokenEndpointAuthMethods: ["client_secret_basic"],
    redirectUris: [TEST_REDIRECT_URI],
    postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
  },
  {
    clientId: "confidential-post",
    displayName: "Test application (client_secret_post)",
    clientSecret: "confidential-post-secret",
    tokenEndpointAuthMethods: ["client_secret_post"],
    redirectUris: [TEST_REDIRECT_URI],
    postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
  },
  {
    clientId: "public-spa",
    displayName: "Test single-page application (public, PKCE)",
    redirectUris: [TEST_REDIRECT_URI],
    postLogoutRedirectUris: [TEST_POST_LOGOUT_URI],
    accessTokenAudience: ["test-api", "account"],
  },
  {
    clientId: "apple-style",
    displayName: "Test application (JWT client secret)",
    signedClientSecret: { ...APPLE_STYLE, publicKey: toPublicJwk(DEVELOPMENT_APPLE_CLIENT_KEY) },
    redirectUris: [TEST_REDIRECT_URI],
  },
  {
    clientId: "es256-client",
    displayName: "Test application (ES256)",
    clientSecret: "es256-client-secret-value",
    tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"],
    idTokenSignedResponseAlg: "ES256",
    redirectUris: [TEST_REDIRECT_URI],
  },
];

/** The test clients a profile can register (Apple accepts client_secret_post only, Google no public clients). */
export function testClients(profile: ProfileName): DevIdpClient[] {
  const supported = PROFILES[profile].tokenEndpointAuthMethods;
  return TEST_CLIENTS.flatMap((client) => {
    const methods =
      client.tokenEndpointAuthMethods ??
      (client.signedClientSecret
        ? ["client_secret_post"]
        : client.clientSecret
          ? ["client_secret_basic"]
          : ["none"]);
    const usable = methods.filter((method) => supported.includes(method));
    return usable.length ? [{ ...client, tokenEndpointAuthMethods: usable }] : [];
  });
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: base64UrlEncode(await sha256(verifier)) };
}

/**
 * A reference Apple client secret: ES256, `iss` team id, `sub` client id, `aud` issuer. The
 * relying party builds its own in production code; this one is for tests.
 */
export async function createAppleClientSecret(input: {
  privateKey?: PrivateSigningJwk;
  teamId?: string;
  keyId?: string;
  clientId: string;
  audience: string;
  nowSec?: number;
  lifetimeSec?: number;
}): Promise<string> {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const key = await importSigningKey(input.privateKey ?? DEVELOPMENT_APPLE_CLIENT_KEY);
  return signJws(
    { alg: "ES256", kid: input.keyId ?? APPLE_STYLE.keyId },
    {
      iss: input.teamId ?? APPLE_STYLE.teamId,
      sub: input.clientId,
      aud: input.audience,
      iat: now,
      exp: now + (input.lifetimeSec ?? 3600),
    },
    key,
  );
}

export interface TestIssuerOptions extends Partial<Omit<DevIdpOptions, "environment" | "clock">> {
  /** Default `https://dev-idp.test`. Only this origin is served by `issuer.fetch`. */
  issuer?: string;
  clock?: ManualClock;
}

export interface SignInRequest extends SignInChoice {
  clientId?: string;
  redirectUri?: string;
  /** Default `openid email profile` (whatever of it the client may request). */
  scope?: string;
  /** `false` sends none. Default: a random value. */
  state?: string | false;
  nonce?: string | false;
  /** Default true. */
  pkce?: boolean;
  prompt?: string;
  maxAge?: number;
  loginHint?: string;
  responseMode?: "query" | "form_post";
  /** More authorisation parameters, sent as given. */
  extra?: Record<string, string>;
  jar?: CookieJar;
}

export interface SignInResult {
  outcome: AuthorizationOutcome;
  state: string | null;
  nonce: string | null;
  verifier: string | null;
  authorizationUrl: URL;
}

type RequestInitLike = ConstructorParameters<typeof Request>[1];

export interface TestIssuer {
  readonly idp: DevIdp;
  readonly issuer: string;
  readonly clock: ManualClock;
  /** Serves the issuer's origin in-process; any other URL is refused (no accidental network). */
  readonly fetch: FetchLike & ((input: string | URL, init?: RequestInitLike) => Promise<Response>);
  /** Builds an authorisation URL for a test client and completes it on the sign-in page. */
  signIn(request?: SignInRequest): Promise<SignInResult>;
  /** Completes an authorisation URL an application produced. */
  completeAuthorization(
    url: string | URL,
    choice: SignInChoice,
    jar?: CookieJar,
  ): Promise<AuthorizationOutcome>;
  /** Redeems a code as a test client would (the kit's own client: not an independent check). */
  redeem(
    outcome: AuthorizationOutcome,
    input: { clientId?: string; verifier: string | null; redirectUri?: string },
  ): Promise<TokenResponse>;
}

/** Client authentication for the kit's own test clients. */
export async function testClientAuthentication(
  issuer: string,
  clientId: string,
): Promise<{ headers: Record<string, string>; body: Record<string, string> }> {
  const client = TEST_CLIENTS.find((candidate) => candidate.clientId === clientId);
  if (!client) throw new Error(`Not a test client: ${clientId}`);
  if (client.signedClientSecret) {
    return {
      headers: {},
      body: {
        client_id: clientId,
        client_secret: await createAppleClientSecret({ clientId, audience: issuer }),
      },
    };
  }
  const secret = TEST_CLIENT_SECRETS[clientId];
  if (secret === undefined) return { headers: {}, body: { client_id: clientId } };
  if (client.tokenEndpointAuthMethods?.[0] === "client_secret_post") {
    return { headers: {}, body: { client_id: clientId, client_secret: secret } };
  }
  const form = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
  return {
    headers: { Authorization: `Basic ${btoa(`${form(clientId)}:${form(secret)}`)}` },
    body: {},
  };
}

/** Starts an in-process issuer: strict configuration (in-memory store), `test` environment. */
export function startTestIssuer(options: TestIssuerOptions = {}): TestIssuer {
  const clock = options.clock ?? new ManualClock();
  const issuer = options.issuer ?? "https://dev-idp.test";
  const profile = options.profile ?? "generic";
  const idp = createDevIdp({
    ...options,
    issuer,
    profile,
    environment: "test",
    clock,
    clients: options.clients ?? testClients(profile),
  });
  const origin = new URL(issuer).origin;
  const fetchImpl = async (
    input: Request | string | URL,
    init?: RequestInitLike,
  ): Promise<Response> => {
    // `RequestInit` names the init with the runtime's default request properties, so the
    // constructed request has the same type as the one passed in (Workers' types are generic).
    const request = input instanceof Request ? input : new Request(input, init as RequestInit);
    if (new URL(request.url).origin !== origin) {
      throw new TypeError(`The in-process issuer serves ${origin} only, not ${request.url}`);
    }
    return idp.fetch(request);
  };
  const fetch = fetchImpl as TestIssuer["fetch"];

  return {
    idp,
    issuer,
    clock,
    fetch,

    async signIn(request = {}) {
      const clientId = request.clientId ?? idp.clientIds[0] ?? "";
      const state = request.state === false ? null : (request.state ?? randomToken(16));
      const nonce = request.nonce === false ? null : (request.nonce ?? randomToken(16));
      const pkce = request.pkce === false ? null : await createPkce();
      const url = new URL(`${issuer}/authorize`);
      const allowed = PROFILES[profile].scopes;
      const scope =
        request.scope ??
        ["openid", "email", "profile", "name"].filter((s) => allowed.includes(s)).join(" ");
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", request.redirectUri ?? TEST_REDIRECT_URI);
      url.searchParams.set("scope", scope);
      if (state !== null) url.searchParams.set("state", state);
      if (nonce !== null) url.searchParams.set("nonce", nonce);
      if (pkce) {
        url.searchParams.set("code_challenge", pkce.challenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      if (request.prompt !== undefined) url.searchParams.set("prompt", request.prompt);
      if (request.maxAge !== undefined) url.searchParams.set("max_age", String(request.maxAge));
      if (request.loginHint !== undefined) url.searchParams.set("login_hint", request.loginHint);
      const mode = request.responseMode ?? (profile === "apple" ? "form_post" : undefined);
      if (mode !== undefined) url.searchParams.set("response_mode", mode);
      for (const [name, value] of Object.entries(request.extra ?? {}))
        url.searchParams.set(name, value);
      const outcome = await completeAuthorization(url, request, { fetch, jar: request.jar });
      return { outcome, state, nonce, verifier: pkce?.verifier ?? null, authorizationUrl: url };
    },

    completeAuthorization(url, choice, jar) {
      return completeAuthorization(url, choice, { fetch, jar });
    },

    async redeem(outcome, input) {
      const clientId = input.clientId ?? idp.clientIds[0] ?? "";
      const auth = await testClientAuthentication(issuer, clientId);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: outcome.code ?? "",
        redirect_uri: input.redirectUri ?? TEST_REDIRECT_URI,
        ...auth.body,
      });
      if (input.verifier !== null) body.set("code_verifier", input.verifier);
      const response = await fetch(
        new Request(`${issuer}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...auth.headers },
          body,
        }),
      );
      const json = (await response.json()) as TokenResponse & {
        error?: string;
        error_description?: string;
      };
      if (!response.ok) throw new Error(`Token endpoint: ${json.error}: ${json.error_description}`);
      return json;
    },
  };
}

export { CookieJar };
