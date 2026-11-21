/** L8: production is reachable on exactly one hostname, derived from WEBFLIX_PUBLIC_ORIGIN. */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { routingForOrigin, writeProductionRouting } from "../../scripts/lib/config.ts";
import { WRANGLER_CONFIG } from "../../scripts/lib/platform.ts";

const temp = await mkdtemp(join(tmpdir(), "webflix-routing-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

describe("production routing from the public origin", () => {
  it("ships with workers.dev off and refuses the placeholder origin", () => {
    const production = unstable_readConfig(
      { config: WRANGLER_CONFIG, env: "production" },
      { hideWarnings: true },
    );
    expect(production.workers_dev).toBe(false);
    const routing = routingForOrigin(String(production.vars.WEBFLIX_PUBLIC_ORIGIN));
    expect(routing.ok).toBe(false);
  });

  it("serves a custom domain only, with workers.dev off", () => {
    expect(routingForOrigin("https://watch.webflix.tv")).toEqual({
      ok: true,
      host: "watch.webflix.tv",
      workersDev: false,
      routes: [{ pattern: "watch.webflix.tv", custom_domain: true }],
    });
  });

  it("uses workers.dev only when that is the declared origin (first deploy without a domain)", () => {
    expect(routingForOrigin("https://webflix.team.workers.dev")).toMatchObject({
      ok: true,
      workersDev: true,
      routes: [],
    });
  });

  it("rejects origins that cannot be the production origin", () => {
    for (const origin of [
      "http://watch.webflix.tv",
      "https://watch.webflix.tv:8443",
      "https://watch.webflix.tv/app",
      "not a url",
    ]) {
      expect(routingForOrigin(origin).ok, origin).toBe(false);
    }
  });

  it("writes workers_dev and routes into env.production, idempotently", async () => {
    const copy = join(temp, "wrangler.jsonc");
    await copyFile(WRANGLER_CONFIG, copy);
    const routing = routingForOrigin("https://watch.webflix.tv");
    if (!routing.ok) throw new Error(routing.reason);
    expect(await writeProductionRouting(copy, routing)).toBe(true);
    const production = unstable_readConfig(
      { config: copy, env: "production" },
      { hideWarnings: true },
    );
    expect(production.workers_dev).toBe(false);
    expect(production.routes).toEqual([{ pattern: "watch.webflix.tv", custom_domain: true }]);
    expect(await writeProductionRouting(copy, routing)).toBe(false);
    const dev = routingForOrigin("https://webflix.team.workers.dev");
    if (!dev.ok) throw new Error(dev.reason);
    expect(await writeProductionRouting(copy, dev)).toBe(true);
    const after = unstable_readConfig({ config: copy, env: "production" }, { hideWarnings: true });
    expect(after.workers_dev).toBe(true);
    expect(after.routes ?? []).toEqual([]);
  });
});
