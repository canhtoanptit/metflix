import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError, type CoreConfig, loadCoreConfig } from "@webflix/core";
import { POSTGRES_ROLE_TIMEOUTS, type PostgresRole } from "@webflix/db/postgres";
import { z } from "zod";

/** Repository root (apps/api/src → ../../..): dev-mode data lives in `.data/`, media in `.cache/`. */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Overrides of a PostgreSQL role's budgets (`POSTGRES_ROLE_TIMEOUTS`), in milliseconds. */
export interface PostgresTimeouts {
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export type DatabaseConfig =
  | { kind: "sqlite"; path: string }
  | {
      kind: "postgres";
      url: string;
      maxConnections: number;
      /** Per role; a role without an entry keeps its defaults. */
      timeouts: Partial<Record<PostgresRole, PostgresTimeouts>>;
      /** TCP keepalive's first probe after this much idle time (0: off); null: the default. */
      keepAliveInitialDelayMs: number | null;
    };

const POSTGRES_ROLES = Object.keys(POSTGRES_ROLE_TIMEOUTS) as PostgresRole[];
/** `request` → `WEBFLIX_DATABASE_REQUEST_STATEMENT_TIMEOUT_MS` / `..._QUERY_TIMEOUT_MS`. */
const timeoutVariable = (role: PostgresRole, kind: "STATEMENT" | "QUERY") =>
  `WEBFLIX_DATABASE_${role.toUpperCase()}_${kind}_TIMEOUT_MS`;

export type BlobStoreConfig =
  | { kind: "fs"; root: string }
  | { kind: "memory" }
  | {
      kind: "s3";
      endpoint: string | null;
      region: string;
      bucket: string;
      accessKeyId: string | null;
      secretAccessKey: string | null;
      forcePathStyle: boolean;
    };

/** Node-specific settings on top of the portable `CoreConfig` (see docs/BACKEND.md). */
export interface ApiConfig {
  core: CoreConfig;
  host: string | undefined;
  port: number;
  /**
   * Port of the operational listener (/healthz, /readyz, /dependencies, /metrics), which the
   * public listener then refuses. Null: served on `port` (dev, where nothing sits in front).
   */
  opsPort: number | null;
  database: DatabaseConfig;
  blobs: BlobStoreConfig;
  /** Read-only directory with packaged media laid out by blob key (dev: `.cache/media/<profile>`). */
  mediaDir: string | null;
  /** Media manifest the seeder joins with the catalog. */
  manifestPath: string | null;
  /** Valkey for cache, rate limits, stream gate and job queue; null: in-process (one replica only). */
  valkeyUrl: string | null;
  /** Overrides the URL's password, so the URL can live in config and the password in a Secret. */
  valkeyPassword: string | null;
  /** Prefix of every Valkey key (lets environments share one Valkey). */
  valkeyKeyPrefix: string;
  /** Jobs one worker process runs concurrently. */
  jobsConcurrency: number;
  passwordHasher: "scrypt" | "pbkdf2";
  migrateOnStart: boolean;
  seedOnStart: boolean;
  /** Trust `X-Forwarded-For` (behind the k8s gateway) for client IPs. */
  trustProxy: boolean;
  /**
   * Proxies in front of the API that append to `X-Forwarded-For` (the gateway: 1; a cloud load
   * balancer in front of it: 2). The client address is that many entries from the right;
   * entries further left are client-supplied and never trusted.
   */
  trustedProxyHops: number;
  /** Seconds to keep serving (while /readyz fails) before closing the listener on SIGTERM. */
  shutdownDelaySec: number;
  /** Seconds between scheduler ticks (stats rollups, baseline, cleanup). */
  schedulerIntervalSec: number;
  /**
   * Idle keep-alive connections are closed after this long. Must exceed the idle timeout of
   * any proxy in front (Envoy Gateway is set to 60 s by the chart, cloud load balancers use
   * 60 s), or the proxy can reuse a connection at the instant the server closes it.
   */
  httpKeepAliveSec: number;
  metricsEnabled: boolean;
}

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === "true" || value === "1"));

