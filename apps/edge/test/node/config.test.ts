/**
 * wrangler.jsonc against the code that runs under it. Each assertion is a mistake that would
 * otherwise only show up on a real account (or not at all until it hurts).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouteSpec } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { type Env, JOBS_MAX_ATTEMPTS, loadEdgeConfig } from "../../src/env.ts";

const EDGE = join(import.meta.dirname, "..", "..");
const CONFIG = join(EDGE, "wrangler.jsonc");
const read = (env?: string) =>
  unstable_readConfig({ config: CONFIG, ...(env ? { env } : {}) }, { hideWarnings: true });
const local = read();
const production = read("production");

/** Valid-looking values for every secret either environment may require (never real ones). */
const SECRET_STUBS: Record<string, string> = {
  WEBFLIX_MEDIA_TOKEN_KEYS: `test:${"k".repeat(40)}`,
  WEBFLIX_PSEUDONYM_KEY: "p".repeat(43),
  WEBFLIX_EMAIL_HTTP_API_KEY: `re_${"e".repeat(30)}`,
  WEBFLIX_EMAIL_WEBHOOK_SECRET: `whsec_${"w".repeat(32)}`,
  STRIPE_SECRET_KEY: `sk_live_${"s".repeat(24)}`,
  STRIPE_PUBLISHABLE_KEY: `pk_live_${"s".repeat(24)}`,
  STRIPE_WEBHOOK_SECRET: `whsec_${"h".repeat(32)}`,
};

/**
 * The Worker's validated config for an environment's vars plus exactly the secrets the
 * environment declares as required (stubbed): production must compose with nothing else.
 * Locally the provider credentials are empty, as `make cf-dev` writes them to .dev.vars.
 */
function composed(config: typeof local, overrides: Record<string, string> = {}) {
  const secrets = Object.fromEntries(
    (config.secrets?.required ?? []).map((name) => [
      name,
      config === local && !GENERATED.has(name) ? "" : (SECRET_STUBS[name] ?? "stub"),
    ]),
  );
  return loadEdgeConfig({
    ...(config.vars as Record<string, string>),
    ...secrets,
    ...overrides,
  } as unknown as Env);
}
const GENERATED = new Set(["WEBFLIX_MEDIA_TOKEN_KEYS", "WEBFLIX_PSEUDONYM_KEY"]);

