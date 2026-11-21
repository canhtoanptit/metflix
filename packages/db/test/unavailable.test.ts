/**
 * A database that cannot be reached answers `service_unavailable` (503 with `Retry-After`) on
 * every dialect, not `internal_error`; a statement's own fault stays a 500.
 */
import { API_BASE_PATH } from "@webflix/contracts";
import { AppError } from "@webflix/core";
import { MemoryBlobStore, MemoryRateLimiter } from "@webflix/core/memory";
import { createTestServices } from "@webflix/core/testing";
import { createApp } from "@webflix/http";
import { describe, expect, it } from "vitest";
import { isDatabaseUnavailable } from "../src/database.ts";
import { createPostgresDatabase } from "../src/postgres.ts";
import { createRepositories } from "../src/repositories/index.ts";
import { createSqlSearchIndex } from "../src/search.ts";
import { createSqliteDatabase } from "../src/sqlite.ts";

const coded = (code: string, message = "failed") => Object.assign(new Error(message), { code });

describe("telling an outage from a failing statement", () => {
  it.each([
    ["refused (pg, Node)", coded("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432")],
    ["reset", coded("ECONNRESET")],
    ["DNS", coded("ENOTFOUND", "getaddrinfo ENOTFOUND db")],
    ["pool timeout", new Error("timeout exceeded when trying to connect")],
    ["dropped", new Error("Connection terminated unexpectedly")],
    ["Postgres connection exception (class 08)", coded("08006")],
    [
      "Postgres shutting down",
      coded("57P01", "terminating connection due to administrator command"),
    ],
    ["Postgres starting up", coded("57P03", "the database system is starting up")],
    ["Postgres out of connections", coded("53300", "sorry, too many clients already")],
    ["SQLite file", new Error("unable to open database file")],
    ["SQLite locked", new Error("database is locked")],
    ["D1 network", new Error("D1_ERROR: Network connection lost.")],
    ["D1 overloaded", new Error("D1 DB is overloaded. Requests queued for too long.")],
    ["D1 reset", new Error("D1_ERROR: storage caused object to be reset")],
    ["wrapped", new Error("query failed", { cause: coded("ECONNREFUSED") })],
  ])("unavailable: %s", (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    ["unique violation", coded("23505", "duplicate key value violates unique constraint")],
    ["syntax", coded("42601", "syntax error at or near")],
    ["statement timeout", coded("57014", "canceling statement due to statement timeout")],
    ["SQLite constraint", new Error("UNIQUE constraint failed: accounts.email")],
    ["a bug", new TypeError("Cannot read properties of undefined")],
    ["not an error", "ECONNREFUSED"],
  ])("a statement's own fault: %s", (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
  });
});

describe("an unreachable database", () => {
  it("answers service_unavailable from repositories and the search index (Postgres refused)", async () => {
    // Nothing listens there: the connection is refused at once.
    const database = createPostgresDatabase({
      connectionString: "postgres://webflix:webflix@127.0.0.1:4947/webflix",
      connectTimeoutMs: 2_000,
    });
    try {
      const repos = createRepositories(database);
      await expect(repos.accounts.get("acc-1")).rejects.toSatisfy((error) =>
        AppError.is(error, "service_unavailable"),
      );
      await expect(repos.sessions.findActive("hash", 0)).rejects.toMatchObject({
        code: "service_unavailable",
      });
      await expect(
        createSqlSearchIndex(database).search({ text: "x", maturityCeiling: "18+", limit: 5 }),
      ).rejects.toMatchObject({ code: "service_unavailable" });
    } finally {
      await database.close();
    }
  });

  it("answers 503 with Retry-After over HTTP, and logs the cause", async () => {
    const database = createPostgresDatabase({
      connectionString: "postgres://webflix:webflix@127.0.0.1:4947/webflix",
      connectTimeoutMs: 2_000,
    });
    try {
      const t = await createTestServices({ repos: createRepositories(database), seed: false });
      const app = createApp({
        config: t.deps.config,
        services: t.services,
        blobs: new MemoryBlobStore({ clock: t.clock }),
        rateLimiter: new MemoryRateLimiter({ clock: t.clock }),
        clock: t.clock,
        ids: t.deps.ids,
        logger: t.logger,
      });
      const response = await app.request(`${API_BASE_PATH}/session`, {
        headers: { Cookie: `webflix_session=${"A".repeat(43)}` },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("5");
      expect(await response.json()).toMatchObject({ code: "service_unavailable" });
      const logged = t.logger.records.find(
        (record) => record.msg === "http.dependency_unavailable",
      );
      expect(JSON.stringify(logged)).toContain("ECONNREFUSED");
    } finally {
      await database.close();
    }
  });

  it("keeps a statement's own failure a 500 (SQLite constraint)", async () => {
    const database = createSqliteDatabase({ path: ":memory:" });
    try {
      const repos = createRepositories(database);
      // No schema: the statement fails on its own, the database is reachable.
      await expect(repos.accounts.get("acc-1")).rejects.not.toSatisfy((error) =>
        AppError.is(error),
      );
    } finally {
      await database.close();
    }
  });
});
