/**
 * Composition of infrastructure for the Node runtime (dev and k8s modes). Everything stateful
 * is chosen here from configuration; services, repositories and routes never change:
 *
 * - Database: SQLite file (dev) or PostgreSQL (`WEBFLIX_DATABASE_URL=postgres://...`).
 * - Search index: in the same database (FTS5 / tsvector).
 * - Shared state (cache, rate limiter, stream gate, job queue): Valkey when
 *   `WEBFLIX_VALKEY_URL` is set (k8s: any number of API replicas plus the worker), else
 *   in-process (dev, or a single replica).
 * - Blob store: filesystem (dev), memory (tests) or S3 (`WEBFLIX_BLOB_STORE=s3`).
 *
 * See docs/BACKEND.md §5 and docs/KUBERNETES.md.
 */
import { createFsBlobStore, createScryptPasswordHasher } from "@webflix/adapters-node";
import { createS3BlobStore } from "@webflix/adapters-node/s3";
import {
  connectValkey,
  createValkeyCache,
  createValkeyJobQueue,
  createValkeyRateLimiter,
  createValkeyStreamGate,
  type JobQueueStats,
} from "@webflix/adapters-node/valkey";
import {
  type BlobStore,
  type Clock,
  ConfigError,
  createPasswordHasherChain,
  createPbkdf2PasswordHasher,
  type IdGenerator,
  type JobProcessor,
  type JobQueue,
  type KeyValueCache,
  type Logger,
  type PasswordHasher,
  type RateLimiter,
  type Repositories,
  type SearchIndex,
  type StreamGate,
  serializeError,
} from "@webflix/core";
import {
  MemoryBlobStore,
  MemoryJobQueue,
  MemoryKeyValueCache,
  MemoryRateLimiter,
  MemoryStreamGate,
} from "@webflix/core/memory";
import { createRepositories, createSqlSearchIndex, type Database } from "@webflix/db";
import { createPostgresDatabase, type PostgresRole } from "@webflix/db/postgres";
import { createSqliteDatabase } from "@webflix/db/sqlite";
import type { ReadinessCheck } from "@webflix/http";
import type { ApiConfig } from "./config.ts";
import { createDirectoryBlobStore, layerBlobStores } from "./media-dir.ts";

/** The job queue as the process sees it: a producer plus a consumer loop it can start. */
export interface JobQueueRuntime {
  queue: JobQueue;
  /** Start delivering jobs to `processor` (in-process timer, or a Valkey Streams consumer group). */
  startConsumer(processor: JobProcessor): void;
  stop(): Promise<void>;
  /** Queue depth (Valkey only), for metrics. */
  stats?(): Promise<JobQueueStats>;
}

export interface SharedState {
  cache: KeyValueCache;
  rateLimiter: RateLimiter;
  streamGate: StreamGate;
  jobs: JobQueueRuntime;
  readiness: ReadinessCheck[];
  close(): Promise<void>;
}

export interface Infrastructure extends SharedState {
  database: Database;
  repos: Repositories;
  search: SearchIndex;
  blobs: BlobStore;
  /** Reachability of the blob store (S3: the bucket), for bootstrap waits; not in readiness. */
  pingBlobs(): Promise<void>;
  passwords: PasswordHasher;
}

/**
 * The processes this runtime is composed for, and the PostgreSQL budgets each one's statements
 * get (`POSTGRES_ROLE_TIMEOUTS`, docs/DECISIONS.md D42): the API answers members (`request`),
 * the worker runs jobs and the scheduler (`background`), the Jobs migrate and seed
 * (`maintenance`). `wait` is the init container's check, a few quick statements.
 */
export const DATABASE_ROLES = {
  api: "request",
  wait: "request",
  worker: "background",
  migrate: "maintenance",
  seed: "maintenance",
} as const satisfies Record<string, PostgresRole>;
export type RuntimeComponent = keyof typeof DATABASE_ROLES;

/** The component's role; an unknown name is a composition error, never a default budget. */
export function databaseRole(component: string): PostgresRole {
  if (!Object.hasOwn(DATABASE_ROLES, component)) {
    throw new ConfigError([
      `component "${component}": expected one of ${Object.keys(DATABASE_ROLES).join(", ")}`,
    ]);
  }
  return DATABASE_ROLES[component as RuntimeComponent];
}

export function createDatabase(config: ApiConfig, role: PostgresRole, logger?: Logger): Database {
  return config.database.kind === "postgres"
    ? createPostgresDatabase({
        connectionString: config.database.url,
        maxConnections: config.database.maxConnections,
        applicationName: `webflix-${config.core.mode}`,
        role,
        ...config.database.timeouts[role],
        ...(config.database.keepAliveInitialDelayMs !== null
          ? { keepAliveInitialDelayMs: config.database.keepAliveInitialDelayMs }
          : {}),
        // A database restart: the pool drops the dead connection and reconnects on demand.
        onIdleConnectionError: (error) =>
          logger?.warn("db.connection_lost", { error: serializeError(error) }),
      })
    : createSqliteDatabase({ path: config.database.path });
}

