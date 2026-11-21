import { type Clock, systemClock } from "./clock.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Port: structured logging. One JSON object per line with `level`, `time`, `msg` and fields;
 * request-scoped loggers come from `child({ requestId })`.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export interface LogRecord {
  level: LogLevel;
  time: string;
  msg: string;
  [field: string]: unknown;
}

export type LogSink = (record: LogRecord, line: string) => void;

/**
 * Writes through `console` so the same code logs to stdout on Node (collected by k8s) and to
 * Workers Logs on Cloudflare (which indexes JSON lines).
 */
export const consoleSink: LogSink = (record, line) => {
  if (record.level === "error") console.error(line);
  else if (record.level === "warn") console.warn(line);
  else console.log(line);
};

const MAX_CAUSE_DEPTH = 5;

/** Errors serialise to plain objects (name, message, stack, code, cause chain). */
export function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return error;
  const out: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  for (const key of ["code", "status"] as const) {
    if (key in error) out[key] = (error as unknown as Record<string, unknown>)[key];
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeError(error.cause, depth + 1);
  }
  return out;
}

function stringify(record: LogRecord): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) return serializeError(value);
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  bindings?: LogFields;
  clock?: Clock;
  sink?: LogSink;
}

export function createJsonLogger(options: JsonLoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? "info");
  const clock = options.clock ?? systemClock;
  const sink = options.sink ?? consoleSink;
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const record: LogRecord = {
      ...bindings,
      ...fields,
      level,
      time: new Date(clock.now()).toISOString(),
      msg,
    };
    sink(record, stringify(record));
  };

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (more) => createJsonLogger({ ...options, bindings: { ...bindings, ...more } }),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

/** Captures records in memory; assert on `records` in tests. */
export class MemoryLogger implements Logger {
  readonly records: LogRecord[];
  private readonly bindings: LogFields;
  private readonly clock: Clock;

  constructor(options: { clock?: Clock; bindings?: LogFields; records?: LogRecord[] } = {}) {
    this.records = options.records ?? [];
    this.bindings = options.bindings ?? {};
    this.clock = options.clock ?? systemClock;
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    this.records.push({
      ...this.bindings,
      ...fields,
      level,
      time: new Date(this.clock.now()).toISOString(),
      msg,
    });
  }

  debug(msg: string, fields?: LogFields): void {
    this.write("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }
  child(bindings: LogFields): Logger {
    return new MemoryLogger({
      clock: this.clock,
      bindings: { ...this.bindings, ...bindings },
      records: this.records,
    });
  }
}
