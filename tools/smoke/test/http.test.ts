import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rejects, succeeds } from "../src/expect.ts";
import { Agent, capture, exchangeOf } from "../src/http.ts";

let server: Server;
let base = "";
let limitedOnce = false;

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "Content-Type": status >= 400 ? "application/problem+json" : "application/json",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const id = req.headers["x-request-id"];
  if (url.pathname === "/api/v1/session") {
    const signedIn = (req.headers.cookie ?? "").includes("webflix_session=");
    json(res, 200, signedIn ? { authenticated: false } : { authenticated: false });
    return;
  }
  if (url.pathname === "/api/v1/auth/logout") {
    res.writeHead(204, {
      "Set-Cookie": "webflix_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    });
    res.end();
    return;
  }
  if (url.pathname === "/api/v1/plans") {
    // Drifted contract: plans without the required fields.
    json(res, 200, { items: [{ id: "basic" }] });
    return;
  }
  if (url.pathname === "/api/v1/account") {
    json(res, 401, {
      type: "urn:webflix:problem:unauthenticated",
      title: "Sign in required",
      status: 401,
      code: "unauthenticated",
      requestId: id,
    });
    return;
  }
  if (url.pathname === "/limited") {
    if (!limitedOnce) {
      limitedOnce = true;
      json(
        res,
        429,
        {
          type: "t",
          title: "Too many requests",
          status: 429,
          code: "rate_limited",
          retryAfterSec: 1,
        },
        { "Retry-After": "1" },
      );
      return;
    }
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/set") {
    res.writeHead(200, {
      "Set-Cookie": ["webflix_session=tok; Path=/; HttpOnly; SameSite=Lax", "other=1; Path=/"],
    });
    res.end("ok");
    return;
  }
  if (url.pathname === "/echo-cookie") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(req.headers.cookie ?? "");
    return;
  }
  if (url.pathname === "/redirect-local") {
    res.writeHead(302, { Location: "/echo-cookie" });
    res.end();
    return;
  }
  if (url.pathname === "/redirect-away") {
    res.writeHead(302, { Location: "https://example.invalid/x" });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
}

beforeAll(async () => {
  server = createServer(handle);
  // An OS-assigned ephemeral port on loopback: exists only for this test file.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function agent(retry = true) {
  return new Agent({
    baseUrl: base,
    label: "test",
    runId: "t",
    requestTimeoutMs: 2000,
    retryOn429: retry,
  });
}

describe("Agent", () => {
  it("keeps cookies like a browser and expires them on sign-out", async () => {
    const a = agent();
    await a.fetch("/set");
    expect((await a.fetch("/echo-cookie")).text()).toBe("webflix_session=tok; other=1");
    await a.api.logout();
    expect(a.jar.names()).toEqual(["other"]);
  });

  it("sends the CSRF header on mutations and a request id on everything", async () => {
    const a = agent();
    const result = await capture(() => a.api.logout());
    expect(result.exchanges[0]?.requestHeaders["x-webflix-client"]).toBe("web");
    expect(result.exchanges[0]?.requestId).toMatch(/^smk-t-\d+$/);
  });

  it("follows same-origin redirects only", async () => {
    const a = agent();
    expect((await a.fetch("/redirect-local")).status).toBe(200);
    expect((await a.fetch("/redirect-away")).status).toBe(302);
    await expect(a.fetch("https://example.invalid/hls.m3u8")).rejects.toThrow(/third-party/);
  });

  it("waits out rate_limited answers unless told not to", async () => {
    limitedOnce = false;
    const started = Date.now();
    const result = await agent().fetch("/limited");
    expect(result.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    limitedOnce = false;
    expect((await agent(false).fetch("/limited")).status).toBe(429);
  });

  it("attaches the exchange to typed-client errors and reports contract drift", async () => {
    const a = agent();
    const error = await rejects(() => a.api.getAccount(), "unauthenticated", "GET /account");
    expect(exchangeOf(error)?.url).toBe("/api/v1/account");
    await expect(succeeds(() => a.api.listPlans(), "GET /plans")).rejects.toMatchObject({
      message: expect.stringMatching(/does not match the contract/),
      details: expect.arrayContaining([expect.stringMatching(/^contract: items\.0\./)]),
    });
  });
});