/** Valkey-backed shared state (k8s), in-process otherwise (dev, single replica). */
function createSharedState(
  config: ApiConfig,
  deps: { clock: Clock; ids: IdGenerator; logger: Logger; component: string },
): SharedState {
  if (config.valkeyUrl) {
    const valkey = connectValkey({
      url: config.valkeyUrl,
      password: config.valkeyPassword,
      keyPrefix: config.valkeyKeyPrefix,
      connectionName: `webflix-${deps.component}`,
      logger: deps.logger.child({ component: "valkey" }),
    });
    const queue = createValkeyJobQueue(valkey, {
      ids: deps.ids,
      concurrency: config.jobsConcurrency,
    });
    return {
      cache: createValkeyCache(valkey),
      rateLimiter: createValkeyRateLimiter(valkey),
      streamGate: createValkeyStreamGate(valkey),
      jobs: {
        queue,
        startConsumer: (processor) => queue.startConsumer(processor),
        stop: () => queue.stop(),
        stats: () => queue.stats(),
      },
      // Without Valkey this instance cannot enforce stream or rate limits consistently with its
      // peers: it must not take traffic (the cache alone would degrade gracefully).
      readiness: [{ name: "valkey", check: () => valkey.ping() }],
      async close() {
        await queue.stop();
        await valkey.close();
      },
    };
  }
  if (config.core.mode === "k8s") {
    deps.logger.warn("state.in_process", {
      detail:
        "Rate limits, stream limits and jobs are per process without WEBFLIX_VALKEY_URL: run a single replica",
    });
  }
  const queue = new MemoryJobQueue({ clock: deps.clock, ids: deps.ids, logger: deps.logger });
  return {
    cache: new MemoryKeyValueCache({ clock: deps.clock }),
    rateLimiter: new MemoryRateLimiter({ clock: deps.clock }),
    streamGate: new MemoryStreamGate({ clock: deps.clock }),
    jobs: {
      queue,
      startConsumer(processor) {
        queue.setProcessor(processor);
        queue.start(500);
      },
      stop: () => queue.stop(),
    },
    readiness: [],
    async close() {
      await queue.stop();
    },
  };
}

/** The media bucket, plus a reachability check (S3: HeadBucket). */
function createBlobStore(config: ApiConfig): { store: BlobStore; ping(): Promise<void> } {
  let store: BlobStore;
  let ping = async () => {};
  switch (config.blobs.kind) {
    case "fs":
      store = createFsBlobStore({ root: config.blobs.root });
      break;
    case "memory":
      store = new MemoryBlobStore();
      break;
    case "s3": {
      const s3 = createS3BlobStore({
        bucket: config.blobs.bucket,
        region: config.blobs.region,
        endpoint: config.blobs.endpoint,
        accessKeyId: config.blobs.accessKeyId,
        secretAccessKey: config.blobs.secretAccessKey,
        forcePathStyle: config.blobs.forcePathStyle,
      });
      store = s3;
      ping = () => s3.ping();
      break;
    }
  }
  // Dev convenience: packaged media straight from `tools/media` output, no upload step.
  return {
    store: config.mediaDir
      ? layerBlobStores(store, createDirectoryBlobStore(config.mediaDir))
      : store,
    ping,
  };
}

function createPasswordHasher(config: ApiConfig): PasswordHasher {
  // Hashes are self-describing: whichever algorithm made a hash can still verify it, and a
  // login upgrades it to the primary (`needsRehash`).
  const scrypt = createScryptPasswordHasher();
  const pbkdf2 = createPbkdf2PasswordHasher();
  return config.passwordHasher === "scrypt"
    ? createPasswordHasherChain(scrypt, pbkdf2)
    : createPasswordHasherChain(pbkdf2, scrypt);
}

export function createInfrastructure(
  config: ApiConfig,
  deps: { clock: Clock; ids: IdGenerator; logger: Logger; component: RuntimeComponent },
): Infrastructure {
  const database = createDatabase(config, databaseRole(deps.component), deps.logger);
  const repos = createRepositories(database);
  const shared = createSharedState(config, deps);
  const blobs = createBlobStore(config);
  return {
    ...shared,
    database,
    repos,
    search: createSqlSearchIndex(database),
    blobs: blobs.store,
    pingBlobs: blobs.ping,
    passwords: createPasswordHasher(config),
    readiness: [{ name: "database", check: () => repos.ping() }, ...shared.readiness],
    async close() {
      await shared.close();
      await database.close();
    },
  };
}
