# Webflix — Foundation guide

How the workspace, the API contract and the ports work, and the conventions every package follows. Read `BLUEPRINT.md` first; this file is the practical companion.

---

## 1. Workspace

| Tool | Version | Notes |
| --- | --- | --- |
| Node | 26.8.1 (`.nvmrc`) | Runs TypeScript directly (type stripping): `node src/main.ts`. |
| pnpm | 10.5.2 (`packageManager`) | Pinned to the host version; newer pins make pnpm try to self-download. |
| TypeScript | 7.0.x | Native compiler. No `tsserver.js` in the package: editors use their bundled TS. |
| Turborepo | 2.11 | `envMode: loose`, so every env var reaches tasks. |
| Biome | 2.6 | Lint + format, one root `biome.json`. Markdown is not formatted. |
| Vitest | 5.1 | One version for the whole repo (see §7). |
| Playwright | 1.65 | `make setup` installs Chromium, Firefox and WebKit. |

Every version lives in the **pnpm catalog** in `pnpm-workspace.yaml`. Packages say `"zod": "catalog:"`.

```sh
pnpm install              # from the root
pnpm lint | typecheck | test   # the CI gate (also: make check)
pnpm --filter @webflix/core test       # one package
pnpm --filter @webflix/web add some-lib       # add a dependency (see below)
pnpm dev                  # api (:4000) + web (:5173); PORT / WEB_PORT / WEBFLIX_API_ORIGIN override
```

**Adding a dependency.** If it is already in the catalog, use `"<dep>": "catalog:"`. If not, add it to your package normally (`pnpm --filter <pkg> add <dep>`) and list it in your report: the root files (catalog, `onlyBuiltDependencies`, `turbo.json`, `biome.json`) stay unchanged during parallel work. pnpm 10 skips dependency install scripts unless the package is in `onlyBuiltDependencies`. Today that list is `esbuild`, `sharp`, `workerd`. If an install prints "Ignored build scripts", report it.

**Makefile.** The root `Makefile` holds the generic targets. Your area's targets go in your own fragment, which the root `-include`s:
`tools/media/media.mk`, `deploy/kind/k8s.mk`, `apps/edge/cloudflare.mk`, `e2e/e2e.mk`, `tools/smoke/smoke.mk`. Write `target: ## description` so `make help` lists it. To hook into `setup`, `clean` or `doctor`, use a double-colon rule (`setup:: content`).

**Ports used locally.** api 4000, web 5173, edge 8787, k8s 8080 (blueprint §8).

### Package conventions

- Every package is `@webflix/<dir>` and exports **TypeScript source**: `"exports": { ".": "./src/index.ts" }`. There is no build step for packages. Apps bundle (Vite, wrangler) or run TS directly (Node).
- **Relative imports carry the `.ts` extension** (`import { x } from "./x.ts"`). Node's type stripping needs it; Biome (`useImportExtensions`) enforces it.
- `erasableSyntaxOnly` is on: no `enum`, `namespace`, or constructor parameter properties. Use `as const` objects and plain fields.
- Strict TS plus `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax` (`import type`).
- `!` (non-null assertion) is a lint error. If one is truly needed, use `// biome-ignore lint/style/noNonNullAssertion: <why>`. Biome requires the reason.
- Tests live in `<package>/test/*.test.ts` and run with `vitest run`.
- **Type environment per package** (`tsconfig.json` `lib`/`types`):
  - `contracts`, `core`, `http`, `catalog`, `db`: `ES2024 + WebWorker`, no Node types. Biome also bans `node:` imports and `process.env` in `contracts`/`core`/`http`/`ui`/`player`/`apps/web/src`. **These packages are also typechecked by Node and Worker consumers, so don't use DOM-only type names** (`HeadersInit`, `RequestCredentials`, …). Derive them instead (`ConstructorParameters<typeof Headers>[0]`).
  - `apps/edge`, `adapters-cloudflare`: `@cloudflare/workers-types`.
  - `apps/api`, `adapters-node`, `tools/media`, `e2e`: Node types.
  - `ui`, `player`, `apps/web`: DOM + `react-jsx`.

---

## 2. The API contract (`@webflix/contracts`)

```
routes (route table) ──► ROUTE_INDEX (generated) ──► createApiClient()   zod-free, any runtime
         │           ──► bindRoutes(app, routes, …)                    @webflix/http (server)
         └──────────────► buildOpenApiDocument()                        @webflix/contracts/openapi
```

**Bundle discipline.** The client and everything the web needs on first paint are zod-free at runtime: `client.ts`, `constants.ts` (every enum tuple and limit), `error-codes.ts`, `http.ts`, `route.ts`, `route-index.gen.ts` and `media-helpers.ts` (image URLs, blob layout, trick-play). Importing them costs about 3 KB gzip instead of the roughly 38 KB a schema import pulls in. `test/zod-free.test.ts` enforces this transitively. If you add a value the web needs at runtime, put it in `constants.ts`, not next to a schema. Type imports (`import type { TitleCard }`) are always free.

**DTOs** are zod schemas whose type has the same name: `import { TitleCard } from "@webflix/contracts"` gives both `TitleCard.parse()` and `type TitleCard`. Request body types are the zod *input* type (`SignupBody`), responses the *output* type. Conventions:
- Named schemas carry `.meta({ id: "TitleCard" })`. That id becomes the OpenAPI component name and must be unique.
- Collections are objects (`{ items, nextCursor }`), never bare arrays. Cursors are opaque strings. Use `PageQuery` for `?cursor=&limit=`.
- Timestamps are `IsoDateTime`: UTC, produced by `toISOString()` (`…Z`). Ids are opaque `Id` strings: UUIDv7 at runtime, stable slugs in seeds.
- Use `nullable()` for "known to be absent" and `optional()` only in request inputs.
- **Response schemas never transform.** A test enforces that input equals output for every response.
- Rows (`Row`) are discriminated by `layout` (`standard | tall | ranked | continue`), and the items carry everything needed to draw them. `kind` says why the row exists; the web must not switch on it.
- Images are an `ImageSet`: a URL template plus widths, formats, aspect ratio, dominant colour and ThumbHash. Use `imageUrl`, `imageSrcSet` and `pickImageWidth`; never build image URLs by hand.

