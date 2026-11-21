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
| Vitest | 5.1 | One version for the whole repo (see §6). |
| Playwright | 1.65 | Chromium already installed (`make setup` reinstalls). |

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
`tools/media/media.mk`, `deploy/kind/k8s.mk`, `apps/edge/cloudflare.mk`, `e2e/e2e.mk`. Write `target: ## description` so `make help` lists it. To hook into `setup`, `clean` or `doctor`, use a double-colon rule (`setup:: content`).

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

- `@webflix/catalog` exports `catalog: CatalogSeed` and `demoAccount: DemoAccountSeed`, both validated when the module is imported (including referential integrity and `demoSeedIssues`). Right now they hold a minimal starter seed that the content work replaces.
- `CatalogSeed`: genres, people, video assets (download source with licence, or synthetic, plus an optional `externalHlsUrl` fallback), titles (movies with `videoAssetId`; series with numbered seasons and episodes), avatars, and free-form `art` direction for `tools/media`. Times are relative (`addedDaysAgo`, `daysAgo`) so seeds always look fresh.
- `MediaManifest` (`tools/media` output, `.cache/media/<profile>/manifest.json`): packaged assets (renditions, audio, text tracks, trick-play sheets, preview clip, intro/recap/credits markers) plus artwork for titles, episodes and avatars. Every path is a `BlobKey` built with `blobKeys`. An asset listed in the manifest is *packaged*; an asset that appears only in the seed with `externalHlsUrl` is *external*.
- `artworkToImageSet(manifestImage)` produces the `ImageSet` DTO, with `?v=<hash>` cache-busting.
- `webflix-media validate-manifest <file>` checks a manifest against the contract.

---

## 6. Open design points (owners decide)

- **Stream limits vs stateless media tokens.** *Decided* (docs/DECISIONS.md D1): the limit is enforced at session start, on every heartbeat, and on every playlist (`.m3u8`) request, which also requires the session to still hold its stream slot; segments, subtitles and trick-play stay stateless until the token's `exp` (6 h default). The master playlist is also filtered to the plan's maximum height.
- **Password KDF on Workers.** PBKDF2 at 600k iterations is about 40 ms of CPU per sign-in, so the Cloudflare mode needs Workers Paid. Hashes are portable across modes; scrypt hashes from Node verify only on Node.

## 7. Version couplings and gotchas

- **Vitest must stay a single version** within the peer range of `@cloudflare/vitest-plugin` (^4.1 \|\| ^5 today), because the contract suites import `vitest` from core. `@testing-library/jest-dom@8` needs Vitest 5. Upgrade these together.
- `@cloudflare/vitest-pool-workers` is deprecated. The package is now `@cloudflare/vitest-plugin` (`cloudflareTest()` Vite plugin).
- Current workerd (1.20261119) does **not** cap PBKDF2 at 100k iterations, unlike older releases; a workerd test guards this. The 600k default costs about 40 ms of CPU, so the Cloudflare mode needs Workers Paid.
- Workers KV's minimum TTL is 60 s. The cache port enforces that floor in every mode.
- On macOS the filesystem `BlobStore` percent-encodes names (case-insensitive FS) and suffixes object files with `~`, so `a/b` and `a/b/c` can coexist. Write through the port (e.g. an upload command), not into its directory by hand.
- Turborepo runs with `envMode: loose`. Variables affecting test results belong in `globalEnv` (`WEBFLIX_*`, `CI` are already there).
