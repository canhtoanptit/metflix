import type {
  AuthContext,
  BlobStore,
  Clock,
  CoreConfig,
  IdGenerator,
  Logger,
  RateLimiter,
  Services,
} from "@webflix/core";
import type { Context } from "hono";
import type { MetricsRegistry } from "./metrics.ts";

/** A dependency `/readyz` probes (database ping, blob store, cache). */
export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

/** The self-hosted API reference bundle (no third-party origins, blueprint §4). */
export interface DocsAssets {
  /** Same-origin URL of the Scalar standalone bundle, e.g. `/api/docs/scalar.js`. */
  scriptUrl: string;
  /** Serves `scriptUrl` when it lives under this app; null when it cannot. */
  serveScript?: () => Promise<Response | null>;
}

/**
 * Everything `createApp` needs. Built by each entrypoint from its runtime's adapters:
 * `apps/api` (Node: SQLite/Postgres, memory/Valkey, filesystem/S3) and `apps/edge`
 * (Workers: D1, KV, Durable Objects, R2). Nothing here is runtime-specific.
 */
export interface AppContainer {
  config: CoreConfig;
  services: Services;
  blobs: BlobStore;
  rateLimiter: RateLimiter;
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
  /** Probed by `/readyz` (each with a 2 s timeout). */
  readiness?: ReadinessCheck[];
  /** When present: HTTP metrics are recorded and `/metrics` is served (Node). */
  metrics?: MetricsRegistry;
  /**
   * The client address used for rate limiting. Default: `CF-Connecting-IP`, else "unknown".
   * Node supplies the socket address (or a trusted `X-Forwarded-For`).
   */
  clientIp?: (c: Context) => string;
  docs?: DocsAssets;
  /** `/readyz` answers 503 while true (graceful shutdown: stop receiving traffic first). */
  isShuttingDown?: () => boolean;
}

export interface AppVariables {
  requestId: string;
  /** The resolved session, memoised per request (see `resolveAuth`). */
  auth: Promise<AuthContext | null>;
}

export type AppEnv = { Variables: AppVariables };
