import { describe, expect, it } from "vitest";
import { fail } from "../src/expect.ts";
import { parseCli } from "../src/options.ts";
import { matchesPattern, runChecks, selectChecks } from "../src/runner.ts";
import type { CheckDefinition, SmokeOptions } from "../src/types.ts";

function options(extra: string[] = []): SmokeOptions {
  return parseCli(["-u", "http://127.0.0.1:9", "--timeout", "1000", ...extra], {}).options;
}

const checks: CheckDefinition[] = [
  { id: "a.pass", area: "ops", title: "passes", run: async () => {} },
  {
    id: "a.fail",
    area: "ops",
    title: "fails",
    run: async () => fail("nope", { expected: "x", observed: "y" }),
  },
  { id: "a.skip", area: "ops", title: "skips", run: async (ctx) => ctx.skip("not supported here") },
  {
    id: "a.needs",
    area: "ops",
    title: "unmet requirement",
    needs: [{ id: "thing", evaluate: async () => "the target has no thing" }],
    run: async () => {
      throw new Error("must not run");
    },
  },
  { id: "b.throws", area: "identity", title: "unexpected error", run: async () => JSON.parse("{") },
  {
    id: "b.hangs",
    area: "identity",
    title: "times out",
    timeoutMs: 50,
    run: (ctx) => ctx.sleep(10_000),
  },
  {
    id: "b.eventually",
    area: "identity",
    title: "polls until done",
    run: async (ctx) => {
      let n = 0;
      const result = await ctx.eventually(
        "n reaches 3",
        async () => (++n >= 3 ? { done: true, value: n } : { done: false, observed: `n=${n}` }),
        { intervalMs: 1 },
      );
      ctx.note(`attempts ${result.attempts}`);
    },
  },
  {
    id: "b.never",
    area: "identity",
    title: "never observed",
    run: async (ctx) => {
      await ctx.eventually("never", async () => ({ done: false, observed: "still no" }), {
        timeoutMs: 30,
        intervalMs: 5,
      });
    },
  },
];

describe("selection", () => {
  it("matches ids, prefixes and globs", () => {
    expect(matchesPattern("identity.signup", "identity")).toBe(true);
    expect(matchesPattern("identity.signup", "identity.sign")).toBe(false);
    expect(matchesPattern("identity.signup.declined-cards", "identity.signup")).toBe(true);
    expect(matchesPattern("media.range-requests", "*range*")).toBe(true);
    expect(matchesPattern("media.range-requests", "media.*")).toBe(true);
  });

  it("filters by --only, --skip and --tag", () => {
    const tagged: CheckDefinition[] = [
      { id: "x.one", area: "ops", title: "", tags: ["consistency"], run: async () => {} },
      { id: "x.two", area: "ops", title: "", run: async () => {} },
    ];
    expect(selectChecks(tagged, options(["--tag", "consistency"])).map((c) => c.id)).toEqual([
      "x.one",
    ]);
    expect(selectChecks(tagged, options(["--skip", "x.one"])).map((c) => c.id)).toEqual(["x.two"]);
    expect(selectChecks(checks, options(["--only", "b"])).every((c) => c.id.startsWith("b."))).toBe(
      true,
    );
  });
});

describe("runner", () => {
  it("reports every outcome distinctly; a skip is never a pass", async () => {
    const report = await runChecks(checks, options(["--expect-fail", "b.throws"]));
    const byId = Object.fromEntries(report.results.map((result) => [result.id, result]));
    expect(byId["a.pass"]?.outcome).toBe("pass");
    expect(byId["a.fail"]?.outcome).toBe("fail");
    expect(byId["a.fail"]?.failure).toMatchObject({
      message: "nope",
      expected: "x",
      observed: "y",
    });
    expect(byId["a.skip"]).toMatchObject({ outcome: "skip", reason: "not supported here" });
    expect(byId["a.needs"]).toMatchObject({ outcome: "skip", reason: "the target has no thing" });
    expect(byId["b.throws"]?.outcome).toBe("xfail");
    expect(byId["b.hangs"]?.outcome).toBe("fail");
    expect(byId["b.hangs"]?.failure?.message).toMatch(/timed out/);
    expect(byId["b.eventually"]?.outcome).toBe("pass");
    expect(byId["b.eventually"]?.notes).toEqual(["attempts 3"]);
    expect(byId["b.never"]?.failure?.message).toBe("never observed: never");
    expect(byId["b.never"]?.failure?.observed).toMatch(/still no/);
    expect(report.counts).toMatchObject({ pass: 2, fail: 3, skip: 2, xfail: 1, total: 8 });
    expect(report.ok).toBe(false);
  });

  it("marks an expected failure that passes as XPASS, and --fail-on-skip fails skips", async () => {
    const passing = checks.filter((check) => check.id === "a.pass" || check.id === "a.skip");
    const report = await runChecks(passing, options(["--expect-fail", "a.pass", "--fail-on-skip"]));
    expect(report.results.map((result) => result.outcome)).toEqual(["xpass", "skip"]);
    expect(report.ok).toBe(false);
  });

  it("runs exclusive checks after all others, one at a time", async () => {
    const order: string[] = [];
    const make = (id: string, exclusive: boolean): CheckDefinition => ({
      id,
      area: "ops",
      title: id,
      ...(exclusive ? { tags: ["exclusive" as const] } : {}),
      run: async (ctx) => {
        order.push(`start ${id}`);
        await ctx.sleep(10);
        order.push(`end ${id}`);
      },
    });
    await runChecks(
      [make("e.one", true), make("o.one", false), make("e.two", true), make("o.two", false)],
      options(),
    );
    expect(order.slice(-4)).toEqual(["start e.one", "end e.one", "start e.two", "end e.two"]);
  });
});
