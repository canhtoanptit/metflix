import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientIp } from "../src/runtime.ts";

async function seen(hops: number, forwardedFor?: string): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.text(clientIp(c, hops)));
  const response = await app.request("/", {
    headers: forwardedFor === undefined ? {} : { "X-Forwarded-For": forwardedFor },
  });
  return response.text();
}

describe("client IP behind trusted proxies", () => {
  it("takes the address the gateway appended, never a client-supplied hop", async () => {
    expect(await seen(1, "203.0.113.7")).toBe("203.0.113.7");
    // A client sending its own X-Forwarded-For cannot choose its rate-limit bucket.
    expect(await seen(1, "6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
    // A load balancer in front of the gateway appends one more hop.
    expect(await seen(2, "6.6.6.6, 203.0.113.7, 10.0.0.5")).toBe("203.0.113.7");
  });

  it("falls back sensibly when the chain is shorter than the configured hops", async () => {
    expect(await seen(2, "203.0.113.7")).toBe("203.0.113.7");
    expect(await seen(1, " , ")).toBe("unknown");
  });

  it("ignores X-Forwarded-For entirely when no proxy is trusted", async () => {
    expect(await seen(0, "6.6.6.6")).toBe("unknown");
  });
});