describe("wrangler.jsonc", () => {
  it("sends every server-owned path to the Worker before the asset layer", async () => {
    // The same prefixes the web app's dev server proxies to the API (apps/web/vite.config.ts).
    const vite = await readFile(join(EDGE, "..", "web", "vite.config.ts"), "utf8");
    // Prefixes may hold "-" and "_" (milestone 2's /dev-idp and /_pay).
    const proxied = /\[((?:\s*"\/[a-z_-]+",?\s*)+)\]\.map/.exec(vite)?.[1]?.match(/"\/[a-z_-]+"/g);
    expect(proxied?.length).toBeGreaterThan(0);
    const first = production.assets?.run_worker_first;
    expect(Array.isArray(first)).toBe(true);
    for (const prefix of proxied ?? []) {
      const path = JSON.parse(prefix) as string;
      expect(
        (first as string[]).some((rule) => rule === path || rule === `${path}/*`),
        path,
      ).toBe(true);
    }
    // Production restates the asset routing (it only changes the staging directory).
    expect({ ...production.assets, directory: undefined }).toEqual({
      ...local.assets,
      directory: undefined,
    });
  });

  it("dead-letters after exactly the attempts the consumer logs as final", () => {
    for (const config of [local, production]) {
      const consumer = config.queues.consumers?.[0];
      expect(consumer?.max_retries).toBe(JOBS_MAX_ATTEMPTS - 1);
      expect(consumer?.dead_letter_queue).toBeTruthy();
      expect(config.queues.producers?.[0]?.queue).toBe(consumer?.queue);
    }
  });

  it("restates every binding in production under the same names", () => {
    const names = (config: typeof local) => ({
      d1: config.d1_databases.map((db) => [db.binding, db.migrations_dir]),
      kv: config.kv_namespaces.map((kv) => kv.binding),
      r2: config.r2_buckets.map((r2) => [r2.binding, r2.bucket_name]),
      durableObjects: config.durable_objects.bindings.map((binding) => [
        binding.name,
        binding.class_name,
      ]),
      queues: config.queues.producers?.map((producer) => [producer.binding, producer.queue]),
      vars: Object.keys(config.vars)
        .filter((name) => !name.startsWith("WEBFLIX_RATE_LIMIT_"))
        .sort(),
    });
    expect(names(production)).toEqual(names(local));
  });

  it("relaxes rate limits only for local development, exactly as the Node dev mode does", async () => {
    const { DEFAULT_RATE_LIMITS } = await import("@webflix/core");
    // Production lists the keys (vars are not inherited) but leaves them empty: no override.
    for (const [name, value] of Object.entries(production.vars)) {
      if (name.startsWith("WEBFLIX_RATE_LIMIT_")) expect(value, name).toBe("");
    }
    expect(composed(production).core.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
    // Local = the Node dev mode's profile, computed by apps/api itself.
    const { loadApiConfig } = await import("../../../api/src/config.ts");
    const dev = loadApiConfig({ WEBFLIX_MODE: "dev" });
    expect(composed(local).core.rateLimits).toEqual(dev.core.rateLimits);
  });

  it("resolves every rate-limit policy the route table names, locally and in production", async () => {
    const { routes } = await import("@webflix/contracts");
    const limited = (Object.values(routes) as RouteSpec[]).filter((route) => route.rateLimit);
    expect(limited.length).toBeGreaterThan(5);
    for (const config of [local, production]) {
      const { rateLimits } = composed(config).core;
      for (const route of limited) {
        const name = route.rateLimit as string;
        expect(
          rateLimits[name as keyof typeof rateLimits]?.name,
          `${route.method} ${route.path}`,
        ).toBe(name);
      }
    }
  });

  it("declares the Durable Object classes and media origin the Worker exports", async () => {
    const source = await readFile(join(EDGE, "src", "index.ts"), "utf8");
    const raw = await readFile(CONFIG, "utf8");
    for (const name of ["RateLimiterObject", "StreamGateObject", "MediaOrigin"]) {
      expect(source, name).toMatch(new RegExp(`\\b${name}\\b`));
      expect(raw, name).toContain(`"${name}"`);
    }
  });

  it("keeps production strict: real token keys required, development defaults off", () => {
    expect(production.vars.WEBFLIX_ENV).toBe("production");
    expect(String(production.vars.WEBFLIX_PUBLIC_ORIGIN)).toMatch(/^https:\/\//);
    expect(production.secrets?.required).toContain("WEBFLIX_MEDIA_TOKEN_KEYS");
    expect(production.compatibility_flags).not.toContain("nodejs_compat");
    expect(local.compatibility_flags).not.toContain("nodejs_compat");
  });

  it("declares the same secrets in both sections (secrets are not inherited)", async () => {
    expect([...(production.secrets?.required ?? [])].sort()).toEqual(
      [...(local.secrets?.required ?? [])].sort(),
    );
    // Every generated secret is one the tooling knows how to create, locally and on deploy.
    const { GENERATED_SECRETS } = await import("../../scripts/lib/secrets.ts");
    expect(Object.keys(GENERATED_SECRETS).sort()).toEqual([...GENERATED].sort());
    for (const name of GENERATED) expect(local.secrets?.required).toContain(name);
  });

  it("composes production with exactly its required secrets, into the durable adapters", () => {
    const config = composed(production).core;
    expect(config.events.eventSink).toBe("lake");
    expect(config.events.serverRelease).toBe("dev"); // replaced at deploy (--var)
    expect(config.identity.emailSender).toBe("http");
    expect(config.identity.emailHttp?.webhookSecret).toBeTruthy();
    expect(config.billing.paymentProvider).toBe("stripe");
    expect(config.billing.stripe?.publishableKey).toMatch(/^pk_live_/);
    expect(config.personalisation.recommendationStore).toBe("kv");
    // The staff API stays closed until an issuer is configured (intended).
    expect(config.admin.staffVerifier).toBe("memory");
    // A missing provider credential would answer 503 to everything: deploy must refuse first.
    for (const name of ["STRIPE_SECRET_KEY", "WEBFLIX_EMAIL_HTTP_API_KEY"]) {
      expect(() => composed(production, { [name]: "" }), name).toThrow();
    }
    // The development pseudonym key is refused once events are stored.
    expect(() => composed(production, { WEBFLIX_PSEUDONYM_KEY: "" })).toThrow(/PSEUDONYM/);
  });

  it("composes the local Worker on bindings only: lake, D1 outbox, fake provider, dev issuer", () => {
    const config = composed(local).core;
    expect(config.events.eventSink).toBe("lake");
    expect(config.events.serverRelease).toBe("local");
    expect(config.identity.emailSender).toBe("outbox");
    expect(config.billing.paymentProvider).toBe("fake");
    expect(config.billing.stripe).toBeNull();
    expect(config.admin.staffVerifier).toBe("oidc");
    expect(config.admin.staffIssuer).toBeNull();
    expect(config.personalisation.recommendationStore).toBe("kv");
  });

  it("uses a compatibility date the pinned runtime supports", async () => {
    // workerd versions are 1.YYYYMMDD.patch: the date is the newest compatibility date it knows.
    const wrangler = JSON.parse(
      await readFile(join(EDGE, "node_modules", "wrangler", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const runtimeDate = /^1\.(\d{8})\./.exec(wrangler.dependencies?.workerd ?? "")?.[1];
    expect(runtimeDate).toBeDefined();
    const supported = `${runtimeDate?.slice(0, 4)}-${runtimeDate?.slice(4, 6)}-${runtimeDate?.slice(6, 8)}`;
    expect((local.compatibility_date ?? "") <= supported).toBe(true);
    expect(production.compatibility_date).toBe(local.compatibility_date);
  });
});

describe("static assets routing", () => {
  it("lets the Worker answer asset misses (no SPA fallback in the asset layer)", () => {
    // The asset layer's SPA mode answers a missing /assets/x.js with index.html under the
    // immutable `/assets/*` headers; src/spa.ts answers it with a 404 nobody caches.
    expect(local.assets?.not_found_handling).toBe("none");
    expect(production.assets?.not_found_handling).toBe("none");
  });

  it("runs the Worker first for exactly the server paths src/spa.ts treats as server paths", async () => {
    const { SERVER_PATHS } = await import("../../src/spa.ts");
    const rules = (production.assets?.run_worker_first ?? []) as string[];
    const first = rules.filter((rule) => !rule.startsWith("!"));
    expect([...first].sort()).toEqual([...SERVER_PATHS].sort());
  });
});

describe("observability", () => {
  it("keeps media tokens out of platform logs: no invocation logs, no traces", () => {
    // Both record the full request URL; tokens live in /media/{token}/... paths.
    for (const config of [local, production]) {
      expect(config.observability?.logs?.invocation_logs).toBe(false);
      expect(config.observability?.traces?.enabled).toBe(false);
      expect(config.observability?.logs?.enabled).toBe(true);
    }
  });
});
