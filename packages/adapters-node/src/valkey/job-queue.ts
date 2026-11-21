import { hostname } from "node:os";
import {
  assertJobBatch,
  assertJobMessage,
  assertPublishOptions,
  type Clock,
  createUuidV7Generator,
  type IdGenerator,
  type JobDelivery,
  type JobMessage,
  type JobOutcome,
  type JobProcessor,
  type JobQueue,
  type PublishOptions,
  serializeError,
} from "@webflix/core";
import type { Redis } from "ioredis";
import { isUnavailable, LUA_NOW, LuaScript, type ValkeyConnection } from "./connection.ts";

/**
 * `JobQueue` on Valkey Streams with a consumer group (the k8s `worker` Deployment).
 *
 *   {jobs}:stream   due deliveries (XADD); the `workers` group tracks what each consumer holds
 *   {jobs}:delayed  sorted set of future deliveries (delayed publishes and backoff retries),
 *                   scored by due time and promoted to the stream when due
 *   {jobs}:dead     dead letters (stream), capped
 *
 * Every entry is one delivery: `{id, type, payload, attempt, enqueuedAt}`; the id is stable
 * across redeliveries. Settling a delivery (ack, retry, dead-letter) is one Lua script, so a
 * job is never lost nor duplicated between "acknowledge" and "requeue".
 *
 * Crash safety: a delivery stays in the group's pending list until settled. If its consumer
 * dies (pod killed, OOM), another consumer reclaims it after `visibilityTimeoutMs` of
 * inactivity (XAUTOCLAIM) and requeues it as the next attempt, dead-lettering it once
 * attempts are exhausted (a poison job that crashes workers cannot loop forever). Consumers
 * keep their own in-flight entries fresh while handlers run, so slow jobs are not stolen.
 * Durability across a Valkey restart relies on its persistence (AOF), like any queue state.
 */

const STREAM_FIELDS = ["id", "type", "payload", "attempt", "enqueuedAt"] as const;

interface Envelope {
  id: string;
  type: string;
  /** JSON text. */
  payload: string;
  attempt: number;
  enqueuedAt: number;
}

function envelopeFields(envelope: Envelope): string[] {
  return [
    "id",
    envelope.id,
    "type",
    envelope.type,
    "payload",
    envelope.payload,
    "attempt",
    String(envelope.attempt),
    "enqueuedAt",
    String(envelope.enqueuedAt),
  ];
}

function parseFields(fields: readonly string[]): Envelope | null {
  const record: Record<string, string> = {};
  for (let index = 0; index + 1 < fields.length; index += 2) {
    record[fields[index] as string] = fields[index + 1] as string;
  }
  if (STREAM_FIELDS.some((name) => record[name] === undefined)) return null;
  return {
    id: record.id as string,
    type: record.type as string,
    payload: record.payload as string,
    attempt: Number(record.attempt),
    enqueuedAt: Number(record.enqueuedAt),
  };
}

// KEYS: delayed; ARGV: due offset ms, now (or ''), then envelope JSON strings.
const SCHEDULE = new LuaScript(`${LUA_NOW}
local now = now_ms(ARGV[2])
local due = now + tonumber(ARGV[1])
for i = 3, #ARGV do redis.call('ZADD', KEYS[1], due, ARGV[i]) end
return due
`);

// KEYS: delayed, stream; ARGV: now (or ''), max batch. Moves due deliveries to the stream.
const PROMOTE = new LuaScript(`${LUA_NOW}
local now = now_ms(ARGV[1])
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[2]))
for _, encoded in ipairs(due) do
  local e = cjson.decode(encoded)
  redis.call('XADD', KEYS[2], '*', 'id', e.id, 'type', e.type, 'payload', e.payload,
    'attempt', tostring(e.attempt), 'enqueuedAt', tostring(e.enqueuedAt))
  redis.call('ZREM', KEYS[1], encoded)
end
return #due
`);

