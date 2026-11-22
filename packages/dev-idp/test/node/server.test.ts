/**
 * Node only: the issuer on a real port over real HTTP (ports 5450-5499, as this machine's rules
 * assign), and a scan proving the portable code uses no Node API.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { webflixRealms } from "../../src/index.ts";
import {
  type DevIdpServer,
  type RunningServer,
  serveFetchHandler,
  startDevIdpHostServer,
  startDevIdpServer,
} from "../../src/node/index.ts";
import { completeAuthorization, TEST_CLIENTS, TEST_REDIRECT_URI } from "../../src/testing/index.ts";
import { IndependentRp, signInWith, UserAgent } from "../support/independent-rp.ts";

const running: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

// Never reuse a port within a run: fetch keeps sockets to a closed server alive in its pool, and
// reusing one against a new server on the same port fails with ECONNRESET.
let nextPort = 5450;

async function onFreePort<T extends RunningServer>(
  start: (port: number) => Promise<T>,
): Promise<T> {
  for (; nextPort <= 5499; nextPort += 1) {
    const port = nextPort;
    try {
      const server = await start(port);
      nextPort += 1;
      running.push(server);
      return server;
    } catch (error) {
      if ((error as { code?: string }).code !== "EADDRINUSE") {
        nextPort += 1;
        throw error;
      }
    }
  }
  throw new Error("No free port in 5450-5499");
}

const httpFetch = (request: Request) => fetch(request);

describe("startDevIdpServer", () => {
  it("serves a full sign-in over real HTTP to an independent client", async () => {
    const server = await onFreePort((port) =>
      startDevIdpServer({ port, environment: "test", clients: [...TEST_CLIENTS] }),
    );
    expect(server.issuer).toBe(`http://127.0.0.1:${server.port}`);
    const rp = new IndependentRp({
      issuer: server.issuer,
      clientId: "confidential-basic",
      redirectUri: TEST_REDIRECT_URI,
      auth: { method: "client_secret_basic", secret: "confidential-basic-secret" },
      fetch: httpFetch,
    });
    const result = await signInWith(
      rp,
      new UserAgent(httpFetch),
      { persona: "new-member" },
      {
        scope: "openid email profile offline_access",
      },
    );
    expect(result.idClaims.iss).toBe(server.issuer);
    expect((await rp.userinfo(result.accessToken, String(result.idClaims.sub))).email).toBe(
      "riley.chen@example.com",
    );
    expect(
      (await rp.refresh(result.refreshToken ?? "", result.idClaims)).refreshToken,
    ).toBeTruthy();
  });

  it("serves the test kit's driver, Set-Cookie headers and all", async () => {
    const server: DevIdpServer = await onFreePort((port) =>
      startDevIdpServer({
        port,
        environment: "test",
        clients: [...TEST_CLIENTS],
        path: "/realms/staff",
        profile: "keycloak",
      }),
    );
    const url = new URL(`${server.issuer}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "public-spa",
      redirect_uri: TEST_REDIRECT_URI,
      scope: "openid",
      state: "s",
      nonce: "n",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    }).toString();
    const outcome = await completeAuthorization(
      url,
      { persona: "staff-admin" },
      { fetch: httpFetch },
    );
    expect(outcome.code).toBeTruthy();
    expect(outcome.iss).toBe(server.issuer);
  });

  it("never trusts the Host header, and bounds request bodies", async () => {
    const server = await onFreePort((port) =>
      startDevIdpServer({ port, environment: "test", clients: [...TEST_CLIENTS] }),
    );
    const { request } = await import("node:http");
    const status = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/.well-known/openid-configuration",
          headers: { Host: "evil.test" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += String(chunk);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status.status).toBe(200);
    expect((JSON.parse(status.body) as { issuer: string }).issuer).toBe(server.issuer);
    const big = await fetch(`${server.issuer}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "x".repeat(2 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
  });

  it("refuses to start in production, and releases the port", async () => {
    await expect(
      onFreePort((port) =>
        startDevIdpServer({ port, environment: "production", clients: [...TEST_CLIENTS] }),
      ),
    ).rejects.toThrow(/refuses to start/);
  });

  it("reports a port in use", async () => {
    const first = await onFreePort((port) =>
      serveFetchHandler(async () => new Response("x"), { port }),
    );
    await expect(
      serveFetchHandler(async () => new Response("y"), { port: first.port }),
    ).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });
});

describe("startDevIdpHostServer", () => {
  it("serves the Webflix realms on a port", async () => {
    const server = await onFreePort((port) =>
      startDevIdpHostServer({
        port,
        environment: "development",
        realms: webflixRealms({ appOrigins: ["http://localhost:5173"] }),
      }),
    );
    const doc = (await (
      await fetch(`${server.origin}/dev-idp/staff/.well-known/openid-configuration`)
    ).json()) as {
      issuer: string;
    };
    expect(doc.issuer).toBe(`${server.origin}/dev-idp/staff`);
  });
});

describe("portability", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
  }
  const root = join(import.meta.dirname, "..", "..");
  const portable = [...files(join(root, "src")), ...files(join(root, "test"))].filter(
    (path) => !path.includes(`${join("src", "node")}`) && !path.includes(`${join("test", "node")}`),
  );

  it("the runtime code, the kit and the shared suite use Web-standard APIs only", () => {
    expect(portable.length).toBeGreaterThan(20);
    for (const path of portable) {
      const source = readFileSync(path, "utf8");
      for (const forbidden of [
        /from "node:/,
        /\bprocess\./,
        /\bBuffer\b/,
        /\brequire\(/,
        /__dirname/,
        /import\.meta\.dirname/,
      ]) {
        expect(source, `${path} uses ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("has no runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: object;
    };
    expect(manifest.dependencies).toBeUndefined();
  });
});
