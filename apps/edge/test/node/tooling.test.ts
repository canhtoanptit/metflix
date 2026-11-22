/**
 * The parts of the production path that can be checked without a Cloudflare account: the
 * resource-id write-back, the bindings-only configs the tooling hands to getPlatformProxy, and
 * parsing Wrangler's output.
 */
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { writeProductionIds } from "../../scripts/lib/config.ts";
import { derivedConfig, WRANGLER_CONFIG } from "../../scripts/lib/platform.ts";
import { parseJsonOutput } from "../../scripts/lib/wrangler.ts";

const temp = await mkdtemp(join(tmpdir(), "webflix-edge-test-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

describe("provisioning write-back", () => {
  it("writes the D1 and KV ids into env.production only, keeping every comment", async () => {
    const copy = join(temp, "wrangler.jsonc");
    await copyFile(WRANGLER_CONFIG, copy);
    const before = await readFile(copy, "utf8");
    const ids = {
      databaseId: "6f1c5a9e-0000-4000-8000-1234567890ab",
      kv: { CACHE: "a".repeat(32), RECS: "b".repeat(32) },
    };
    expect(await writeProductionIds(copy, ids)).toBe(true);
    const after = await readFile(copy, "utf8");
    const comments = (text: string) =>
      text.split("\n").filter((line) => line.trim().startsWith("//"));
    expect(comments(after)).toEqual(comments(before));

    // wrangler.jsonc resolves paths relative to itself; read a copy that sits in the app dir.
    const production = unstable_readConfig(
      { config: copy, env: "production" },
      { hideWarnings: true },
    );
    expect(production.d1_databases[0]?.database_id).toBe(ids.databaseId);
    const kv = (binding: string) =>
      production.kv_namespaces.find((namespace) => namespace.binding === binding)?.id;
    expect(kv("CACHE")).toBe(ids.kv.CACHE);
    expect(kv("RECS")).toBe(ids.kv.RECS);
    const local = unstable_readConfig({ config: copy }, { hideWarnings: true });
    expect(local.d1_databases[0]?.database_id).toBe("webflix-local");
    // Idempotent: a second run with the same ids changes nothing.
    expect(await writeProductionIds(copy, ids)).toBe(false);
  });
});

describe("bindings for the tooling", () => {
  it("keeps local ids for local runs and marks every production binding remote", async () => {
    const local = JSON.parse(await readFile(await derivedConfig("local"), "utf8"));
    expect(local.d1_databases).toEqual([
      { binding: "DB", database_name: "webflix", database_id: "webflix-local" },
    ]);
    expect(local.durable_objects).toBeUndefined();
    expect(local.queues).toBeUndefined();

    const production = JSON.parse(await readFile(await derivedConfig("production"), "utf8"));
    for (const binding of [
      ...production.d1_databases,
      ...production.kv_namespaces,
      ...production.r2_buckets,
    ]) {
      expect(binding.remote).toBe(true);
    }
    expect(production.vars.WEBFLIX_ENV).toBe("production");
    // Production secrets never reach a file on disk.
    expect(production.vars.WEBFLIX_MEDIA_TOKEN_KEYS).toBeUndefined();
  });
});

describe("wrangler output", () => {
  it("finds the JSON after any banner", () => {
    expect(parseJsonOutput<{ id: string }[]>(' ⛅️ wrangler\n──\n[{"id":"x"}]\n')).toEqual([
      { id: "x" },
    ]);
    expect(() => parseJsonOutput("no json here")).toThrow();
  });
});