### Adding or changing an endpoint

1. Add or extend the DTO schemas in the matching `src/<area>.ts`.
2. Add a `defineRoute({...})` entry to `src/routes.ts`. The key is the operation id and the client method name:

```ts
rateTitle: defineRoute({
  method: "PUT",
  path: "/ratings/:titleId",       // relative to /api/v1, Hono :params
  tag: "library",
  auth: "profile",                 // public | account | profile | account-holder
  summary: "Rate a title",
  params: z.object({ titleId: Id }), // must declare exactly the :params (compile error otherwise)
  body: RateTitleBody,               // not allowed on GET; `Schema.optional()` makes it optional
  response: null,                    // null → 204; else a schema (+ successStatus 201/202)
  errors: ["not_found"],             // route-specific codes; auth/validation/CSRF codes are implied
  rateLimit: undefined,              // or a RATE_LIMIT_POLICY_NAMES entry
  rateLimitScope: undefined,         // "request" (default) or "handler"
  examples: undefined,               // { request?, response? }: OpenAPI examples, parsed by a test
}),
```

The less common fields:

- **`auth`.** `public`: no session needed. `account`: a session (`unauthenticated` otherwise).
  `profile`: a session with an active profile (`profile_required`). `account-holder`: account
  management, a session whose active profile has no parental controls (`profile_required` at the
  gate, `unrestricted_profile_required` from a kids or restricted profile). The guard enforces
  it from the table; handlers never repeat it. Who may do what is in docs/BACKEND.md §3
  ("Privileges").
- **Optional bodies.** A body schema that accepts `undefined` (`DeleteProfileBody.optional()`)
  makes the body optional: `isBodyOptional(route)`, `body?` in `RouteInput` and the client,
  `requestBody.required: false` in OpenAPI. The server treats an absent, empty or
  whitespace-only body as none, whatever `Content-Type` says, and validates anything else.
  Example: `deleteProfile`, `endPlaybackSession`.
- **`rateLimitScope`.** `request` (default): the guard charges `rateLimit` for every request.
  `handler`: only the requests the route's description names count, and the handler charges
  them (`enforceRateLimit`, or `credentialCharge` for a PIN or password check). OpenAPI
  `x-webflix-rate-limit-scope: handler`. Example: `selectProfile` (a PIN for a locked profile),
  `updateProfile` (a PIN or password check).
- **`examples`.** `{ request?, response? }` become OpenAPI `example`s on the request body and the
  success response; `packages/contracts/test` parses each with the route's schemas, so an
  example cannot drift. Give every new route one:

```ts
deleteProfile: defineRoute({
  method: "DELETE",
  path: "/profiles/:id",
  tag: "profiles",
  auth: "account",
  summary: "Delete a profile and its history, list and ratings",
  params: IdParams,
  body: DeleteProfileBody.optional(),
  response: null,
  errors: ["not_found", "profile_last_remaining", "profile_unlock_required"],
  rateLimit: "profile-pin",
  rateLimitScope: "handler",
  examples: { request: { currentPin: "4826" } },
}),
```

3. Run `pnpm --filter @webflix/contracts generate` to refresh `src/route-index.gen.ts`. Until you do, `pnpm typecheck` fails on the stale entry.
4. Update the blueprint-surface list in `packages/contracts/test/route-table.test.ts`. It fails on purpose until the table and that list agree.
5. Implement the handler on the server (§3). The client method and the OpenAPI entry exist automatically.

Milestone 2 additions (§8): every route names its `area` and lives in that area's file under
`src/routes/` (composed in `src/routes.ts`); `redirect`, `bodyEncoding: "form" | "raw"`,
`csrf: "none"` and `maxBodyBytes` describe browser navigations, issuer form posts and signed
webhooks (none of which is a client method); the staff API is `adminRoutes` under
`ADMIN_API_BASE_PATH` with `auth: "staff"` and a `staffRole`, called with
`createAdminApiClient({ accessToken })`. Run `pnpm --filter @webflix/contracts generate` after any
route or event schema change: it also regenerates `services/recs/schemas/event.schema.json`.

### Using the client

```ts
const api = createApiClient();                      // browser: same-origin, cookies included
const api = createApiClient({ baseUrl: "http://localhost:4000", headers: { Cookie } }); // Node / Workers
const title = await api.getTitle({ params: { id } }, { signal });        // typed TitleDetail
await api.rateTitle({ params: { titleId: id }, body: { value: "love" } }); // sends X-Webflix-Client
```

