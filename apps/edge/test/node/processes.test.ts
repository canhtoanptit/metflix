/** L9: `make cf-stop` signals only a process proven to be this repository's dev server. */
import { describe, expect, it } from "vitest";
import {
  classifyListener,
  type DevServerRecord,
  type ProcessFacts,
  validateRecord,
} from "../../scripts/lib/processes.ts";

const EDGE = "/repo/apps/edge";
const record: DevServerRecord = { pid: 100, port: 8787, cwd: EDGE, state: "/s", startedAt: "" };

describe("stopping the dev server", () => {
  it("accepts the recorded runner only while it is still that runner, in apps/edge", () => {
    const facts = (overrides: Partial<Parameters<typeof validateRecord>[1]>) => ({
      cwd: EDGE,
      script: "scripts/dev.ts",
      alive: true,
      command: "node /repo/apps/edge/scripts/dev.ts start --port 8787",
      processCwd: EDGE,
      ...overrides,
    });
    expect(validateRecord(record, facts({}))).toEqual({ ok: true });
    expect(validateRecord(record, facts({ alive: false })).ok).toBe(false);
    // The PID was reused by something else after the runner died.
    expect(validateRecord(record, facts({ command: "/usr/bin/python3 -m http.server" })).ok).toBe(
      false,
    );
    expect(validateRecord(record, facts({ processCwd: "/other/project" })).ok).toBe(false);
  });

  const table = (entries: ProcessFacts[]) => (pid: number) =>
    entries.find((entry) => entry.pid === pid) ?? { pid, command: null, cwd: null, parent: null };

  it("finds the wrangler process behind workerd when it runs in apps/edge", () => {
    const facts = table([
      {
        pid: 3,
        command: "/x/workerd serve --socket-addr=entry=localhost:8787",
        cwd: EDGE,
        parent: 2,
      },
      { pid: 2, command: "node /x/wrangler/wrangler-dist/cli.js dev", cwd: EDGE, parent: 1 },
    ]);
    expect(classifyListener(3, EDGE, facts)).toEqual({ kind: "ours", pid: 2 });
  });

  it("leaves another project's wrangler and any other program alone", () => {
    const otherProject = table([
      { pid: 3, command: "/y/workerd serve", cwd: "/other/project", parent: 2 },
      {
        pid: 2,
        command: "node /y/wrangler/wrangler-dist/cli.js dev",
        cwd: "/other/project",
        parent: 1,
      },
    ]);
    expect(classifyListener(3, EDGE, otherProject)).toMatchObject({ kind: "foreign", pid: 3 });
    const python = table([
      { pid: 9, command: "python3 -m http.server 8787", cwd: EDGE, parent: 1 },
    ]);
    expect(classifyListener(9, EDGE, python)).toMatchObject({ kind: "foreign", pid: 9 });
    expect(classifyListener(null, EDGE, python)).toEqual({ kind: "none" });
  });
});
