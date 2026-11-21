import { join } from "node:path";
import { routes } from "@webflix/contracts";
import { ConfigError } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { describeConfig, loadApiConfig, REPO_ROOT } from "../src/config.ts";

const base = { WEBFLIX_MODE: "k8s", WEBFLIX_DATABASE_URL: "postgres://u:p@db:5432/webflix" };

describe("api config", () => {
  it("needs no variables in dev mode", () => {
    const config = loadApiConfig({ WEBFLIX_MEDIA_DIR: "none" });
    expect(config.core.mode).toBe("dev");
    expect(config.port).toBe(4000);
    expect(config.database).toEqual({
      kind: "sqlite",
      path: join(REPO_ROOT, ".data", "webflix.sqlite"),
    });
    expect(config.blobs).toEqual({ kind: "fs", root: join(REPO_ROOT, ".data", "blobs") });
    expect(config).toMatchObject({
      migrateOnStart: true,
      seedOnStart: true,
      valkeyUrl: null,
      mediaDir: null,
      manifestPath: null,
      trustProxy: false,
      shutdownDelaySec: 0,
    });
  });

  it("relaxes rate limits in dev unless set explicitly", () => {
    expect(loadApiConfig({}).core.rateLimits.signup).toEqual({
      name: "signup",
      limit: 60,
      windowSec: 60,
    });
    expect(loadApiConfig({ WEBFLIX_RATE_LIMIT_SIGNUP: "3/60" }).core.rateLimits.signup).toEqual({
      name: "signup",
      limit: 3,
      windowSec: 60,
    });
    const k8s = loadApiConfig({
      WEBFLIX_MODE: "k8s",
      WEBFLIX_DATABASE_URL: "postgres://u:p@db:5432/webflix",
    });
    expect(k8s.core.rateLimits.signup.limit).toBe(5);
  });

  describe("configures every rate-limit policy the route table references", () => {
    const policies = [
      ...new Set(
        Object.values(routes as Record<string, { rateLimit?: string }>)
          .map((route) => route.rateLimit)
          .filter((policy): policy is string => policy !== undefined),
      ),
    ];
    const configurations = {
      "dev (relaxed)": {},
      k8s: { ...base, WEBFLIX_MEDIA_TOKEN_KEYS: `k:${"a".repeat(32)}` },
    };
    it.each(Object.entries(configurations))("%s", (_, env) => {
      expect(policies.length).toBeGreaterThan(0);
      const config = loadApiConfig(env);
      const limits = config.core.rateLimits as Record<string, { name: string } | undefined>;
      for (const policy of policies) expect(limits[policy]?.name, policy).toBe(policy);
    });

    // The chart turns `config.rateLimits.<policy>` into WEBFLIX_RATE_LIMIT_<POLICY> (dashes to
    // underscores, upper case): every policy must be reachable that way.
    it("can override each of them the way the chart names the variables", () => {
      const overrides = Object.fromEntries(
        policies.map((policy) => [
          `WEBFLIX_RATE_LIMIT_${policy.replaceAll("-", "_").toUpperCase()}`,
          "7/30",
        ]),
      );
      const config = loadApiConfig({ ...configurations.k8s, ...overrides });
      const limits = config.core.rateLimits as Record<string, { limit: number; windowSec: number }>;
      for (const policy of policies) {
        expect(limits[policy], policy).toMatchObject({ limit: 7, windowSec: 30 });
      }
    });
  });

  it("configures the k8s mode from the environment", () => {
    const config = loadApiConfig({
      WEBFLIX_MODE: "k8s",
      WEBFLIX_DATABASE_URL: "postgres://u:p@db:5432/webflix",
      WEBFLIX_DATABASE_POOL_MAX: "20",
      WEBFLIX_BLOB_STORE: "s3",
      WEBFLIX_S3_ENDPOINT: "http://minio:9000",
      WEBFLIX_S3_BUCKET: "media",
      PORT: "8080",
    });
    expect(config.database).toEqual({
      kind: "postgres",
      url: "postgres://u:p@db:5432/webflix",
      maxConnections: 20,
    });
    expect(config.blobs).toMatchObject({
      kind: "s3",
      endpoint: "http://minio:9000",
      bucket: "media",
    });
    expect(config).toMatchObject({
      port: 8080,
      migrateOnStart: false,
      seedOnStart: false,
      trustProxy: true,
      shutdownDelaySec: 5,
    });
  });

  it("configures Valkey, proxy hops and a manifest in the blob store", () => {
    const config = loadApiConfig({
      WEBFLIX_MODE: "k8s",
      WEBFLIX_DATABASE_URL: "postgres://u@db:5432/webflix",
      WEBFLIX_VALKEY_URL: "rediss://valkey.internal:6380/0",
      WEBFLIX_VALKEY_PASSWORD: "from-a-secret",
      WEBFLIX_TRUSTED_PROXY_HOPS: "2",
      WEBFLIX_MEDIA_MANIFEST: "blob:manifests/media.json",
    });
    expect(config).toMatchObject({
      valkeyUrl: "rediss://valkey.internal:6380/0",
      valkeyPassword: "from-a-secret",
      valkeyKeyPrefix: "webflix:",
      trustProxy: true,
      trustedProxyHops: 2,
      manifestPath: "blob:manifests/media.json",
      jobsConcurrency: 4,
    });
    expect(describeConfig(config)).toMatchObject({
      sharedState: "valkey:rediss://valkey.internal:6380/0",
    });
    expect(
      JSON.stringify(
        describeConfig(loadApiConfig({ ...base, WEBFLIX_VALKEY_URL: "redis://:s3cret@v:6379" })),
      ),
    ).not.toContain("s3cret");
    expect(() => loadApiConfig({ ...base, WEBFLIX_VALKEY_URL: "http://valkey:6379" })).toThrow(
      /redis:\/\//,
    );
  });

  it("moves ops endpoints to their own port when asked", () => {
    expect(loadApiConfig({ ...base }).opsPort).toBeNull();
    expect(loadApiConfig({ ...base, WEBFLIX_OPS_PORT: "4001" }).opsPort).toBe(4001);
    expect(() => loadApiConfig({ ...base, PORT: "4001", WEBFLIX_OPS_PORT: "4001" })).toThrow(
      /must differ from PORT/,
    );
  });

  it("reports every problem at once", () => {
    expect(() => loadApiConfig({ WEBFLIX_MODE: "k8s" })).toThrow(ConfigError);
    expect(() => loadApiConfig({ WEBFLIX_DATABASE_URL: "mysql://nope" })).toThrow(/postgres:\/\//);
    expect(() => loadApiConfig({ WEBFLIX_MODE: "cloudflare" })).toThrow(/apps\/edge/);
    expect(() => loadApiConfig({ PORT: "not-a-port" })).toThrow(ConfigError);
    expect(() =>
      loadApiConfig({ WEBFLIX_ENV: "production", WEBFLIX_DATABASE_URL: "sqlite::memory:" }),
    ).toThrow(/WEBFLIX_MEDIA_TOKEN_KEYS/);
  });
});