- Methods take `{ params, query, body }` (only the parts the route has; `body` is required unless the route's body is optional, and an all-optional object schema still takes `{}`) and an optional `{ signal, headers, keepalive }`.
- Mutations always send `X-Webflix-Client: web`. `credentials: "include"` is set where the runtime supports it.
- Failures throw `ApiError`, which narrows by code: `if (ApiError.is(err, "stream_limit_reached")) err.problem.activeStreams`. Client-side codes are `network_error` and `unexpected_response`. An aborted request rejects with the abort reason, not an `ApiError`.
- Response validation needs the schemas, so it lives on `createRouteClient(routes, { validateResponses: true })`, which returns the same typed `ApiClient`. Use it in tests and dev; `createApiClient` never validates.
- `createRouteClient(table)` also builds a client for any table; `callRoute(route, input)` calls one route.

### Errors

`ERROR_CATALOG` maps every stable `code` to its HTTP status and title. Problem documents are RFC 9457 `application/problem+json` with `code` and an optional `requestId`. Some codes carry typed extension members: `validation_failed.issues`, `rate_limited.retryAfterSec`, `stream_limit_reached.{limit, activeStreams}`, `subscription_required.subscriptionStatus`, `maturity_restricted.{maturity, profileMaturityCeiling}`, `payment_declined.declineReason`, `range_not_satisfiable.size`. To add a code: add it to `ERROR_CATALOG` (plus its extension shape if it has one). Never rename or repurpose an existing code.

### Fixtures

`@webflix/contracts/fixtures` provides `makeTitleCard`, `makeTitleDetail`, `makeEpisode`, `makeRow(layout)`, `makeBillboard`, `makeBrowsePage`, `makePlaybackSession`, `makeProfile`, `makeAvatar`, `makePlan`, `makeAuthenticatedSession`, `makeImageSet` and `makeProblem`. Every factory output is parsed by its schema, so a fixture can never drift from the contract. Names and ids are deterministic; call `resetFixtures()` in `beforeEach` for stable snapshots.

---

## 3. Serving the contract (`@webflix/http`)

```ts
const app = new Hono<AppEnv>();
app.onError(problemErrorHandler({ logger, requestId: (c) => c.get("requestId") }));
app.notFound(problemNotFoundHandler());
bindRoutes(app, routes, handlers, {
  guard: async (route, c) => {          // one place for cross-cutting policy, driven by the table
    requireClientHeader(route, c);       // CSRF (blueprint §2.3)
    await requireAuth(route.auth, c);    // yours: session / active profile
    if (route.rateLimit) await limit(route.rateLimit, c);
  },
  validateResponses: env !== "production",
});
```

- `handlers` is `RouteHandlers<typeof routes>`, which is exhaustive. To build incrementally, bind a subset table (`{ getTitle: routes.getTitle }`) or bind single routes with `bindRoute`.
- A handler receives `({ params, query, body }, c)`, already validated and coerced (`seasonNumber` is a number), and returns the response body, typed by the route. It returns nothing for 204 routes. Use `c` for cookies and headers.
- Expected failures are thrown as `AppError` from `@webflix/core`: `throw new AppError("stream_limit_reached", { limit, activeStreams })`. Codes that have extension members require them at compile time. Unknown errors become an opaque `internal_error` and are logged.
- Validation collects every issue across params, query and body into one `validation_failed`. Non-JSON bodies get `unsupported_media_type`, malformed JSON `bad_request`, bodies over 1 MiB `payload_too_large`.
- OpenAPI: `app.get(OPENAPI_PATH, (c) => c.json(buildOpenApiDocument()))`. The document validates as OpenAPI 3.1 (test in contracts). For `/api/docs`, `@scalar/hono-api-reference` is installed. Point it at a self-hosted bundle; its CDN default calls a third-party origin.

`packages/http/test/client-roundtrip.test.ts` is the reference. It binds the whole table and calls every route through the client.

Milestone 2: handlers live in one module per area (`src/handlers/<area>.ts`, typed
`AreaHandlers<"<area>">` so a missing or extra handler is a compile error there) and are composed
by `createHandlers`; the staff API's are `createAdminHandlers`. A route an area has not built yet
is `notImplemented()`: it answers `501 not_implemented` before the guard (§8.2). The guard also
enforces `auth: "staff"` (bearer token through the `StaffVerifier`, then the role) and skips the
client header for `csrf: "none"` routes. `packages/http/test/milestone2.test.ts` covers both.

---

## 4. Ports (`@webflix/core`)

Ports are interfaces in `packages/core/src/ports/`. Portable implementations ship in `@webflix/core`, in-memory ones in `@webflix/core/memory`, and contract suites in `@webflix/core/testing`.

| Port | Shape | Semantics every adapter must keep |
| --- | --- | --- |
| `BlobStore` | `head`, `get(key, {range})`, `put(key, body, opts)`, `delete(keys)`, `list({prefix, cursor, limit})` | Keys validated by `assertBlobKey`. Ranges are R2-style (`{offset,length}`, `{suffix}`); unsatisfiable ranges throw `BlobRangeNotSatisfiableError(size)`. Stream bodies declare their `size`. `list` uses code-point order with cursors and returns slim items (key, size, etag, uploadedAt), because S3 listings carry no metadata. Content type is inferred from the extension. |
| `KeyValueCache` | `get`, `set(key, value, {ttlSec})`, `delete` | String values, TTL ≥ 60 s, **eventually consistent**: never put read-after-write state here. `createJsonCache` adds typed JSON and `getOrLoad`. |
| `RateLimiter` | `consume(policy, key)` → `{allowed, remaining\|null}` or `{allowed:false, retryAfterSec}` | Exact and atomic across instances. On Cloudflare that means a Durable Object; the rate-limit binding is approximate and fails the contract. Policies come from config (`DEFAULT_RATE_LIMITS`). |
| `StreamGate` | `acquire`, `renew`, `release`, `releaseDevice`, `releaseAll`, `list` (all per account) | Atomic per account (one Durable Object per account on Cloudflare). One lease per device; re-acquiring renews; unrenewed leases expire. |
| `JobQueue` | `publish(job, {delaySec})`, `publishBatch` + a `JobProcessor` the adapter drives | At-least-once delivery, no dedupe. A job is ≤ 128 KiB serialised; a batch is ≤ 100 jobs and ≤ 256 KiB; delay ≤ 12 h. Use `defineJob` and `handleJob` with `createJobProcessor`. Failures, unknown types and invalid payloads all retry into the dead-letter queue. Payload schemas must accept their JSON form. |
| `SearchIndex` | `upsert`, `remove`, `search`, `suggest` | Every token prefix-matches; case- and diacritic-insensitive (`normalizeSearchText`). A name match outranks a synopsis match. Maturity filtering happens inside the index. |
| `PasswordHasher` | `algorithm`, `supports`, `hash`, `verify` → `{valid, needsRehash}` | PHC strings. `createPasswordHasherChain(primary, ...legacy)` upgrades old hashes on login. Portable: `createPbkdf2PasswordHasher()` (600k iterations). Node: `createScryptPasswordHasher()`. |
| `TokenSigner` | `sign(claims)`, `verify(token, purpose)` | HMAC-SHA256 with key rotation (`kid`), URL-path-safe output. `createMediaTokens` binds media tokens to an asset. |
| `Clock` / `IdGenerator` / `Logger` | `now()` / `next()` / `info(msg, fields)…child()` | `systemClock` and `ManualClock`; `createUuidV7Generator` (monotonic); `createJsonLogger` (one JSON line per record via `console`); `MemoryLogger`. |

Milestone 2's ports (docs/BLUEPRINT-M2.md §3), same pattern (port, `@webflix/core/memory`, `@webflix/core/testing`):

| Port | Shape | Semantics every adapter must keep |
| --- | --- | --- |
| `IdentityProvider` | `authorizationUrl(request)`, `redeem(redemption)` → `VerifiedIdentity` | Code flow with PKCE S256, exact redirect URI, single-use codes, nonce equal to the transaction's, `max_age` → fresh `auth_time` or `auth_time_missing` (fails closed), `email_verified` as a boolean, identities keyed by (issuer, subject). Rejections are `IdentityProviderError(reason)`. Helpers: `assertAuthorizationRequest`, `createPkceVerifier`, `pkceChallenge`, `normaliseEmailVerified`. |
| `PaymentProvider` | customers, setups, subscriptions, previews, plan changes, cancel, invoices, refunds, promo validation, catalogue sync, `parseWebhook`, `listEvents` | Idempotency per key (declines replayed; other parameters `idempotency_conflict`; `billingIdempotencyKey(operation, attempt)`); the provider is the source of truth (`retrieve*`); same card, same fingerprint; a change applied with a preview's `prorationDate` is invoiced as previewed; refunds leave the invoice paid; signatures over the exact raw bytes within `WEBHOOK_TOLERANCE_SEC`; events normalised to ids (structured-clone safe). Test cards: `PAYMENT_TEST_CARDS`. |
| `EmailSender` | `send(message, { idempotencyKey })` | At most once per key (`deduplicated: true` on a repeat); no header injection (`assertEmailMessage`); UTF-8 intact. `emailLinks` extracts links for the mailbox API. |
| `EventSink` | `append(events)` → `{ objects }` | Durable before it resolves; `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz` by receipt hour, a batch split across hours, never an overwrite, at least once. `createBlobLakeEventSink({ blobs, ids })` is the lake writer over any `BlobStore`; `encodeLakeObject` / `decodeLakeObject` pin the format the pipeline reads. |
| `RecommendationStore` | `activeModel`, `neighbours(titleIds)`, `profileLists(key, now)`; importer: `beginImport`, `putNeighbours`, `putProfileLists`, `activate`, `deleteRun`, `deleteProfileLists` | Only the activated run is served; neighbours by rank, ≤ 40 per title, ≤ 25 titles per lookup; one read per profile, last write wins, expired lists are not served; idempotent imports in bounded statements. |
| `Experiments` | `definitions()`, `assign(unit, context, now)` | `assignVariants` is the one portable assignment (SHA-256 buckets): deterministic, running and in dates only, unit type, targeting, mutual exclusion by allocation within a layer, weights, salt reshuffles, never a restricted profile. `overlappingAllocations` finds conflicts. |
| `StaffVerifier` | `verify(token)` → `StaffIdentity` | Signature, issuer, audience `webflix-admin-api`, time (small skew), access-token type (not an ID token); roles from `resource_access["webflix-admin"].roles` filtered to `STAFF_ROLES` (`mapStaffRoles`); `staffHasRole` (admin passes every check). Rejections are `StaffTokenError(reason)`. |

`createMemoryAreaPorts()` builds all seven in memory (the default of every mode until each area
composes its adapters). `createTestServices()` exposes them as `ports` (the mailbox, the fake
payment provider's test helpers, the staff verifier's `mint`).

Also in core: `loadCoreConfig(env)` (typed config; see `config.ts` for the `WEBFLIX_*` variables and dev defaults), `AppError`, maturity helpers (`isWithinMaturityCeiling`, `maturityLevelsUpTo`, `resolveMaturityCeiling`), `PLAN_CATALOG` and `getPlan`, cursors (`encodeCursor`, `decodeCursor(cursor, schema)`), `parseHttpRange` and `scopeBlobStore`.

Repository ports (`packages/core/src/repositories/`), the application services (`createServices`) and their in-memory test harness (`createTestServices` in `@webflix/core/testing`) are described in `docs/BACKEND.md`; every repository implementation passes `describeRepositoryContract`.

### Adding an adapter

1. Implement the port in your package (`adapters-node`, `adapters-cloudflare`, `db`). Call the shared validators (`assertBlobKey`, `assertCacheTtl`, `assertJobMessage`, …) so behaviour stays identical across modes.
2. Run the contract suite **in the runtime the adapter ships to**:

```ts
// packages/adapters-node/test/s3.test.ts  (Node)
describeBlobStoreContract("s3", async () => {
  const store = scopeBlobStore(createS3BlobStore(config), `test-${crypto.randomUUID()}`);
  return { store, cleanup: () => deleteAll(store) };
});
```

The factory returns a fresh harness for each test. Add `time: { advance(ms) }` when the adapter reads an injected `Clock` (pass a `ManualClock`). Without it, the time-based cases (TTL expiry, lease expiry, delays) are skipped. `describeJobQueueContract` takes `(processor) => ({ queue, drain, deadLetters?, maxAttempts? })`.

3. Cloudflare adapters are tested inside **workerd** with `@cloudflare/vitest-plugin`. See `packages/adapters-cloudflare/vitest.config.ts` (bindings declared as miniflare options) and `apps/edge/vitest.config.ts` (bindings from `wrangler.jsonc`). `createKvCache` there is the worked example. Every core suite, the PBKDF2 hasher, HMAC tokens and the API client already pass in workerd.

---

## 5. Seed data and media manifest

- `@webflix/catalog` exports `catalog: CatalogSeed` and `demoAccount: DemoAccountSeed`, both validated when the module is imported (including referential integrity and `demoSeedIssues`). They hold the full catalog (blueprint §7) and the demo account.
- `CatalogSeed`: genres, people, video assets (download source with licence, or synthetic, plus an optional `externalHlsUrl` fallback), titles (movies with `videoAssetId`; series with numbered seasons and episodes), avatars, and free-form `art` direction for `tools/media`. Times are relative (`addedDaysAgo`, `daysAgo`) so seeds always look fresh.
- `MediaManifest` (`tools/media` output, `.cache/media/<profile>/manifest.json`): packaged assets (renditions, audio, text tracks, trick-play sheets, preview clip, intro/recap/credits markers) plus artwork for titles, episodes and avatars. Every path is a `BlobKey` built with `blobKeys`. An asset listed in the manifest is *packaged*; an asset that appears only in the seed with `externalHlsUrl` is *external*.
- `artworkToImageSet(manifestImage)` produces the `ImageSet` DTO, with `?v=<hash>` cache-busting.
- `webflix-media validate-manifest <file>` checks a manifest against the contract.

---

## 6. Design points (decided)

- **Stream limits vs stateless media tokens.** *Decided* (docs/DECISIONS.md D1): the limit is enforced at session start, on every heartbeat, and on every playlist (`.m3u8`) request, which also requires the session to still hold its stream slot; segments, subtitles and trick-play stay stateless until the token's `exp` (6 h default). The master playlist is also filtered to the plan's maximum height.
- **Password KDF on Workers.** *Decided* (docs/CLOUDFLARE.md §6): PBKDF2-SHA256 at 600k iterations by default, about 40 ms of CPU per sign-in, so the Cloudflare mode needs Workers Paid. PBKDF2 hashes verify in every mode; scrypt hashes from Node verify only on Node.

## 7. Version couplings and gotchas

- **Vitest must stay a single version** within the peer range of `@cloudflare/vitest-plugin` (^4.1 \|\| ^5 today), because the contract suites import `vitest` from core. `@testing-library/jest-dom@8` needs Vitest 5. Upgrade these together.
- `@cloudflare/vitest-pool-workers` is deprecated. The package is now `@cloudflare/vitest-plugin` (`cloudflareTest()` Vite plugin).
- Current workerd (1.20261119) does **not** cap PBKDF2 at 100k iterations, unlike older releases; a workerd test guards this. The 600k default costs about 40 ms of CPU, so the Cloudflare mode needs Workers Paid.
- Workers KV's minimum TTL is 60 s. The cache port enforces that floor in every mode.
- On macOS the filesystem `BlobStore` percent-encodes names (case-insensitive FS) and suffixes object files with `~`, so `a/b` and `a/b/c` can coexist. Write through the port (e.g. an upload command), not into its directory by hand.
- Turborepo runs with `envMode: loose`. Variables affecting test results belong in `globalEnv` (`WEBFLIX_*`, `CI` are already there).

---

## 8. Milestone 2: the foundation and the hand-off

Written 2026-11-22 at the end of step 1 of docs/BLUEPRINT-M2.md §11. Everything milestone 2
needs to build on in parallel is in place and every gate is green; no business behaviour is
implemented. Milestone 1 behaves exactly as before.

### 8.1 How the pieces fit

- **Contracts.** Every milestone 2 route, schema, event type and error code is in
  `@webflix/contracts` (docs/CONTRACT_CHANGES.md, 2026-11-22). Each route names its `area`; the
  member table is one file per area under `src/routes/`; the staff API is `src/admin-routes.ts`.
- **Ports.** The seven ports of §3 are in `packages/core/src/ports/`, each with a memory
  implementation and a contract suite (§4 above). `AreaPorts` groups them; `ServiceDependencies`
  extends it.
- **Areas in core.** `packages/core/src/areas/<area>/` holds each area's `service.ts` (built by
  `createServices`, exposed as `services.<area>`), `repository.ts` (its repository port,
  `repos.<area>`) and `config.ts` (its environment variables, parsed by `loadCoreConfig` into
  `config.<area>`). An area service is an `AreaModule`: its `jobs` join the one job processor
  and its `scheduled(now)` jobs the scheduler tick, without touching `services/jobs.ts`.