// KEYS: stream, delayed, dead
// ARGV: group, consumer, entryId, action (ack|retry|dead), delayMs, now (or ''),
//       next envelope JSON (retry) or dead-letter fields JSON (dead), deadMaxLen
// Settles only if this consumer still owns the entry; otherwise someone reclaimed it after a
// timeout and that consumer is now responsible for it.
const SETTLE = new LuaScript(`${LUA_NOW}
local pending = redis.call('XPENDING', KEYS[1], ARGV[1], ARGV[3], ARGV[3], 1)
if #pending == 0 or pending[1][2] ~= ARGV[2] then return 0 end
local action = ARGV[4]
if action == 'retry' then
  local e = cjson.decode(ARGV[7])
  local delay = tonumber(ARGV[5])
  if delay > 0 then
    redis.call('ZADD', KEYS[2], now_ms(ARGV[6]) + delay, ARGV[7])
  else
    redis.call('XADD', KEYS[1], '*', 'id', e.id, 'type', e.type, 'payload', e.payload,
      'attempt', tostring(e.attempt), 'enqueuedAt', tostring(e.enqueuedAt))
  end
elseif action == 'dead' then
  local d = cjson.decode(ARGV[7])
  redis.call('XADD', KEYS[3], 'MAXLEN', '~', tonumber(ARGV[8]), '*',
    'id', d.id, 'type', d.type, 'payload', d.payload, 'attempt', tostring(d.attempt),
    'enqueuedAt', tostring(d.enqueuedAt), 'deadAt', tostring(now_ms(ARGV[6])), 'reason', d.reason)
end
redis.call('XACK', KEYS[1], ARGV[1], ARGV[3])
redis.call('XDEL', KEYS[1], ARGV[3])
return 1
`);

export interface ValkeyJobQueueOptions {
  /** Queue name; keys are `<prefix>{<name>}:stream|delayed|dead` (default `jobs`). */
  name?: string;
  /** Consumer group (default `workers`). */
  group?: string;
  /** This consumer's name in the group (default `<hostname>-<pid>`, the pod name in k8s). */
  consumer?: string;
  ids?: IdGenerator;
  /** Tests only: read time from this clock instead of Valkey's `TIME`. */
  clock?: Clock;
  /** Deliveries before a job is dead-lettered (default 5, like the memory queue). */
  maxAttempts?: number;
  /** Delay for a retry the processor asks for without `delaySec`, and for thrown errors. */
  defaultRetryDelaySec?: number;
  /** Deliveries processed concurrently by one consumer (default 8). */
  concurrency?: number;
  /** A delivery idle this long in another consumer's hands is reclaimed (default 60 s). */
  visibilityTimeoutMs?: number;
  /** How often due delayed jobs are promoted (default 1000 ms). */
  pollIntervalMs?: number;
  /** XREADGROUP BLOCK time (default 5000 ms); bounds how fast `stop()` returns. */
  blockMs?: number;
  /** Dead letters kept (approximately; default 10 000). */
  deadLetterMaxLen?: number;
}

export interface JobQueueStats {
  /** Deliveries waiting in the stream or held by consumers. */
  stream: number;
  delayed: number;
  dead: number;
  /** Delivered but not yet settled (whole group). */
  pending: number;
}

export interface ValkeyJobQueue extends JobQueue {
  /** Start the consumer loop: read, process, settle; promote delayed jobs; reclaim. */
  startConsumer(processor: JobProcessor): void;
  /** Stop reading, let in-flight deliveries settle (bounded), then return. */
  stop(timeoutMs?: number): Promise<void>;
  /** Resolve once nothing is due, in flight or pending (tests and tooling). */
  drain(timeoutMs?: number): Promise<void>;
  deadLetters(limit?: number): Promise<JobDelivery[]>;
  stats(): Promise<JobQueueStats>;
  /** Process-local counters since start (for metrics). */
  readonly counters: {
    processed: number;
    retried: number;
    deadLettered: number;
    reclaimed: number;
  };
}

