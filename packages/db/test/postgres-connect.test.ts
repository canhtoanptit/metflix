/**
 * Connection attempts are bounded: a server that never answers (a database pod being
 * replaced, a black-holed address) fails queries after the connect timeout instead of
 * hanging them indefinitely. No PostgreSQL needed: the "server" accepts TCP and stays silent.
 */
import { createServer, type Server, type Socket } from "node:net";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresDatabase } from "../src/postgres.ts";

describe("Postgres connection attempts", () => {
  let server: Server;
  let port = 0;
  const sockets: Socket[] = [];
  beforeAll(async () => {
    server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  it("fail after the connect timeout when the server never answers", async () => {
    const database = createPostgresDatabase({
      connectionString: `postgres://webflix:webflix@127.0.0.1:${port}/webflix`,
      connectTimeoutMs: 300,
    });
    try {
      const started = Date.now();
      await expect(sql`SELECT 1`.execute(database.db)).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await database.db.destroy().catch(() => {});
    }
  });
});