- **Seams between areas** (`areas/module.ts`, `AreaSeams`, passed to every area service):
  `emitServerEvent` (the events area's; drops events with a debug log until events implements
  it, so callers can call it now) and `assignments` (the experiments area's). Billing owns
  `playbackEntitlement` (services/subscriptions.ts), the one entitlement decision playback asks.
- **Database.** Each area has its migrations in `packages/db/src/migrations/<area>/`, its table
  types in `src/tables/<area>.ts` (composed into `DB` and `TABLES`) and its repository in
  `src/repositories/areas/<area>.ts` (composed by `createRepositories`). Memory:
  `packages/core/src/memory/areas/<area>.ts`. Suites: `describe<Area>RepositoryContract`
  (`packages/core/src/testing/areas/`), already run against memory, SQLite, PostgreSQL (when
  available) and D1 (`packages/db/test/areas.test.ts`, `test/workerd/areas.test.ts`).
- **HTTP.** `packages/http/src/handlers/<area>.ts` per area, `admin.ts` for the staff API.
- **Composition.** `apps/api/src/areas/<area>.ts` and `apps/edge/src/areas/<area>.ts` build each
  area's ports from its configuration; in memory by default. An adapter name the configuration
  allows but nobody has built yet (`WEBFLIX_PAYMENT_PROVIDER=stripe`, …) fails at startup with a
  `ConfigError` naming the area. The development issuer is mounted at `/dev-idp/*` in the Node
  runtime outside production.

### 8.2 Routes that are registered but not implemented

A route its area has not built has `notImplemented()` as its handler. It answers every request,
**before** the guard, validation and rate limits, with:

```
501 application/problem+json
{ "type": "urn:webflix:problem:not_implemented", "title": "Not implemented yet", "status": 501,
  "code": "not_implemented", "operationId": "startCheckout", "area": "billing",
  "detail": "POST /api/v1/billing/checkout (startCheckout) is part of the contract, but the billing area has not implemented it yet." }
```

The same answer to every caller (signed in or not, with or without the client header, with any
body), so the conformance suite recognises it from one anonymous request; the served OpenAPI
document marks exactly these operations `x-webflix-implementation: pending` with a 501
response; the conformance check `ops.pending-routes` reads that mark, probes each one and lists
them per area (63 today: identity 13, billing 11, events 8, admin 31). Implementing a route is
replacing `notImplemented()` in your handler file: the mark, the 501 and the probe go away by
themselves. Of the staff API only `GET /me` is implemented (the guard and the verified
identity, nothing more).

### 8.3 Hand-off: who owns what

Six engineers: identity (with email and the development issuer), billing (with the fake provider
and the Stripe adapter), events (with the lake and privacy), the Python pipeline
(`services/recs`, unchanged by this step apart from its event schema), experimentation with
recommendation serving (the `experiments` and `personalisation` areas), and the admin API.
"Owns" means create and change freely; everything else is shared (§8.4).

| Area | Owned files | Routes | Ports | Tables |
| --- | --- | --- | --- | --- |
| **identity** | contracts `identity.ts`, `routes/identity.ts`, and in `account.ts` the account, session, auth and device declarations; core `areas/identity/**`, `ports/identity-provider.ts`, `ports/email-sender.ts`, their memory adapters and suites, `memory/areas/identity.ts`, `testing/areas/identity.contract.ts`, milestone 1's `services/auth.ts`, `credentials.ts`, `privileges.ts`, `device.ts`, `profiles.ts` and, in `services/account.ts`, `updateAccount`, `listDevices`, `revokeDevice`; db `migrations/identity/**`, `tables/identity.ts`, `repositories/areas/identity.ts`, milestone 1's `repositories/identity.ts`; http `handlers/identity.ts`; apps `areas/identity.ts` (api and edge); packages `dev-idp`, new `packages/email` | milestone 1: sign-up, sign-in, sign-out, session, profile selection, account details, devices, profiles, avatars (16); milestone 2: OIDC start and callbacks, identities, elevation, email verification, password reset, email webhook, mailbox (13) | `IdentityProvider`, `EmailSender` | `account_identities`, `account_tokens`, `email_outbox`, `email_suppressions`, `accounts.email_verified_at`, `sessions.elevated_until`; milestone 1's `accounts`, `sessions`, `profiles` |
| **billing** | contracts `billing.ts`, `routes/billing.ts`, `plans.ts`, and in `account.ts` the subscription, payment-method, membership and card declarations; core `areas/billing/**`, `ports/payment-provider.ts` with its memory adapter and suite, area memory and suite files, milestone 1's `services/subscriptions.ts` (incl. `playbackEntitlement`), `domain/plans.ts` and, in `services/account.ts`, `getAccount`, `changePlan`, `updatePaymentMethod`, `cancel`, `resume`; db `migrations/billing/**`, `tables/billing.ts`, `repositories/areas/billing.ts`; http `handlers/billing.ts`; apps `areas/billing.ts`; packages `payments-fake`, `adapters-stripe` (new), `tools/stripe`; `packages/contracts/test/no-card-data.test.ts`'s `LEGACY_CARD_FIELDS` | milestone 1: account, plans, plan change, card, cancel, resume (6); milestone 2: billing config, checkout (3), plan-change preview, card setup (2), invoices, promo validation, payment webhook, billing clock (11) | `PaymentProvider` | `memberships`, `billing_customers`, `billing_operations`, `provider_events`, `trial_fingerprints`, `invoices`, `refunds`, `plan_prices`, `provider_prices`, `checkouts`, `payment_method_setups`, `payments_fake_objects`, `payments_fake_idempotency`, `payments_fake_clocks`; milestone 1's `subscriptions` |
| **events** | contracts `events.ts`, `event-schema.ts`, `privacy.ts`, `routes/events.ts`, `fixtures/events.ts` (and through the generator `services/recs/schemas/event.schema.json`); core `areas/events/**` (the `emitServerEvent` seam), `ports/event-sink.ts` with memory adapter and suite, area memory and suite files; custodian of milestone 1's streaming surface: `services/playback.ts` (playback events), `services/library.ts`, `routes/streaming.ts`, `handlers/streaming.ts`; db `migrations/events/**`, `tables/events.ts`, `repositories/areas/events.ts`, milestone 1's `repositories/activity.ts`; http `handlers/events.ts`; apps `areas/events.ts`; new `packages/telemetry` | milestone 2: events, consent (2), export, privacy requests, account deletion (2), events read-back (8); custodian of the 14 streaming routes | `EventSink` | `consents`, `privacy_requests`, `privacy_erasures`, `analytics_daily` (events themselves: the lake, in the blob store) |
| **personalisation** (experiments engineer) | contracts `routes/personalisation.ts`, `browse.ts`, `titles.ts`; core `areas/personalisation/**`, `ports/recommendation-store.ts` with memory adapter and suite, area memory and suite files, milestone 1's `services/browse.ts`, `services/search.ts`, `recommendations/**`, `catalog/**`; db `migrations/personalisation/**`, `tables/personalisation.ts`, `repositories/areas/personalisation.ts`, milestone 1's `repositories/catalog.ts`, `search.ts`; http `handlers/personalisation.ts`; apps `areas/personalisation.ts` | milestone 1: browse, rows, genres, showcase, titles, episodes, popularity, similar, search (10) | `RecommendationStore` | `recommendation_models`, `recommendation_neighbours`, `recommendation_profiles`, `editorial_billboards`, `editorial_collections`, `editorial_collection_items`, `title_availability` |
| **experiments** | contracts `experiments.ts`; core `areas/experiments/**`, `ports/experiments.ts` with memory adapter and suite, area memory and suite files; db `migrations/experiments/**`, `tables/experiments.ts`, `repositories/areas/experiments.ts`; http `handlers/experiments.ts`; apps `areas/experiments.ts` | none (assignments travel in `GET /session`; its staff routes are the admin area's handlers) | `Experiments` | `experiments`, `experiment_results` |
| **admin** | contracts `admin.ts`, `admin-routes.ts`; core `areas/admin/**`, `ports/staff-verifier.ts` with memory adapter and suite, area memory and suite files; db `migrations/admin/**`, `tables/admin.ts`, `repositories/areas/admin.ts`; http `handlers/admin.ts`; apps `areas/admin.ts`; new `apps/admin` | the 32 staff routes (`GET /me` implemented, 31 pending) | `StaffVerifier` | `audit_log`, `job_dead_letters` |

The Python pipeline owns `services/recs` except `schemas/event.schema.json` (generated from
contracts: change `packages/contracts/src/events.ts`, run the generator) and keeps reading it
through `src/webflix_recs/schemas.py`.

### 8.4 Shared files and how to change them

Shared (foundation's; change additively, with the Edit tool's exact replacements, never a
rewrite, and say so in your report): contracts `route.ts`, `routes.ts` (composition only),
`constants.ts` (append in your area's section), `error-codes.ts` and `errors.ts` (append codes
and extension shapes; never rename one), `http.ts`, `client.ts`, `openapi.ts`, `index.ts`,
`account.ts` (identity's and billing's declarations side by side), `scripts/`; core
`areas/{module,index,ports,config}.ts`, `config.ts`, `services/{index,context,jobs,presenters}.ts`,
`repositories/ports.ts`, `memory/repositories.ts`, `memory/area-ports.ts`, `index.ts`; db
`schema.ts`, `migrations/{index,types}.ts`, `repositories/{index,mapping}.ts`; http `app.ts`,
`routing.ts`, `session.ts`, `container.ts`, `ops.ts`, `handlers/{index,types}.ts`; apps
`runtime.ts`, `areas/{index,shared}.ts`, `config.ts`, `env.ts`, `wrangler.jsonc` (a new binding,
var or secret goes in the local and the production sections alike: a test compares them).

Common moves without touching a shared file:

- **A route**: change its entry in `src/routes/<area>.ts` (or `admin-routes.ts`), run
  `pnpm --filter @webflix/contracts generate`, implement it in `handlers/<area>.ts`, record it in
  docs/CONTRACT_CHANGES.md. The route-table surface test lists every route on purpose: update it.
- **A table or column**: a new migration file in `migrations/<area>/` named with the next free
  number (`NNNN_<area>_<change>`), listed in that directory's `index.ts`; its types in
  `tables/<area>.ts`; `pnpm --filter @webflix/db generate`. ADD COLUMN only, nullable or with a
  default; never rebuild a table that others reference (§8.6, D-M2-5). If your dev database then
  refuses with "corrupted migrations" because another area's migration landed with a lower
  number meanwhile, delete `.data/` (dev only).
- **A setting**: in `areas/<area>/config.ts` (portable) or your `apps/*/src/areas/<area>.ts`
  (mode-specific). Document it in docs/BACKEND.md §4.
- **A job or a periodic job**: `jobs` / `scheduled` of your area service.
- **Another area's data**: call its service (or a seam); never its repository.

### 8.5 What is stubbed, and how each stub answers

| What | Today | Where it is replaced |
| --- | --- | --- |
| 63 routes (§8.2) | `501 not_implemented` before the guard | the area's handler file |
| `services.<area>` | no methods (jobs: none) | `areas/<area>/service.ts` |
| `repos.<area>` | empty object | memory, db and suite files of the area |
| `emitServerEvent` seam | logs `events.server_event_dropped` at debug, drops | `areas/events/service.ts` |
| `assignments` seam | real: `deps.experiments.assign` (memory definitions: none, so `{}`) | `areas/experiments/service.ts` |
| `authenticateStaff` | real: verifies with `deps.staff`; `unauthenticated` otherwise | `areas/admin/service.ts` |
| Area ports in every mode | memory (`identityProviders` empty; the staff verifier mints only in process) | `apps/*/src/areas/<area>.ts` |
| `WEBFLIX_EVENT_SINK=lake` | real: the lake writer over the mode's blob store | (works today) |
| Development issuer, Node | mounted at `/dev-idp/*` outside production; its issuer URLs use `WEBFLIX_PUBLIC_ORIGIN` (`:5173` in dev), so a browser reaches it only once the Vite dev server proxies `/dev-idp` (apps/web) and, on kind, once the gateway routes `/dev-idp` to the API (deploy); server-side calls can use `devIdp.fetch` in process | identity, with the web and platform owners |
| Development issuer, Worker | not mounted: `/dev-idp/*` reaches the app (`not_found`) | `apps/edge/src/areas/identity.ts` (`handleIdentityRequest`), after `packages/dev-idp` typechecks under `@cloudflare/workers-types` |
| `/_pay/*` (fake provider's form) | routed to the Worker / not mounted anywhere | billing's area composition files |

### 8.6 Decisions the blueprint left open (with the reason)

- **D-M2-1 Uniform stub** (§8.2): 501 before the guard, so one anonymous probe recognises it and
  an unbuilt route consumes no rate limit or session lookup.
- **D-M2-2 Areas on routes**: each route names the handler module that implements it, so
  handler ownership is compile-checked. Milestone 1's catalogue, library and playback routes are
  the `streaming` area (no milestone 2 owner; events is custodian); browse, titles and search are
  personalisation's.
- **D-M2-3 Route kinds**: browser navigations (`redirect`), issuer form posts (`form`) and signed
  webhooks (`raw`, `csrf: "none"`) are first-class routes (validated, documented) but not client
  methods; `navigationUrl` builds a navigation.
- **D-M2-4 Staff API**: its own table and base path; `staffRole: "any"` for `GET /me` (a staff
  member without a role must still learn so); `admin` passes every role check; every mutating
  staff route requires `reason`.
- **D-M2-5 `accounts.password_hash` stays NOT NULL** (the blueprint says nullable): SQLite and D1
  cannot drop NOT NULL without rebuilding the table, and dropping `accounts` cascades deletes to
  every profile, session and subscription even with `defer_foreign_keys` (measured on SQLite
  3.53). A passwordless account stores the empty string; the identity owner maps it to `null` in
  `AccountRecord` when making `passwordHash` nullable. The same rule bans rebuilding any table
  that others reference (a migration test fails on DROP TABLE or RENAME).
- **D-M2-6 Billing records keep `account_id` without a foreign key** (customers, operations,
  provider events, invoices, refunds, trial fingerprints): deleting an account must not delete
  what the law requires to be kept (§6.3). The projection, checkouts and setups cascade.
- **D-M2-7 The fake provider's state** is three generic tables (versioned JSON documents,
  idempotency records, per-customer clocks: a clock per customer, as Stripe's test clocks, so
  parallel suites do not move each other's time). Billing may replace them with its own
  migration.
- **D-M2-8 Checkout API**: start (`requires_setup` + client secret), confirm (server reads the
  card's fingerprint, decides the trial, creates the subscription; `requires_payment` when the
  first payment needs the browser), status; a member's plan change is previewed and applied with
  the preview's opaque `previewToken` (same proration date). Immediate downgrade credit versus a
  scheduled downgrade (docs/STRIPE.md §7) is billing's decision.
- **D-M2-9 PaymentProvider shape**: a subscription without a trial is always `incomplete` until
  the browser confirms the first payment (Stripe's `default_incomplete`, docs/STRIPE.md §7);
  reconciliation reads `listEvents` after an outage (the CLI listener replays nothing, §11).
- **D-M2-10 Event schema**: the pipeline's schema adopted with three corrections
  (docs/CONTRACT_CHANGES.md); exported in the pipeline's own `if/then` dispatch layout (a
  validator checks one constant per rule instead of trying 22 `oneOf` branches on tens of
  millions of events) and generated straight into `services/recs/schemas/`, whose Dockerfile
  packages that directory; `ClientEventInput` refuses a client-supplied identity (§6.1 says
  "ignored"; with closed schemas, refusing is the honest form of ignoring).
- **D-M2-11 Consent and pseudonyms**: consent mode defaults to `opt-in` (the strictest; nothing
  is shown before the web adopts it); `WEBFLIX_PSEUDONYM_KEY` has a development default refused
  in production once events are stored (`WEBFLIX_EVENT_SINK` other than memory).
- **D-M2-12 Rate limits**: five new policies (docs/BACKEND.md §3). Address-keyed ones (`oidc`,
  `email-send`, `events`) are relaxed in dev and Cloudflare local exactly like milestone 1's
  (suites share 127.0.0.1); per-recipient and per-account ones stay strict.
- **D-M2-13 Experiments**: units hash into 10 000 buckets per layer; experiments of a layer own
  disjoint `allocation` ranges (explicit, so adding an experiment never reshuffles another's
  units); SHA-256 via Web Crypto so every runtime agrees; restricted profiles are never
  assigned.
- **D-M2-14 RecommendationStore**: expired lists are not returned (`profileLists(key, now)`);
  profiles absent from a new run are deleted explicitly (`deleteProfileLists`), which works for
  SQL and KV alike.
- **D-M2-15 The lake writer is in core** (`createBlobLakeEventSink`), so the object format is
  pinned once to what the pipeline reads (`lake.py`): gzip, one JSON event per line, by receipt
  hour.
- **D-M2-16 Configuration per area**, with adapter names reserved now (`memory` default) and
  unbuilt ones failing at startup; Stripe variables use the names `tools/stripe` writes
  (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`).
- **D-M2-17 Diagnostics routes** (`/diagnostics/mailbox`, `/diagnostics/billing/clock`,
  `/diagnostics/events`) sit in the member table like milestone 1's popularity diagnostics and
  answer `not_found` in production; the billing clock is per account (per customer).
- **D-M2-18 `GET /session?deviceId=`** carries the anonymous experiment unit; `Plan.trial` stays
  absent until billing offers trials (advertising a trial the milestone 1 sign-up does not give
  would change what a member sees); `PAYMENT_DECLINE_REASONS` is not extended yet (the web
  switches on it exhaustively).
- **D-M2-19 Email**: a `data-export-ready` template joins §8.2's list (the export link is
  emailed, §6.3).

### 8.7 Where the blueprint was wrong, or a track's measured facts won

- §4.1 "`accounts.password_hash` becomes nullable": not safely possible on SQLite/D1 (D-M2-5).
- §4.4 "mount the development issuer in apps/api and apps/edge": done in apps/api; in apps/edge
  `packages/dev-idp` does not typecheck under `@cloudflare/workers-types` (two WebCrypto union
  types in `src/jose.ts`), although its own workerd suite passes under its own types.
- §5.2–§5.5 already carried docs/STRIPE.md's corrections; the port follows STRIPE.md where the
  blueprint is less specific: keys per (operation, attempt), declines replayed, first payment
  confirmed in the browser, refunds that leave invoices paid, retrieve-never-trust webhooks.
- §6.1 the envelope follows services/recs's fifteen decisions (subject block, `consent.change`,
  positions, policy), which the blueprint had folded in; "client-supplied identities are
  ignored" became "refused" (D-M2-10).
- packages/dev-idp's fixed facts are contract constants: callbacks
  `/api/v1/auth/oidc/{provider}/callback`, client `webflix-admin`, audience `webflix-admin-api`,
  roles from `resource_access["webflix-admin"].roles`, Apple's form post (a `form` route with
  `csrf: "none"`).