export function createValkeyJobQueue(
  valkey: ValkeyConnection,
  options: ValkeyJobQueueOptions = {},
): ValkeyJobQueue {
  const { client, logger } = valkey;
  const name = options.name ?? "jobs";
  const keys = {
    stream: `${valkey.keyPrefix}{${name}}:stream`,
    delayed: `${valkey.keyPrefix}{${name}}:delayed`,
    dead: `${valkey.keyPrefix}{${name}}:dead`,
  };
  const group = options.group ?? "workers";
  const consumer = options.consumer ?? `${hostname()}-${process.pid}`;
  const ids = options.ids ?? createUuidV7Generator();
  const maxAttempts = options.maxAttempts ?? 5;
  const defaultRetryDelaySec = options.defaultRetryDelaySec ?? 0;
  const concurrency = options.concurrency ?? 8;
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const blockMs = options.blockMs ?? 5000;
  const deadLetterMaxLen = options.deadLetterMaxLen ?? 10_000;
  const nowArg = () => (options.clock ? String(options.clock.now()) : "");
  const nowMs = () => (options.clock ? options.clock.now() : Date.now());
  const counters = { processed: 0, retried: 0, deadLettered: 0, reclaimed: 0 };

  const envelopeOf = (job: JobMessage): Envelope => ({
    id: ids.next(),
    type: job.type,
    // Serialised now: later mutations of the caller's object never reach the consumer.
    payload: JSON.stringify(job.payload),
    attempt: 1,
    enqueuedAt: nowMs(),
  });

  async function enqueue(envelopes: Envelope[], delaySec: number): Promise<void> {
    if (envelopes.length === 0) return;
    await valkey.guard("jobs.publish", async () => {
      if (delaySec > 0) {
        await SCHEDULE.run(
          client,
          [keys.delayed],
          [delaySec * 1000, nowArg(), ...envelopes.map((envelope) => JSON.stringify(envelope))],
        );
        return;
      }
      // One round trip, all or nothing (MULTI): a batch is never half-published.
      const multi = client.multi();
      for (const envelope of envelopes) multi.xadd(keys.stream, "*", ...envelopeFields(envelope));
      const results = await multi.exec();
      const failed = results?.find(([error]) => error);
      if (!results || failed) throw failed?.[0] ?? new Error("Job publish transaction aborted");
    });
  }

  // --- consumer ------------------------------------------------------------------------------

  let processor: JobProcessor | undefined;
  let running = false;
  let reader: Redis | undefined;
  let readLoop: Promise<void> | undefined;
  let timers: ReturnType<typeof setInterval>[] = [];
  const inFlight = new Map<string, Promise<void>>();
  let slotFreed: (() => void) | undefined;

  async function ensureGroup(): Promise<void> {
    try {
      // From the start of the stream: jobs published before the first worker are delivered.
      await client.xgroup("CREATE", keys.stream, group, "0", "MKSTREAM");
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("BUSYGROUP"))) throw error;
    }
  }

  async function settle(entryId: string, envelope: Envelope, outcome: JobOutcome): Promise<void> {
    let action: "ack" | "retry" | "dead" = "ack";
    let delayMs = 0;
    let data = "";
    if (outcome.action === "retry") {
      if (envelope.attempt >= maxAttempts) {
        action = "dead";
        data = JSON.stringify({ ...envelope, reason: "max_attempts" });
      } else {
        action = "retry";
        delayMs = (outcome.delaySec ?? defaultRetryDelaySec) * 1000;
        data = JSON.stringify({ ...envelope, attempt: envelope.attempt + 1 });
      }
    }
    const settled = await SETTLE.run(
      client,
      [keys.stream, keys.delayed, keys.dead],
      [group, consumer, entryId, action, delayMs, nowArg(), data, deadLetterMaxLen],
    );
    if (settled !== 1) {
      logger.warn("jobs.settle_skipped", { jobId: envelope.id, reason: "reclaimed" });
      return;
    }
    if (action === "ack") counters.processed += 1;
    if (action === "retry") counters.retried += 1;
    if (action === "dead") {
      counters.deadLettered += 1;
      logger.error("jobs.dead_lettered", {
        jobId: envelope.id,
        jobType: envelope.type,
        attempts: envelope.attempt,
      });
    }
  }

  async function handle(entryId: string, fields: readonly string[]): Promise<void> {
    const envelope = parseFields(fields);
    if (!envelope) {
      // Not ours (written by hand?): dead-letter it rather than crash or loop on it.
      await SETTLE.run(
        client,
        [keys.stream, keys.delayed, keys.dead],
        [
          group,
          consumer,
          entryId,
          "dead",
          0,
          nowArg(),
          JSON.stringify({
            id: entryId,
            type: "invalid",
            payload: JSON.stringify(fields),
            attempt: 1,
            enqueuedAt: 0,
            reason: "malformed_entry",
          }),
          deadLetterMaxLen,
        ],
      );
      return;
    }
    const active = processor;
    let outcome: JobOutcome;
    try {
      if (!active) throw new Error("No processor");
      let payload: JobDelivery["payload"];
      try {
        payload = JSON.parse(envelope.payload) as JobDelivery["payload"];
      } catch {
        payload = null;
      }
      outcome = await active({
        id: envelope.id,
        type: envelope.type,
        payload,
        attempt: envelope.attempt,
        enqueuedAt: envelope.enqueuedAt,
      });
    } catch (error) {
      logger.warn("jobs.processor_threw", { jobId: envelope.id, error: serializeError(error) });
      outcome = { action: "retry" };
    }
    // Settling can fail while Valkey is down: the delivery stays pending and is reclaimed.
    await settle(entryId, envelope, outcome).catch((error: unknown) => {
      logger.warn("jobs.settle_failed", { jobId: envelope.id, error: serializeError(error) });
    });
  }

  function dispatch(entryId: string, fields: readonly string[]): void {
    const task = handle(entryId, fields).finally(() => {
      inFlight.delete(entryId);
      slotFreed?.();
    });
    inFlight.set(entryId, task);
  }

  async function waitForSlot(): Promise<void> {
    while (running && inFlight.size >= concurrency) {
      await new Promise<void>((resolve) => {
        slotFreed = resolve;
      });
    }
  }

  async function readForever(connection: Redis): Promise<void> {
    let groupReady = false;
    while (running) {
      try {
        if (!groupReady) {
          await ensureGroup();
          groupReady = true;
        }
        await waitForSlot();
        if (!running) break;
        const reply = (await connection.xreadgroup(
          "GROUP",
          group,
          consumer,
          "COUNT",
          concurrency - inFlight.size,
          "BLOCK",
          blockMs,
          "STREAMS",
          keys.stream,
          ">",
        )) as [string, [string, string[]][]][] | null;
        for (const [, entries] of reply ?? []) {
          for (const [entryId, fields] of entries) dispatch(entryId, fields);
        }
      } catch (error) {
        if (!running) break;
        // NOGROUP: the stream was deleted (FLUSHALL, Valkey lost its data): recreate it.
        if (error instanceof Error && error.message.includes("NOGROUP")) groupReady = false;
        if (!isUnavailable(error)) {
          logger.error("jobs.read_failed", { error: serializeError(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async function promoteDue(): Promise<number> {
    return (await PROMOTE.run(client, [keys.delayed, keys.stream], [nowArg(), 100])) as number;
  }

  /** Requeue deliveries other consumers have held too long (crashed or stuck). */
  async function reclaim(): Promise<void> {
    let cursor = "0-0";
    for (let round = 0; round < 10; round += 1) {
      const [next, entries] = (await client.xautoclaim(
        keys.stream,
        group,
        consumer,
        visibilityTimeoutMs,
        cursor,
        "COUNT",
        50,
      )) as [string, [string, string[] | null][]];
      for (const [entryId, fields] of entries) {
        if (inFlight.has(entryId)) continue;
        const envelope = fields ? parseFields(fields) : null;
        counters.reclaimed += 1;
        logger.warn("jobs.reclaimed", { jobId: envelope?.id ?? entryId, from: "idle consumer" });
        if (!envelope) {
          await client.xack(keys.stream, group, entryId);
          continue;
        }
        // The previous delivery never settled: count it as a failed attempt.
        await settle(entryId, envelope, { action: "retry", delaySec: 0 });
      }
      if (next === "0-0") break;
      cursor = next;
    }
  }

  /** Reset the idle time of deliveries still being processed here, so nobody reclaims them. */
  async function touchInFlight(): Promise<void> {
    if (inFlight.size === 0) return;
    await client.xclaim(keys.stream, group, consumer, 0, ...inFlight.keys(), "JUSTID");
  }

  /** Forget consumers (old pods) that hold nothing and have been idle for an hour. */
  async function pruneConsumers(): Promise<void> {
    const list = (await client.xinfo("CONSUMERS", keys.stream, group)) as unknown[][];
    for (const entry of list) {
      const info: Record<string, unknown> = {};
      for (let index = 0; index + 1 < entry.length; index += 2) {
        info[String(entry[index])] = entry[index + 1];
      }
      if (info.name !== consumer && info.pending === 0 && Number(info.idle) > 3_600_000) {
        await client.xgroup("DELCONSUMER", keys.stream, group, String(info.name));
      }
    }
  }

  function every(ms: number, task: () => Promise<unknown>, label: string): void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy || !running) return;
      busy = true;
      task()
        .catch((error: unknown) => {
          if (
            !isUnavailable(error) &&
            !(error instanceof Error && error.message.includes("NOGROUP"))
          ) {
            logger.warn(`jobs.${label}_failed`, { error: serializeError(error) });
          }
        })
        .finally(() => {
          busy = false;
        });
    }, ms);
    timer.unref();
    timers.push(timer);
  }

  async function stats(): Promise<JobQueueStats> {
    const [stream, delayed, dead, summary] = await Promise.all([
      client.xlen(keys.stream),
      client.zcard(keys.delayed),
      client.xlen(keys.dead),
      client.xpending(keys.stream, group).catch(() => [0]) as Promise<unknown[]>,
    ]);
    return { stream, delayed, dead, pending: Number(summary[0] ?? 0) };
  }

  return {
    counters,

    async publish(job, publishOptions: PublishOptions = {}) {
      assertJobMessage(job);
      assertPublishOptions(publishOptions);
      await enqueue([envelopeOf(job)], publishOptions.delaySec ?? 0);
    },

    async publishBatch(jobs, publishOptions: PublishOptions = {}) {
      assertJobBatch(jobs);
      assertPublishOptions(publishOptions);
      await enqueue(jobs.map(envelopeOf), publishOptions.delaySec ?? 0);
    },

    startConsumer(next) {
      if (running) return;
      processor = next;
      running = true;
      reader = valkey.blocking(`jobs-${consumer}`);
      readLoop = readForever(reader);
      every(pollIntervalMs, promoteDue, "promote");
      every(Math.max(1000, Math.floor(visibilityTimeoutMs / 2)), reclaim, "reclaim");
      every(Math.max(500, Math.floor(visibilityTimeoutMs / 3)), touchInFlight, "touch");
      every(600_000, pruneConsumers, "prune");
      logger.info("jobs.consumer_started", { consumer, group, concurrency });
    },

    async stop(timeoutMs = 20_000) {
      if (!running) return;
      running = false;
      for (const timer of timers) clearInterval(timer);
      timers = [];
      slotFreed?.();
      // Interrupts a pending XREADGROUP BLOCK at once.
      reader?.disconnect();
      await readLoop;
      const settled = Promise.allSettled([...inFlight.values()]);
      const timedOut = await Promise.race([
        settled.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs).unref()),
      ]);
      if (timedOut) {
        // Left pending in the group: another consumer reclaims them after the timeout.
        logger.warn("jobs.stop_timeout", { inFlight: inFlight.size });
      }
      logger.info("jobs.consumer_stopped", { consumer, ...counters });
    },

    async drain(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await promoteDue();
        const now = nowArg();
        const [due, info] = await Promise.all([
          client.zcount(keys.delayed, "-inf", now === "" ? String(Date.now()) : now),
          stats(),
        ]);
        // Settled entries are deleted, so the stream length is "not yet settled".
        if (due === 0 && info.stream === 0 && info.pending === 0 && inFlight.size === 0) return;
        if (Date.now() > deadline) {
          throw new Error(
            `Job queue did not drain in ${timeoutMs} ms (${JSON.stringify({ due, ...info, inFlight: inFlight.size })})`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },

    async deadLetters(limit = 100) {
      const entries = (await client.xrevrange(keys.dead, "+", "-", "COUNT", limit)) as [
        string,
        string[],
      ][];
      return entries
        .reverse()
        .map(([, fields]) => parseFields(fields))
        .filter((envelope): envelope is Envelope => envelope !== null)
        .map((envelope) => {
          let payload: JobDelivery["payload"];
          try {
            payload = JSON.parse(envelope.payload) as JobDelivery["payload"];
          } catch {
            payload = envelope.payload;
          }
          return {
            id: envelope.id,
            type: envelope.type,
            payload,
            attempt: envelope.attempt,
            enqueuedAt: envelope.enqueuedAt,
          };
        });
    },

    stats,
  };
}