/** `WEBFLIX_MEDIA_MANIFEST=blob:<key>`: the manifest lives in the blob store. */
export const BLOB_MANIFEST_PREFIX = "blob:";

const DEV_RATE_LIMITS = {
  WEBFLIX_RATE_LIMIT_AUTH: "60/60",
  WEBFLIX_RATE_LIMIT_SIGNUP: "60/60",
  WEBFLIX_RATE_LIMIT_EMAIL_LOOKUP: "300/60",
  WEBFLIX_RATE_LIMIT_PROFILE_PIN: "60/60",
};

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

/**
 * Parse `process.env`. Dev mode needs no variables at all (zero infrastructure): SQLite in
 * `.data/`, filesystem blobs in `.data/blobs`, packaged media read from `.cache/media/*` when
 * `make content` has produced it, everything else in process.
 */
export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // WEBFLIX_MODE defaults to dev here (and only here): `pnpm dev` must work with no setup.
  const mode = env.WEBFLIX_MODE ?? "dev";
  const core = loadCoreConfig({
    WEBFLIX_MODE: mode,
    // Dev only: generous limits so e2e suites and people clicking around (everyone shares the
    // demo account and 127.0.0.1) do not trip them. Any explicit WEBFLIX_RATE_LIMIT_* wins;
    // k8s and cloudflare keep the strict defaults from @webflix/core.
    ...(mode === "dev" ? DEV_RATE_LIMITS : {}),
    ...env,
  });
  const dev = core.mode === "dev";
  const Env = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    WEBFLIX_OPS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    HOST: z.string().min(1).optional(),
    WEBFLIX_DATABASE_URL: z.string().min(1).optional(),
    WEBFLIX_DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
    WEBFLIX_DATABASE_KEEPALIVE_MS: z.coerce.number().int().min(0).optional(),
    WEBFLIX_BLOB_STORE: z.enum(["fs", "memory", "s3"]).optional(),
    WEBFLIX_BLOB_DIR: z.string().min(1).optional(),
    WEBFLIX_MEDIA_DIR: z.string().optional(),
    WEBFLIX_MEDIA_MANIFEST: z.string().optional(),
    WEBFLIX_VALKEY_URL: z
      .string()
      .url()
      .refine((value) => /^rediss?:\/\//.test(value), "expected redis:// or rediss://")
      .optional(),
    WEBFLIX_VALKEY_PASSWORD: z.string().min(1).optional(),
    WEBFLIX_VALKEY_KEY_PREFIX: z.string().default("webflix:"),
    WEBFLIX_JOBS_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    WEBFLIX_S3_ENDPOINT: z.string().url().optional(),
    WEBFLIX_S3_REGION: z.string().default("us-east-1"),
    WEBFLIX_S3_BUCKET: z.string().default("webflix-media"),
    WEBFLIX_S3_ACCESS_KEY_ID: z.string().optional(),
    WEBFLIX_S3_SECRET_ACCESS_KEY: z.string().optional(),
    WEBFLIX_S3_FORCE_PATH_STYLE: bool(true),
    WEBFLIX_PASSWORD_HASHER: z.enum(["scrypt", "pbkdf2"]).default("scrypt"),
    WEBFLIX_MIGRATE_ON_START: bool(dev),
    WEBFLIX_SEED_ON_START: bool(dev),
    WEBFLIX_TRUST_PROXY: bool(core.mode === "k8s"),
    WEBFLIX_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
    WEBFLIX_SHUTDOWN_DELAY_SEC: z.coerce
      .number()
      .int()
      .min(0)
      .default(dev ? 0 : 5),
    WEBFLIX_SCHEDULER_INTERVAL_SEC: z.coerce.number().int().min(5).default(300),
    WEBFLIX_HTTP_KEEP_ALIVE_SEC: z.coerce.number().int().min(1).max(3600).default(65),
    WEBFLIX_METRICS: bool(true),
  });
  const parsed = Env.safeParse(
    Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
    ),
  );
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }
  const vars = parsed.data;
  const issues: string[] = [];

  if (core.mode === "cloudflare")
    issues.push("WEBFLIX_MODE=cloudflare runs in apps/edge, not the Node API");
  if (vars.WEBFLIX_OPS_PORT !== undefined && vars.WEBFLIX_OPS_PORT === vars.PORT)
    issues.push("WEBFLIX_OPS_PORT: must differ from PORT");

  /** A whole number of milliseconds (0 allowed) from `env`, or undefined when unset. */
  const millis = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0) return value;
    issues.push(`${name}: expected a whole number of milliseconds (0 for none)`);
    return undefined;
  };

  let database: DatabaseConfig;
  const url =
    vars.WEBFLIX_DATABASE_URL ??
    (dev ? `sqlite:${join(REPO_ROOT, ".data", "webflix.sqlite")}` : undefined);
  if (!url) {
    issues.push("WEBFLIX_DATABASE_URL: required outside dev mode (postgres://...)");
    database = { kind: "sqlite", path: ":memory:" };
  } else if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const timeouts: Partial<Record<PostgresRole, PostgresTimeouts>> = {};
    for (const role of POSTGRES_ROLES) {
      const statement = millis(timeoutVariable(role, "STATEMENT"));
      const query = millis(timeoutVariable(role, "QUERY"));
      if (statement === undefined && query === undefined) continue;
      timeouts[role] = {
        ...(statement !== undefined ? { statementTimeoutMs: statement } : {}),
        ...(query !== undefined ? { queryTimeoutMs: query } : {}),
      };
      // The client-side bound fires only when the server cannot answer: it must leave the
      // server's own timeout room to answer first, or slow statements would be cut as outages.
      const effectiveStatement = statement ?? POSTGRES_ROLE_TIMEOUTS[role].statementTimeoutMs;
      const effectiveQuery = query ?? POSTGRES_ROLE_TIMEOUTS[role].queryTimeoutMs;
      if (
        effectiveQuery > 0 &&
        (effectiveStatement === 0 || effectiveQuery <= effectiveStatement)
      ) {
        issues.push(
          `${timeoutVariable(role, "QUERY")}: ${effectiveQuery} must exceed the ${role} statement timeout (${effectiveStatement || "none"}), or be 0`,
        );
      }
    }
    database = {
      kind: "postgres",
      url,
      maxConnections: vars.WEBFLIX_DATABASE_POOL_MAX,
      timeouts,
      keepAliveInitialDelayMs: vars.WEBFLIX_DATABASE_KEEPALIVE_MS ?? null,
    };
  } else if (url.startsWith("sqlite:")) {
    const path = url.slice("sqlite:".length);
    database = { kind: "sqlite", path: path === ":memory:" ? path : resolve(path) };
  } else {
    issues.push("WEBFLIX_DATABASE_URL: expected postgres://... or sqlite:<path>");
    database = { kind: "sqlite", path: ":memory:" };
  }

  const blobKind = vars.WEBFLIX_BLOB_STORE ?? (dev ? "fs" : "s3");
  const blobs: BlobStoreConfig =
    blobKind === "fs"
      ? { kind: "fs", root: resolve(vars.WEBFLIX_BLOB_DIR ?? join(REPO_ROOT, ".data", "blobs")) }
      : blobKind === "memory"
        ? { kind: "memory" }
        : {
            kind: "s3",
            endpoint: vars.WEBFLIX_S3_ENDPOINT ?? null,
            region: vars.WEBFLIX_S3_REGION,
            bucket: vars.WEBFLIX_S3_BUCKET,
            accessKeyId: vars.WEBFLIX_S3_ACCESS_KEY_ID ?? null,
            secretAccessKey: vars.WEBFLIX_S3_SECRET_ACCESS_KEY ?? null,
            forcePathStyle: vars.WEBFLIX_S3_FORCE_PATH_STYLE,
          };

  // Packaged media: explicit, else (dev) whatever `make content` produced, fast profile first.
  const mediaDir =
    vars.WEBFLIX_MEDIA_DIR !== undefined
      ? vars.WEBFLIX_MEDIA_DIR === "" || vars.WEBFLIX_MEDIA_DIR === "none"
        ? null
        : resolve(vars.WEBFLIX_MEDIA_DIR)
      : dev
        ? firstExisting(
            ["fast", "full"].map((profile) => join(REPO_ROOT, ".cache", "media", profile)),
          )
        : null;
  // `blob:<key>` reads the manifest from the blob store (k8s: uploaded with the media).
  const manifestPath =
    vars.WEBFLIX_MEDIA_MANIFEST !== undefined
      ? vars.WEBFLIX_MEDIA_MANIFEST === "" || vars.WEBFLIX_MEDIA_MANIFEST === "none"
        ? null
        : vars.WEBFLIX_MEDIA_MANIFEST.startsWith(BLOB_MANIFEST_PREFIX)
          ? vars.WEBFLIX_MEDIA_MANIFEST
          : resolve(vars.WEBFLIX_MEDIA_MANIFEST)
      : mediaDir
        ? firstExisting([join(mediaDir, "manifest.json")])
        : null;

  if (issues.length > 0) throw new ConfigError(issues);
  return {
    core,
    host: vars.HOST,
    port: vars.PORT,
    opsPort: vars.WEBFLIX_OPS_PORT ?? null,
    database,
    blobs,
    mediaDir,
    manifestPath,
    valkeyUrl: vars.WEBFLIX_VALKEY_URL ?? null,
    valkeyPassword: vars.WEBFLIX_VALKEY_PASSWORD ?? null,
    valkeyKeyPrefix: vars.WEBFLIX_VALKEY_KEY_PREFIX,
    jobsConcurrency: vars.WEBFLIX_JOBS_CONCURRENCY,
    passwordHasher: vars.WEBFLIX_PASSWORD_HASHER,
    migrateOnStart: vars.WEBFLIX_MIGRATE_ON_START,
    seedOnStart: vars.WEBFLIX_SEED_ON_START,
    trustProxy: vars.WEBFLIX_TRUST_PROXY,
    trustedProxyHops: vars.WEBFLIX_TRUSTED_PROXY_HOPS,
    shutdownDelaySec: vars.WEBFLIX_SHUTDOWN_DELAY_SEC,
    schedulerIntervalSec: vars.WEBFLIX_SCHEDULER_INTERVAL_SEC,
    httpKeepAliveSec: vars.WEBFLIX_HTTP_KEEP_ALIVE_SEC,
    metricsEnabled: vars.WEBFLIX_METRICS,
  };
}

