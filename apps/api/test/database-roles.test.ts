import { ConfigError } from "@webflix/core";
import type { PostgresOptions } from "@webflix/db/postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: PostgresOptions[] = [];
vi.mock("@webflix/db/postgres", async (original) => ({
  ...(await original<typeof import("@webflix/db/postgres")>()),
  createPostgresDatabase: (options: PostgresOptions) => {
    created.push(options);
    return { dialect: "postgres", close: async () => {} };
  },
}));

const { createDatabase, DATABASE_ROLES, databaseRole } = await import("../src/adapters.ts");
const { loadApiConfig } = await import("../src/config.ts");
const { createRuntime } = await import("../src/runtime.ts");

const k8s = {
  WEBFLIX_MODE: "k8s",
  WEBFLIX_DATABASE_URL: "postgres://u:p@db:5432/webflix",
  WEBFLIX_MEDIA_TOKEN_KEYS: `k:${"a".repeat(32)}`,
};

describe("PostgreSQL budgets per process", () => {
  beforeEach(() => {
    created.length = 0;
  });

  it("gives every process its role: the API answers members, the worker runs jobs, Jobs maintain", () => {
    expect(DATABASE_ROLES).toEqual({
      api: "request",
      wait: "request",
      worker: "background",
      migrate: "maintenance",
      seed: "maintenance",
    });
    const config = loadApiConfig(k8s);
    for (const [component, role] of Object.entries(DATABASE_ROLES)) {
      createDatabase(config, databaseRole(component));
      expect(created.at(-1)).toMatchObject({ role });
    }
    // No overrides configured: the role's own budgets apply (nothing else is passed).
    expect(created.at(-1)).not.toHaveProperty("statementTimeoutMs");
    expect(created.at(-1)).not.toHaveProperty("queryTimeoutMs");
    expect(created.at(-1)).not.toHaveProperty("keepAliveInitialDelayMs");
  });

  it("refuses an unknown component at composition instead of using a default budget", () => {
    expect(() => databaseRole("scheduler")).toThrow(ConfigError);
    expect(() => databaseRole("toString")).toThrow(ConfigError);
    const config = loadApiConfig({
      WEBFLIX_DATABASE_URL: "sqlite::memory:",
      WEBFLIX_BLOB_STORE: "memory",
      WEBFLIX_MEDIA_DIR: "none",
    });
    expect(() => createRuntime(config, "replica" as never)).toThrow(/component "replica"/);
  });

  it("passes the configured overrides of the process's own role only", () => {
    const config = loadApiConfig({
      ...k8s,
      WEBFLIX_DATABASE_REQUEST_STATEMENT_TIMEOUT_MS: "3000",
      WEBFLIX_DATABASE_REQUEST_QUERY_TIMEOUT_MS: "4500",
      WEBFLIX_DATABASE_MAINTENANCE_QUERY_TIMEOUT_MS: "0",
      WEBFLIX_DATABASE_KEEPALIVE_MS: "15000",
    });
    createDatabase(config, "request");
    expect(created.at(-1)).toMatchObject({
      role: "request",
      statementTimeoutMs: 3000,
      queryTimeoutMs: 4500,
      keepAliveInitialDelayMs: 15000,
    });
    createDatabase(config, "background");
    expect(created.at(-1)).toMatchObject({ role: "background", keepAliveInitialDelayMs: 15000 });
    expect(created.at(-1)).not.toHaveProperty("statementTimeoutMs");
    createDatabase(config, "maintenance");
    expect(created.at(-1)).toMatchObject({ role: "maintenance", queryTimeoutMs: 0 });
  });
});

describe("database budget configuration", () => {
  it("rejects a client-side timeout that would cut statements the server is still running", () => {
    expect(() =>
      loadApiConfig({ ...k8s, WEBFLIX_DATABASE_REQUEST_QUERY_TIMEOUT_MS: "5000" }),
    ).toThrow(
      /WEBFLIX_DATABASE_REQUEST_QUERY_TIMEOUT_MS: 5000 must exceed the request statement timeout \(5000\)/,
    );
    expect(() =>
      loadApiConfig({ ...k8s, WEBFLIX_DATABASE_BACKGROUND_STATEMENT_TIMEOUT_MS: "90000" }),
    ).toThrow(/WEBFLIX_DATABASE_BACKGROUND_QUERY_TIMEOUT_MS: 65000 must exceed/);
    expect(() =>
      loadApiConfig({ ...k8s, WEBFLIX_DATABASE_REQUEST_STATEMENT_TIMEOUT_MS: "0" }),
    ).toThrow(/must exceed the request statement timeout \(none\), or be 0/);
  });

  it("accepts turning both off, and rejects values that are not milliseconds", () => {
    const config = loadApiConfig({
      ...k8s,
      WEBFLIX_DATABASE_REQUEST_STATEMENT_TIMEOUT_MS: "0",
      WEBFLIX_DATABASE_REQUEST_QUERY_TIMEOUT_MS: "0",
    });
    expect(config.database).toMatchObject({
      timeouts: { request: { statementTimeoutMs: 0, queryTimeoutMs: 0 } },
      keepAliveInitialDelayMs: null,
    });
    expect(() => loadApiConfig({ ...k8s, WEBFLIX_DATABASE_KEEPALIVE_MS: "-1" })).toThrow(
      ConfigError,
    );
    expect(() =>
      loadApiConfig({ ...k8s, WEBFLIX_DATABASE_SEED_STATEMENT_TIMEOUT_MS: "1" }),
    ).not.toThrow(); // not a role: ignored like any unknown variable
    expect(() =>
      loadApiConfig({ ...k8s, WEBFLIX_DATABASE_MAINTENANCE_STATEMENT_TIMEOUT_MS: "1.5" }),
    ).toThrow(/expected a whole number of milliseconds/);
  });
});
