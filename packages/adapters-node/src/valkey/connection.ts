import { createHash } from "node:crypto";
import { AppError, type Logger, noopLogger, serializeError } from "@webflix/core";
import { Redis, type RedisOptions } from "ioredis";

export interface ValkeyOptions {
  /** `redis://[:password@]host:port[/db]` or `rediss://` for TLS. */
  url: string;
  /** Overrides the URL's password (lets the URL live in config and the password in a Secret). */
  password?: string | null;
  /** Prefix for every key this process writes (default `webflix:`). */
  keyPrefix?: string;
  /** Upper bound for one command, queueing included (default 2000 ms). */
  commandTimeoutMs?: number;
  /** Shown in `CLIENT LIST` (default `webflix`). */
  connectionName?: string;
  logger?: Logger;
}

/**
 * One Valkey connection shared by the cache, rate limiter, stream gate and job producer
 * (commands are pipelined over it), plus the consumer's blocking connection when a worker
 * asks for one.
 *
 * Failure model: the client reconnects forever with capped backoff. While it is down a
 * command waits at most `commandTimeoutMs` and then fails with `service_unavailable` (HTTP
 * 503), so requests never hang on an outage and the readiness probe sees it at once.
 */
export interface ValkeyConnection {
  readonly client: Redis;
  readonly keyPrefix: string;
  readonly logger: Logger;
  /** Readiness: fails fast while disconnected, else a PING within the timeout. */
  ping(): Promise<void>;
  /**
   * Run a command for a request: connectivity failures become `service_unavailable` (503), and
   * once Valkey has been unreachable for over a second, commands fail at once instead of each
   * waiting out the command timeout (a blip shorter than that is queued and retried).
   */
  guard<T>(operation: string, run: () => Promise<T>): Promise<T>;
  /** A dedicated connection for blocking reads (XREADGROUP BLOCK), closed with this one. */
  blocking(name: string): Redis;
  close(): Promise<void>;
}

const DEFAULT_PREFIX = "webflix:";
/** Down this long: stop queueing commands for requests, fail them at once. */
const FAST_FAIL_AFTER_MS = 1000;

export function connectValkey(options: ValkeyOptions): ValkeyConnection {
  const logger = options.logger ?? noopLogger;
  const commandTimeout = options.commandTimeoutMs ?? 2000;
  const base: RedisOptions = {
    connectionName: options.connectionName ?? "webflix",
    // Reconnect forever with capped backoff; requests fail fast in the meantime (below).
    retryStrategy: (attempt) => Math.min(100 * 2 ** Math.min(attempt, 5), 2000),
    // A command issued while disconnected is queued until the next reconnect attempt, then
    // rejected; `commandTimeout` bounds the total wait either way.
    maxRetriesPerRequest: 1,
    commandTimeout,
    connectTimeout: 5000,
    // A failover leaves clients talking to a demoted primary: reconnect to whoever is primary.
    reconnectOnError: (error) => /READONLY|LOADING|MASTERDOWN/.test(error.message),
    enableAutoPipelining: true,
    ...(options.password ? { password: options.password } : {}),
  };
  const client = new Redis(options.url, base);
  const extra = new Set<Redis>();
  let lastState = "";
  const track = (connection: Redis, name: string) => {
    connection.on("ready", () => {
      if (lastState !== "ready") logger.info("valkey.ready", { connection: name });
      lastState = "ready";
    });
    connection.on("error", (error: Error) => {
      // ioredis emits one error per failed reconnect attempt; log state changes only.
      if (lastState !== `error:${error.message}`) {
        logger.warn("valkey.error", { connection: name, error: serializeError(error) });
      }
      lastState = `error:${error.message}`;
    });
  };
  track(client, "commands");
  // Since when the command connection has been unusable (null while it is fine).
  let downSince: number | null = null;
  client.on("ready", () => {
    downSince = null;
  });
  for (const event of ["close", "end", "reconnecting", "error"]) {
    client.on(event, () => {
      if (client.status !== "ready" && downSince === null) downSince = Date.now();
    });
  }

  return {
    client,
    keyPrefix: options.keyPrefix ?? DEFAULT_PREFIX,
    logger,
    async ping() {
      if (client.status !== "ready") throw new Error(`Valkey connection is ${client.status}`);
      await client.ping();
    },
    async guard(operation, run) {
      if (
        downSince !== null &&
        client.status !== "ready" &&
        Date.now() - downSince > FAST_FAIL_AFTER_MS
      ) {
        throw new AppError("service_unavailable", {
          detail: `Shared state is temporarily unavailable (${operation})`,
        });
      }
      return guarded(operation, run);
    },
    blocking(name) {
      const connection = client.duplicate({
        connectionName: `${base.connectionName}-${name}`,
        // Blocking reads outlive any command timeout; they are bounded by their BLOCK argument.
        commandTimeout: undefined,
        maxRetriesPerRequest: null,
        enableAutoPipelining: false,
      });
      track(connection, name);
      extra.add(connection);
      return connection;
    },
    async close() {
      for (const connection of extra) connection.disconnect();
      extra.clear();
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}

/**
 * Errors that mean "Valkey cannot serve this right now", as opposed to a bug in a command:
 * unreachable, loading, failing over, or full (`noeviction` refuses writes with OOM rather
 * than dropping leases or queued jobs).
 */
export function isUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // A transaction (MULTI/EXEC) aborts with EXECABORT and carries the queued commands' errors.
  const queued = (error as { previousErrors?: unknown[] }).previousErrors;
  if (Array.isArray(queued) && queued.some(isUnavailable)) return true;
  return (
    error.name === "MaxRetriesPerRequestError" ||
    /Connection is closed|Command timed out|Stream isn't writeable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|LOADING|MASTERDOWN|READONLY|TRYAGAIN|CLUSTERDOWN|OOM command not allowed/.test(
      error.message,
    )
  );
}

/**
 * Run a Valkey operation; connectivity failures become `service_unavailable` (503) so the
 * HTTP layer answers honestly instead of with an opaque 500. Anything else propagates.
 */
export async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUnavailable(error)) {
      throw new AppError("service_unavailable", {
        detail: `Shared state is temporarily unavailable (${operation})`,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * A Lua script run with EVALSHA, falling back to EVAL when the server's script cache does not
 * have it (first use, or after a Valkey restart). Scripts are atomic: nothing else runs on the
 * server while one executes, which is what makes the gate and the limiter exact across
 * replicas.
 */
export class LuaScript {
  readonly source: string;
  readonly sha: string;

  constructor(source: string) {
    this.source = source;
    this.sha = createHash("sha1").update(source).digest("hex");
  }

  async run(client: Redis, keys: readonly string[], args: readonly (string | number)[]) {
    try {
      return (await client.evalsha(this.sha, keys.length, ...keys, ...args)) as unknown;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("NOSCRIPT")) {
        return (await client.eval(this.source, keys.length, ...keys, ...args)) as unknown;
      }
      throw error;
    }
  }
}

/**
 * Lua prelude: the current time in epoch ms. Every replica reads Valkey's clock (`TIME`), so
 * leases and windows never depend on pod clock skew; tests pass a manual clock's value
 * instead (an empty argument means "server time").
 */
export const LUA_NOW = `
local function now_ms(arg)
  local value = tonumber(arg)
  if value then return value end
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
`;