/** Log-safe view of the configuration (no secrets). */
export function describeConfig(config: ApiConfig): Record<string, unknown> {
  return {
    mode: config.core.mode,
    environment: config.core.environment,
    publicOrigin: config.core.publicOrigin,
    port: config.port,
    opsPort: config.opsPort ?? "same as port",
    database:
      config.database.kind === "sqlite"
        ? `sqlite:${config.database.path}`
        : {
            kind: "postgres",
            poolMax: config.database.maxConnections,
            timeoutOverrides: config.database.timeouts,
            keepAliveInitialDelayMs: config.database.keepAliveInitialDelayMs ?? "default",
          },
    blobs:
      config.blobs.kind === "fs"
        ? `fs:${config.blobs.root}`
        : config.blobs.kind === "s3"
          ? `s3:${config.blobs.endpoint ?? "aws"}/${config.blobs.bucket}`
          : config.blobs.kind,
    mediaDir: config.mediaDir,
    manifest: config.manifestPath,
    sharedState: config.valkeyUrl ? `valkey:${redactUrl(config.valkeyUrl)}` : "in-process",
    trustProxy: config.trustProxy ? `${config.trustedProxyHops} hop(s)` : false,
    passwordHasher: config.passwordHasher,
  };
}

/** A URL without its credentials, for logs. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "(invalid)";
  }
}
