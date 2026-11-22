# @webflix/dev-idp

A development OpenID Provider: the local stand-in for Google, Apple and the staff Keycloak realm
(docs/BLUEPRINT-M2.md §4.4), and a test kit that lets a relying party prove its validation against
the attacks it must reject. Web-standard APIs only (fetch `Request`/`Response`, Web Crypto): the same
code serves on Node and inside a Cloudflare Worker. No runtime dependencies.

**It signs anyone in as anyone.** `createDevIdp`, `createDevIdpHost` and `createWebflixDevIdp`
throw unless `environment` is exactly `development` or `test` (an allow-list: `production`, a typo
or an unset variable all fail closed). Its keys and client secrets are published development values.

Contents: [Mounting](#mounting-it) · [Tests](#starting-it-in-tests) ·
[Configuration](#configuration-reference) · [Protocol](#protocol-surface) ·
[State and guarantees](#state-without-a-server-store) · [Faults](#fault-catalogue) ·
[Differences from the real issuers](#how-this-differs-from-google-apple-and-keycloak) ·
[Security of the stand-in](#security-of-the-stand-in-itself) · [This package's own tests](#how-it-is-proven)

## Mounting it

`createWebflixDevIdp` builds the three issuers every local mode needs, under one mount point:

| Realm | Issuer | Behaves like | Client (`WEBFLIX_DEV_CLIENTS`) |
| --- | --- | --- | --- |
| `google` | `{origin}/dev-idp/google` | Google | `webflix-web`, secret `dev-only-google-client-secret` (basic or post), callback `/api/v1/auth/oidc/google/callback` |
| `apple` | `{origin}/dev-idp/apple` | Sign in with Apple | `dev.webflix.web`, ES256 JWT client secret (team `DEVTEAM001`, key `DEVKEY0001`, private key `DEVELOPMENT_APPLE_CLIENT_KEY`), callback `/api/v1/auth/oidc/apple/callback` |
| `staff` | `{origin}/dev-idp/staff` | Keycloak | `webflix-admin`, public (PKCE), callback `/admin/auth/callback`, post-logout `/admin/`, access-token audience `webflix-admin-api`; and the jobs' service account (`staffJobs`): `webflix-jobs`, secret `dev-only-jobs-client-secret` (basic or post), client credentials at `{origin}/dev-idp/staff/token`, roles `admin` and `experiments` |

```ts
// apps/api (Node, Hono)
import { createWebflixDevIdp } from "@webflix/dev-idp";

if (config.environment !== "production") {
  const devIdp = createWebflixDevIdp({
    environment: config.environment, // throws unless development or test
    origin: config.publicOrigin, // the origin browsers use; the issuer is never taken from Host
    appOrigins: [config.publicOrigin], // where the callbacks live (exact redirect URIs)
    secret: process.env.WEBFLIX_DEV_IDP_SECRET, // required as soon as there is more than one replica
  });
  app.all("/dev-idp/*", (c) => devIdp.fetch(c.req.raw));
}
```

```ts
// apps/edge (Worker): construct inside a request (no random values at global scope), once per isolate.
let devIdp: DevIdpHost | undefined;
// in fetch():
if (env.WEBFLIX_ENV !== "production" && url.pathname.startsWith("/dev-idp/")) {
  devIdp ??= createWebflixDevIdp({ environment: env.WEBFLIX_ENV, origin, secret: env.WEBFLIX_DEV_IDP_SECRET });
  return devIdp.fetch(request);
}
```

- Every isolate or replica must share `secret` (32+ characters); otherwise each seals with random
  bytes of its own and a code minted by one is refused by another (it fails closed). Signing keys
  need no configuration: the shipped development keys are the same everywhere, so JWKS caches
  survive restarts.
- The handler sets its own `Content-Security-Policy`, `Cache-Control`, `Referrer-Policy` and
  `X-Frame-Options`. The Webflix app middleware (`packages/http`) keeps an existing CSP but
  overwrites `Referrer-Policy` with `strict-origin-when-cross-origin` and adds
  `Cross-Origin-Resource-Policy: same-origin`; the pages also carry
  `<meta name="referrer" content="no-referrer">`, so authorisation parameters still do not leak,
  and only the persona avatars become same-origin (harmless when the application is on the same
  origin). Mount the handler before that middleware, or exempt `/dev-idp/*`, to keep the issuer's
  own headers.
- When the issuer is mounted in the same process as the relying party, the relying party can call
  `devIdp.fetch` directly for discovery, JWKS and the token endpoint instead of going over the
  network (give the `IdentityProvider` adapter a `fetch` option).
- `createDevIdp` (one issuer) and `createDevIdpHost` (several, any configuration) are the building
  blocks; `webflixRealms({ appOrigins })` returns the realm options above for reuse.

## Starting it in tests

```ts
import { startTestIssuer } from "@webflix/dev-idp/testing";

const issuer = startTestIssuer({ profile: "google" }); // in-process, strict store, environment "test"
issuer.issuer; // "https://dev-idp.test"
issuer.fetch; // serves that origin only; anything else throws (no accidental network)
issuer.clock; // ManualClock, starting at the real time in whole seconds; share it with the RP
```

Drive a sign-in the relying party started, without a browser:

```ts
const start = await app.request("/api/v1/auth/oidc/google/start");
const outcome = await issuer.completeAuthorization(start.headers.get("Location")!, { persona: "demo-verified" });
// outcome.code, .state, .iss, .error, .user (Apple), .mode ("query" | "form_post")
const callback = outcome.toRequest({ headers: { Cookie: rpTransactionCookie } }); // GET, or POST for form_post
await app.request(callback);
```

`SignInChoice`: `{ persona }` or `{ email: { address, name?, verified? } }`, plus `faults`,
`cancel` (the application receives `access_denied`) and `firstAuthorisation` (Apple). Pass a
`CookieJar` to keep the issuer session between sign-ins (single sign-on, `prompt=none`).

On a real port (Node only):

```ts
import { startDevIdpServer, startDevIdpHostServer } from "@webflix/dev-idp/node";

const server = await startDevIdpServer({ environment: "test", clients, profile: "keycloak", port: 5450 });
server.issuer; // "http://127.0.0.1:5450"; listens on 127.0.0.1 unless told otherwise
await server.close();
```

`completeAuthorization(url, choice, { fetch: globalThis.fetch })` drives a remote issuer the same way.

Other tools: `idp.mintTokens({ persona, clientId, scope?, nonce?, authTime?, faults? })` returns a
token response without a flow (for resource servers such as the admin API's `StaffVerifier`);
`idp.keys.rotate(alg?)`, `idp.keys.retire(kid)`, `idp.keys.jwks()`, `idp.keys.list()`;
`idp.faults.set(...)` / `.clear()`; `createPkce()`; `createAppleClientSecret({ clientId, audience })`;
`TEST_CLIENTS` (one client per authentication method and algorithm, redirecting to
`https://rp.test/callback`) and `testClients(profile)`.

## Configuration reference

`createDevIdp(options: DevIdpOptions)`:

| Option | Default | Meaning |
| --- | --- | --- |
| `issuer` | required | Exact issuer identifier, `http(s)://host[:port][/path]`, canonical, no trailing slash. Requests are routed by its path. |
| `environment` | required | `development` or `test`; anything else throws. |
| `profile` | `generic` | `generic`, `google`, `apple` or `keycloak` (below). |
| `clients` | required | `DevIdpClient[]` (below). |
| `personas` | the profile's | `DevIdpPersona[]` (below). |
| `keys` | the profile's development keys | Private JWKs (RS256 with RSA ≥ 2048, ES256 with P-256), or `{ jwk, status }`. Per algorithm the first is `current`, the rest `next`. |
| `secret` | 32 random bytes | Seals codes, sessions, refresh tokens and opaque access tokens. Share it across instances. |
| `store` | `"memory"` | A `DevIdpStore`, `"memory"` or `"none"` (see the guarantees table). |
| `clock` | system clock | `{ now(): number }` (ms); `ManualClock` from the kit, or core's. |
| `lifetimes` | below | Seconds: `codeSec` 60 (max 600), `transactionSec` 600 (sign-in page), `idTokenSec` 600, `accessTokenSec` 300, `refreshTokenSec` 43200, `refreshFamilySec` 86400 (absolute), `sessionSec` 43200. |
| `faults` | none | Standing faults from the start. |
| `faultPicker` | `true` | Offer fault injection on the sign-in page. |
| `logger` | none | `{ info, warn }`. Receives identifiers only (client id, persona id, error code): never codes, tokens, secrets or state. |

`DevIdpClient`:

| Field | Default | Meaning |
| --- | --- | --- |
| `clientId` | required | `[A-Za-z0-9._~-]{1,128}` |
| `redirectUris` | required | Exact-match list; http(s), no fragment. A registered query string is kept and the response parameters appended. May be empty for a client with `serviceAccount` only. |
| `postLogoutRedirectUris` | `[]` | Exact-match list for end-session. |
| `tokenEndpointAuthMethods` | `["none"]` without a secret, `["client_secret_post"]` with `signedClientSecret`, else `["client_secret_basic"]` | Methods the client may use; must be ones the profile advertises. |
| `clientSecret` | — | Shared secret, 16+ characters. |
| `signedClientSecret` | — | `{ teamId, keyId, publicKey, maxLifetimeSec = 15777000 }`: Apple's ES256 JWT client secret (`iss` team, `sub` client id, `aud` issuer). |
| `idTokenSignedResponseAlg` | `RS256` | `RS256` or `ES256`. |
| `accessTokenSignedResponseAlg` | the ID token's | For JWT access tokens. |
| `accessTokenFormat` | the profile's | `jwt` or `opaque`. |
| `accessTokenAudience` | the client id | `aud` of JWT access tokens (string or array). |
| `allowedScopes` | the profile's scopes | |
| `requirePkce` / `requireState` / `requireNonce` | `true` | PKCE cannot be turned off for public clients. |
| `allowedCorsOrigins` | the redirect URIs' origins | Browser origins for the token and userinfo endpoints. |
| `serviceAccount` | — | `{ roles?: { realm?, clients? } }`: the client may use the client credentials grant (generic and keycloak profiles only; needs `clientSecret`). Its tokens are for the realm user `service-account-<clientId>` with these roles, as a Keycloak client with service accounts enabled. |

`DevIdpPersona`: `id` (`[a-z0-9-]`), `description`, `sub` (default: derived from issuer and id,
shaped like the profile's), `email` (`null` means no email claim), `emailVerified` (default true),
`name` (a string, `null`, or a list that cycles on every sign-in), `picture` (default: an SVG the
issuer serves), `isPrivateEmail`, `roles: { realm?, clients? }` (Keycloak's `realm_access.roles`
and `resource_access.<client>.roles`), `claims` (extra claims; protocol claims are refused).

Shipped personas:

| Id | Profiles | What it exercises |
| --- | --- | --- |
| `new-member` | generic, google, apple | A new user: no Webflix account has the email. |
| `demo-verified` | generic, google, apple | `demo@webflix.dev` (the seeded demo account), `email_verified` true: automatic linking is allowed. |
| `demo-unverified` | generic, google, apple | The same email, `email_verified` false: no silent takeover. Another `sub`. |
| `no-email` | generic, google, apple | No email claim at all. |
| `renamed` | generic, google, apple | The name changes on every sign-in (Sam Rivera, Samantha Rivera-Ortiz, Sam R.). |
| `private-relay` | apple | A private relay address, `is_private_email` "true". |
| `staff-support`, `staff-billing`, `staff-content`, `staff-experiments`, `staff-admin` | generic, keycloak | One Webflix role each, in `resource_access.webflix-admin.roles`, plus Keycloak's default realm roles and `account` client roles (noise a role mapping must ignore). |
| `staff-no-role` | generic, keycloak | A staff account without any Webflix role. |
| `staff-other-client-admin` | generic, keycloak | `admin` for another client only (`resource_access.other-app`): no Webflix role. |

On the sign-in page anyone can also type an email address: the issuer mints a persona for it
(stable `sub` per address, case-insensitive), with an optional name and a "verified" checkbox.

Profiles (checked against each provider's published discovery document, November 2026):

| | generic | google | apple | keycloak |
| --- | --- | --- | --- | --- |
| Scopes | openid email profile offline_access | openid email profile | openid email name | openid email profile offline_access roles |
| `sub` | UUID | 21 digits | `000123.<32 hex>.0456`, pairwise | UUID |
| `email_verified` | boolean | boolean | the string `"true"` / `"false"` | boolean |
| Name, picture in the ID token | with `profile` | with `profile` | never: `user` form field, first authorisation only | with `profile` |
| Access token | JWT, `typ: at+jwt` (RFC 9068) | opaque | opaque | JWT, `typ: JWT`, claim `typ: Bearer`, `azp`, roles |
| Userinfo | yes | yes | no | yes |
| End-session | yes | no | no | yes |
| Refresh token | with `offline_access` | with `access_type=offline` | always | always |
| Client credentials grant | yes (clients with `serviceAccount`) | no | no | yes (clients with `serviceAccount`) |
| `iss` in the authorisation response (RFC 9207) | yes | yes | no | yes |
| `azp` in the ID token | yes | yes | no | yes |
| `response_mode` | query, form_post | query, form_post | form_post required with `email` or `name` | query, form_post |
| Client authentication | basic, post, none | post, basic | post (JWT secret) | basic, post, none |

## Protocol surface

Endpoints, relative to the issuer: `/.well-known/openid-configuration`, `/jwks`,
`/authorize` (GET and POST), `/authorize/select` (the sign-in page's form), `/token`,
`/userinfo` (GET and POST), `/logout`, `/avatars/<hex>.svg`.

- **Authorisation**: `response_type=code` only. `client_id` and `redirect_uri` are validated
  first; until both are trusted, errors are shown on a page and never redirected (no open
  redirect). Exact redirect URI matching. `scope` must contain `openid`; unknown scopes are
  refused (`invalid_scope`). `state` (up to 1024) and `nonce` (up to 512) are printable ASCII
  (VSCHAR, RFC 6749 Appendix A.5) and required by default. PKCE with S256 (`plain` and
  a challenge without a method are refused; required for public clients, and by default for all).
  `prompt` = `none` | `login` | `select_account` | `consent` (shows the page). `max_age` (with
  `max_age=0` always re-authenticating), `login_hint` (persona id or email; preselects, prefills
  an unknown address, and with a session for someone else means `login_required` under
  `prompt=none`). `response_mode` = `query` | `form_post`. Repeated parameters are refused.
  Responses carry `iss` where the profile does. Cancel on the page returns `access_denied`.
- **Token**: `authorization_code` (code bound to client, redirect URI, PKCE challenge; single use;
  a replay revokes the grant; a `code_verifier` for a code issued without a challenge is refused as
  a downgrade) and `refresh_token` (rotation on every use; reuse revokes the family; a narrower
  `scope` applies to the tokens issued, while the new refresh token keeps the original scope,
  RFC 6749 §6; absolute family lifetime; the new ID token keeps `sub` and `auth_time`, has no
  `nonce`). Client
  authentication by `client_secret_basic` (RFC 6749 §2.3.1 encoding), `client_secret_post`, Apple's
  JWT client secret and `none`, one method per request, constant-time comparison.
  `client_credentials` (generic, keycloak; RFC 6749 §4.4) for a confidential client configured
  with `serviceAccount` (`unauthorized_client` for any other): an access token only, no refresh or
  ID token, Keycloak's service-account shape (`sub` the service-account user, `azp` the client,
  `preferred_username: service-account-<clientId>`, the configured roles, `typ: Bearer`). Without
  `scope` it grants the client's scopes other than `openid` and `offline_access`; asking for
  either is `invalid_scope`. Standing faults on access tokens apply.
  `Cache-Control: no-store`.
- **ID token**: `iss`, `sub`, `aud`, `exp`, `iat`, `auth_time` (always), `nonce`, `at_hash`,
  `azp`, `sid`, `email`, `email_verified`, `name`, `given_name`, `family_name`, `picture`, plus
  each profile's own claims. RS256 or ES256 per client, `kid` in the header.
- **Access token**: a signed JWT a resource server validates offline through the JWKS (generic,
  keycloak), or opaque (google, apple). Keycloak shape: `realm_access.roles`,
  `resource_access.<client>.roles`, `azp`, `scope`, `typ: Bearer`.
- **Userinfo**: bearer token in the `Authorization` header only; the claims the scopes release;
  RFC 6750 errors. Honours revocation (grant replay, refresh reuse, end-session) when there is a store.
- **End-session** (RP-Initiated Logout 1.0): with a valid `id_token_hint` (expired allowed) whose
  `sid` is the current session's, it signs out at once; otherwise (no hint, or a hint from another
  session) it asks for confirmation (CSRF-protected). Redirects only to a
  `post_logout_redirect_uri` registered for the client the request identifies.
- **JWKS**: per algorithm, the current and the next key (so at least two per algorithm), plus the
  previous key after a rotation. Public members only. `idp.keys.rotate()` moves `next` to
  `current` and generates a new `next`; a second rotation retires the oldest.

Deliberately unsupported: implicit and hybrid flows, `response_mode=fragment`, PKCE `plain`,
request objects (`request`, `request_uri`), PAR, dynamic registration, `claims` parameter,
`private_key_jwt` and `client_secret_jwt` client assertions, the client credentials grant for a
client without a service account (and on the google and apple profiles), the password and device
grants, token introspection and revocation endpoints, front- and back-channel logout,
DPoP and mTLS, encrypted tokens, `acr`/`amr`, consent screens, `id_token_hint` on `prompt=none`
(ignored). Discovery says so (`request_parameter_supported: false` and so on).

## State without a server store

Workers have no memory shared between isolates, so nothing the protocol needs to read back lives
in a process-local map:

- **Sealed and self-contained**: authorisation codes, the sign-in page's transaction, the issuer
  session cookie, refresh tokens and opaque access tokens are AES-256-GCM sealed JSON, with a key
  per purpose and per issuer derived by HKDF from `secret`. Any instance with the secret can read
  them; nobody without it can forge or alter them; a session cannot be replayed as a code; a code
  of one issuer is refused by another issuer even when they share the secret.
- **A small store where single use or revocation genuinely needs state**: `DevIdpStore` has two
  operations, `claim(key, expiresAt)` (atomic insert-if-absent, true for the first caller) and
  `has(key)`. It records used codes, used refresh tokens, revoked grants, ended sessions and (for
  Apple) first authorisations. Keys are namespaced per issuer.
- **Which backend**: no existing Webflix port fits. `KeyValueCache` is eventually consistent and
  `RateLimiter` lets the adapter choose its window algorithm (a fixed window can reset before a
  code expires), so neither can promise single use. A deployment that needs cross-instance
  guarantees implements `DevIdpStore` on the same infrastructure the `RateLimiter` adapters use: a
  Durable Object on Cloudflare (like `RateLimiterObject` in `@webflix/adapters-cloudflare`), Valkey
  `SET key 1 NX PXAT expiresAt` on Kubernetes (like the Valkey rate limiter in
  `@webflix/adapters-node`), or a table with a unique key and `INSERT ... ON CONFLICT DO NOTHING`.
- **Default**: `store: "memory"`, strict within one process. Everywhere tests run
  (`startTestIssuer`, the Node servers) uses it; `store: "none"` must be asked for.

| Guarantee | `"memory"`, one process (default, tests) | Shared `DevIdpStore` | `"memory"`, several instances (replicas, isolates) | `"none"` |
| --- | --- | --- | --- | --- |
| A code is redeemed at most once | yes | yes | per instance: a replay on another instance succeeds | **no**: a code can be redeemed again until it expires (60 s) |
| A replayed code revokes what the first redemption obtained (refresh tokens; userinfo for its access tokens) | yes | yes | per instance | no |
| A rotated-out refresh token presented again revokes the whole family | yes | yes | per instance | **no**: rotated-out tokens keep working until they expire (12 h, family 24 h) |
| End-session ends the issuer session for copies of the cookie, its refresh tokens and (at userinfo) its access tokens | yes | yes | per instance | the cookie is cleared; a copied cookie signs in until it expires (12 h) |
| Code bound to client, redirect URI, PKCE challenge and nonce; codes expire in 60 s | yes | yes | yes, with a shared `secret` (otherwise refused across instances) | yes |
| Codes, cookies and refresh tokens unforgeable; purposes and issuers separated | yes | yes | yes | yes |
| Revocation visible to a resource server validating JWT access tokens offline | no (tokens live 5 min) | no | no | no |
| Apple's name sent only on the first authorisation (remembered 30 days) | per process | across instances | per instance | per process |

The one-process, shared-store and `"none"` columns are tested in `test/state.test.ts` (with
`test/token.test.ts` for replay revocation and `test/personas-host.test.ts` for Apple's name); for
several instances, the tests show a shared secret and a shared store make codes work and stay
single-use across instances, and that a store per instance does not detect a replay elsewhere.

## Fault catalogue

Each fault is one named option. Flow faults (every scope but `endpoint`) apply to one sign-in when
ticked on the sign-in page or passed as `faults` to `completeAuthorization`, `signIn` or
`mintTokens`; `idp.faults.set({...})` makes any fault standing (every flow, refreshes, silent
sign-ins) until `idp.faults.clear()`. The page is skipped by single sign-on, so a flow fault needs
a fresh browser (cookie jar), `prompt=login`, or a standing fault. Token faults apply to the ID
token unless given a target: `{ expired: { target: "access_token" } }` (or `"both"`; on the page's
form, `fault=expired:access_token`). Aimed at an opaque access token (Google, Apple), a token
fault makes the issuer's userinfo refuse it, as only the issuer can read one. Identity faults stay
with the grant through refreshes. The values for `jwksSlow` and `jwksFailing` are
`{ delayMs }` and `{ status }`. The catalogue is exported as `FAULT_CATALOGUE`.

| Fault | Applies to | The issuer | A correct relying party |
| --- | --- | --- | --- |
| `unknownKey` | token | Signs with a key that was never published, under a kid no JWKS of this issuer lists. | Refetch the JWKS at most once for an unknown kid (rate limited), still find no key, reject. |
| `removedKey` | token | Signs with a key the issuer used to publish and has since removed from its JWKS (a revoked key). | Reject once its JWKS cache is refreshed; never keep trusting a kid the current JWKS lacks beyond its cache lifetime. |
| `algNone` | token | Sends an Unsecured JWS: header alg none, empty signature. | Reject: only the algorithms configured for this issuer (RS256, ES256) are acceptable. |
| `hmacKeyConfusion` | token | Header alg HS256 with the kid of the current public key; the MAC is keyed with that public key's PEM (SubjectPublicKeyInfo, trailing newline). | Reject: choose the algorithm from configuration and the key type, never from the token header. |
| `embeddedJwk` | token | Signs with an unpublished key and puts its public half in the header's jwk member (jku and x5u are not used). | Ignore keys carried by the token; verify only with the issuer's JWKS. |
| `wrongIssuer` | token | Signs correctly, with iss set to another issuer (this issuer's URL plus -mixup). | Reject unless iss equals the configured issuer exactly. |
| `wrongAudience` | token | Signs correctly, with aud naming another client. | Reject unless aud contains its own client id (or, for access tokens, its resource). |
| `extraAudience` | token | aud is an array: the right client and another one; azp names the right client. | Reject an ID token whose aud lists audiences it does not trust (OpenID Connect Core §3.1.3.7). |
| `expired` | token | iat one hour ago, exp ten minutes ago: beyond any reasonable clock-skew allowance. | Reject (allow at most a small, configured skew). |
| `notYetValid` | token | iat and nbf ten minutes in the future. | Reject tokens issued or valid in the future beyond the configured skew. |
| `wrongNonce` | ID token | The ID token carries a nonce other than the one in the authorisation request. | Reject: the nonce must equal the one bound to this browser's transaction. |
| `missingNonce` | ID token | The ID token has no nonce although the request sent one. | Reject when a nonce was sent and the ID token lacks it. |
| `wrongAtHash` | ID token | at_hash is the hash of a different access token. | When at_hash is present, recompute it over the access token received and reject a mismatch. |
| `staleAuthTime` | ID token | auth_time is one day old even when the request asked for max_age (for example max_age=0). | When it sent max_age, reject unless now - auth_time <= max_age (plus skew); never treat it as a fresh sign-in. |
| `missingAuthTime` | ID token | The ID token omits auth_time even when the request sent max_age. | When it sent max_age, reject an ID token without auth_time. |
| `emailUnverified` | identity | Asserts the persona's email with email_verified false. | Never link to or sign in an existing account by this email; continue sign-up or require proof. |
| `emailVerifiedAbsent` | identity | Asserts the email without an email_verified claim. | Treat an absent email_verified as false. |
| `subjectChanged` | identity | Issues a different sub for the persona while keeping its email. | Key identities by (iss, sub) only; a new sub with a known email is a new identity, linked only under the verified-email rule. |
| `idTokenAsAccessToken` | token response | The token response's access_token is the ID token itself. | A resource server rejects it: an ID token is not an access token (check typ, aud, and the token's purpose). |
| `jwksRotatedMidFlow` | token response | Signs this response's tokens with a brand-new key that no JWKS listed until now; the JWKS lists it from this moment (on this instance; at most two such keys per algorithm). Other tokens keep the current key. | On an unknown kid, refetch the JWKS once and accept the token if the key is now published. |
| `codeForAnotherClient` | authorisation response | The authorisation response carries a code minted for a different client; the token endpoint refuses it (invalid_grant). | Show a failed sign-in; do not retry the code or fall back to anything else. |
| `codeReplay` | authorisation response | The authorisation response carries a code that was already redeemed; the token endpoint refuses it (invalid_grant). Needs a store. | Show a failed sign-in. Its own callback must also refuse to process the same authorisation response twice. |
| `pkceMismatch` | authorisation response | The code is bound to a different code_challenge (an injected code); the token endpoint refuses the relying party's verifier. | Show a failed sign-in; never retry without PKCE. |
| `tamperedState` | authorisation response | The authorisation response returns a state that differs from the one sent. | Reject before redeeming the code: state must match this browser's transaction. |
| `wrongResponseIssuer` | authorisation response | The authorisation response's iss parameter names another issuer. | When the issuer advertises authorization_response_iss_parameter_supported, reject a response whose iss differs. |
| `discoveryIssuerMismatch` | endpoint (standing only) | The discovery document's issuer differs from the URL it was fetched from. | Refuse the configuration (OpenID Connect Discovery §4.3); do not sign anyone in. |
| `jwksSlow` | endpoint (standing only) | The JWKS endpoint answers after delayMs (default 5000). | Time out, fail the sign-in cleanly, and keep serving everything that does not need the issuer. |
| `jwksFailing` | endpoint (standing only) | The JWKS endpoint answers with an error status (default 503). | Fail the sign-in; keep using a cached JWKS for known kids; never accept a token it could not verify. |
| `userinfoSubjectMismatch` | endpoint (standing only) | The userinfo endpoint answers with a sub other than the ID token's. | Discard the userinfo response (OpenID Connect Core §5.3.2). |

The identity faults pass token validation by design: the relying party's account rules
(docs/BLUEPRINT-M2.md §4.1, linking only on a verified email, identities keyed by issuer and
subject) are what must catch them.

## How this differs from Google, Apple and Keycloak

A relying party must not learn these behaviours from the stand-in:

- **Same origin, same site.** Mounted under `/dev-idp/*`, the issuer shares the application's
  origin. Apple's `form_post` is then a same-site POST, so a `SameSite=Lax` transaction cookie
  survives it; with the real Apple it is a cross-site POST and a Lax cookie is not sent. The
  transaction cookie for a `form_post` provider must be `SameSite=None; Secure`. To see the real
  behaviour, run the issuer on another site (`startDevIdpServer` on `127.0.0.1` with the
  application on `localhost`).
- **Apple signs ID tokens with RS256**, as every key in its JWKS is RSA; ES256 is what the
  *relying party* uses to sign its client secret. The stand-in's Apple profile signs with RS256 by
  default; set `idTokenSignedResponseAlg: "ES256"` on a client to exercise the ES256 path.
- **Apple's `user` field is unsigned** and arrives only on the first authorisation, in the
  `form_post` body. Use it for the name only, never for identity or email. Apple has no userinfo
  and no end-session endpoint, and documents `email_verified` and `is_private_email` as "a string
  or Boolean": accept both forms. The stand-in sends strings.
- **Google may not honour `max_age` or send `auth_time`** (its discovery document does not list
  `auth_time`); the stand-in always sends it. The account-holder proof of §4.2 must fail closed when
  `auth_time` is absent (fault `missingAuthTime`). Google sends a refresh token only with
  `access_type=offline` (and in reality only on first consent), has no end-session endpoint, and
  accepts PKCE `plain` (the stand-in does not).
- **Access tokens.** Google's and Apple's are opaque: never parse them. Keycloak's are JWTs with
  header `typ: JWT` and claim `typ: Bearer` (not RFC 9068 `at+jwt`), `aud` usually an array
  including `account`; ID tokens carry claim `typ: ID`. A staff verifier must check the token type
  as well as `iss`, `aud`, signature and expiry.
- **Keys.** The default realms use published development keys, distinct per realm, stable across
  restarts. Real providers rotate on their own schedule without notice beyond publishing the next
  key; caching a JWKS by `kid` forever is wrong. Never configure a development key anywhere else.
- **Subjects** are deterministic per issuer and persona, shaped like the provider's. Treat `sub` as
  an opaque string of up to 255 characters; Apple's are pairwise per team.
- **Codes are long** (about 450 characters, sealed): real ones are shorter. Do not assume a length.
- **No consent, no account chooser, no password, no MFA**, no rate limits, no outages unless a
  fault says so. Real issuers also add claims the stand-in does not (`hd`, `locale`,
  `real_user_status` variations, `transfer_sub`, Keycloak mappers): ignore unknown claims.
- **Strictness may differ either way**: the stand-in refuses unknown scopes and repeated
  parameters and requires `state`, `nonce` and PKCE by default. A relying party that only works
  because the stand-in is lenient somewhere is a bug; tell the owners of this package.

## Security of the stand-in itself

It is mounted in shared local deployments next to the application's own cookies, so:

- No open redirects: client and redirect URI are checked before any redirect; exact matching;
  post-logout redirects only to registered addresses for an identified client.
- Pages: every interpolated value is HTML-escaped; CSP `default-src 'none'`, styles and the one
  form_post script by per-response nonce, `form-action` limited to the issuer and the client's
  redirect origin, `frame-ancestors 'none'`, `base-uri 'none'`; no external assets.
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- The sign-in and sign-out forms are bound to the browser by an `HttpOnly` CSRF cookie (double
  submit inside the sealed transaction) and refuse cross-site `Sec-Fetch-Site`. The cookie is
  `SameSite=Lax`: it must arrive with the cross-site navigation that opens the page, and a
  cross-site POST never carries it. It is path-scoped, so not `__Host-`: a sibling subdomain able
  to set cookies for the host could choose its value (not a concern on localhost).
- Cookies are scoped to the issuer's path, `HttpOnly`, `__Secure-` and `Secure` over https.
- Secrets, PKCE verifiers and CSRF values are compared in constant time (hash, then compare).
- Short lifetimes (code 60 s, page 10 min, access token 5 min). Request bodies are capped (32 KiB
  form, 1 MiB on the Node server). The issuer is configured, never taken from the Host header.
- Typed email addresses and `login_hint` may not contain control or invisible formatting
  characters. Per-instance memory is bounded; store markers all expire (Apple's
  first-authorisation record after 30 days).
- Logs carry identifiers only.

## How it is proven

`pnpm --filter @webflix/dev-idp test` runs the suite twice, on Node and inside workerd
(`@cloudflare/vitest-plugin`, the Workers runtime), plus Node-only tests of the real port and a
scan proving the runtime code, the kit and the shared suite import no Node API.

- `test/support/independent-rp.ts` is an independent relying party written only for the tests,
  from the specifications, sharing no code with the provider. `conformance.test.ts` walks every
  profile and client authentication method with it; `faults.test.ts` shows each fault is produced
  (asserted on the raw token) and rejected by the rule above.
- `oauth4webapi.test.ts` repeats the walk and the faults with
  [oauth4webapi](https://github.com/panva/oauth4webapi) 3.8.8 (dev dependency, zero dependencies,
  by the author of the OpenID-certified `openid-client`).
- One test file per endpoint covers its negative cases; `state.test.ts` covers the guarantees table.
