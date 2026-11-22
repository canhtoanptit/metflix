/**
 * @webflix/contracts: the HTTP API contract shared by every app and package.
 *
 * - DTO schemas (zod) and their types: import a name and get both, e.g. `TitleCard`.
 * - `routes`: the route table; `createApiClient()`: the typed client derived from it.
 * - `adminRoutes`: the staff API; `createAdminApiClient()`.
 * - Milestone 2: billing, identity, events (`LakeEvent`, `ClientEventInput`), privacy,
 *   experiments and admin schemas.
 * - `Problem` / `ERROR_CATALOG`: the error model.
 * - `CatalogSeed`, `DemoAccountSeed`, `MediaManifest`: data exchanged between content,
 *   media pipeline and backend.
 *
 * OpenAPI generation lives in `@webflix/contracts/openapi`, the event JSON Schema export in
 * `@webflix/contracts/event-schema`; test factories in `@webflix/contracts/fixtures`.
 */
export * from "./account.ts";
export * from "./admin.ts";
export * from "./admin-routes.ts";
export * from "./billing.ts";
export * from "./browse.ts";
export * from "./client.ts";
export * from "./common.ts";
export * from "./constants.ts";
export * from "./error-codes.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./experiments.ts";
export * from "./http.ts";
export * from "./identity.ts";
export * from "./library.ts";
export * from "./manifest.ts";
export * from "./maturity.ts";
export * from "./media.ts";
export * from "./media-helpers.ts";
export * from "./plans.ts";
export * from "./playback.ts";
export * from "./privacy.ts";
export * from "./profiles.ts";
export * from "./route.ts";
export * from "./route-index.gen.ts";
export * from "./routes.ts";
export * from "./seed.ts";
export * from "./time-left.ts";
export * from "./titles.ts";
