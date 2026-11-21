/**
 * Identifying local processes before signalling them (`make cf-stop`). The decisions are pure
 * functions over facts gathered with `ps` and `lsof`, so they are unit-tested with recorded
 * facts; nothing here ever signals a process.
 */
import { execFileSync } from "node:child_process";

export interface DevServerRecord {
  pid: number;
  port: number;
  /** Working directory of the runner (apps/edge). */
  cwd: string;
  state: string;
  startedAt: string;
}

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function processCommand(pid: number): string | null {
  return run("ps", ["-o", "command=", "-p", String(pid)])?.trim() || null;
}

export function processParent(pid: number): number | null {
  const parent = Number(run("ps", ["-o", "ppid=", "-p", String(pid)])?.trim());
  return Number.isInteger(parent) && parent > 1 ? parent : null;
}

/** The working directory of a process (`lsof -Fn` prints it as an `n` field). */
export function processCwd(pid: number): string | null {
  const output = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const line = output?.split("\n").find((entry) => entry.startsWith("n"));
  return line ? line.slice(1) : null;
}

export function listenerPid(port: number): number | null {
  const pid = Number(run("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"])?.split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export type RecordVerdict = { ok: true } | { ok: false; reason: string };

/** Is the recorded runner still the process we started? */
export function validateRecord(
  record: DevServerRecord,
  facts: {
    cwd: string;
    script: string;
    alive: boolean;
    command: string | null;
    processCwd: string | null;
  },
): RecordVerdict {
  if (!facts.alive) return { ok: false, reason: `PID ${record.pid} is not running` };
  if (!facts.command?.includes(facts.script)) {
    return { ok: false, reason: `PID ${record.pid} is now "${facts.command ?? "?"}"` };
  }
  if (facts.processCwd !== facts.cwd || record.cwd !== facts.cwd) {
    return { ok: false, reason: `PID ${record.pid} runs in ${facts.processCwd ?? "?"}` };
  }
  return { ok: true };
}

export interface ProcessFacts {
  pid: number;
  command: string | null;
  cwd: string | null;
  parent: number | null;
}

export type ListenerVerdict =
  | { kind: "none" }
  | { kind: "ours"; pid: number }
  | { kind: "foreign"; pid: number; command: string };

/**
 * From the process listening on the port, walk up to the wrangler process that owns it and
 * accept it only when it runs in apps/edge. (workerd listens; its parent is wrangler.)
 */
export function classifyListener(
  listener: number | null,
  edgeDir: string,
  facts: (pid: number) => ProcessFacts,
): ListenerVerdict {
  if (listener === null) return { kind: "none" };
  let pid: number | null = listener;
  for (let depth = 0; pid !== null && depth < 4; depth += 1) {
    const current = facts(pid);
    if (current.command?.includes("wrangler") && current.cwd === edgeDir) {
      return { kind: "ours", pid: current.pid };
    }
    pid = current.parent;
  }
  return { kind: "foreign", pid: listener, command: facts(listener).command ?? "unknown" };
}

export function findRepoDevServer(port: number, edgeDir: string): ListenerVerdict {
  return classifyListener(listenerPid(port), edgeDir, (pid) => ({
    pid,
    command: processCommand(pid),
    cwd: processCwd(pid),
    parent: processParent(pid),
  }));
}
