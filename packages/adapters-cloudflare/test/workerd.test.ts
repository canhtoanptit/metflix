/**
 * Runs inside workerd. Proves the core ports, their contract suites, the portable
 * implementations and the API client work on the Workers runtime, not only on Node.
 */
import { env } from "cloudflare:workers";
import { createRouteClient, routes } from "@webflix/contracts";
import { makeTitleDetail } from "@webflix/contracts/fixtures";
import {
  createHmacTokenSigner,
  createPbkdf2PasswordHasher,
  ManualClock,
  PBKDF2_DEFAULT_ITERATIONS,
  prefixedCache,
} from "@webflix/core";
import {
  MemoryBlobStore,
  MemoryJobQueue,
  MemoryRateLimiter,
  MemorySearchIndex,
  MemoryStreamGate,
} from "@webflix/core/memory";
import {
  describeBlobStoreContract,
  describeJobQueueContract,
  describeKeyValueCacheContract,
  describePasswordHasherContract,
  describeRateLimiterContract,
  describeSearchIndexContract,
  describeStreamGateContract,
  describeTokenSignerContract,
} from "@webflix/core/testing";
import { bindRoutes, problemErrorHandler, requireClientHeader } from "@webflix/http";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createKvCache } from "../src/index.ts";

describeKeyValueCacheContract("Workers KV", () => ({
  // A fresh prefix per test keeps tests independent of storage isolation settings.
  cache: prefixedCache(createKvCache(env.CACHE), `t-${crypto.randomUUID()}:`),
}));

describePasswordHasherContract("pbkdf2-sha256 at the Workers cap", () => ({
  hasher: createPbkdf2PasswordHasher(),
}));

describeTokenSignerContract("hmac-sha256", () => {
  const clock = new ManualClock();
  return {
    signer: createHmacTokenSigner({ keys: [{ id: "k1", secret: "w".repeat(32) }], clock }),
    foreignSigner: createHmacTokenSigner({ keys: [{ id: "k9", secret: "x".repeat(32) }], clock }),
    now: () => clock.now(),
    time: { advance: (ms) => clock.advance(ms) },
  };
});

// The in-memory adapters and the suites themselves must also be runtime-portable.
describeRateLimiterContract("memory, in workerd", () => {
  const clock = new ManualClock();
  return {
    limiter: new MemoryRateLimiter({ clock }),
    time: { advance: (ms) => clock.advance(ms) },
  };
});
describeStreamGateContract("memory, in workerd", () => {
  const clock = new ManualClock();
  return { gate: new MemoryStreamGate({ clock }), time: { advance: (ms) => clock.advance(ms) } };
});
describeBlobStoreContract("memory, in workerd", () => ({ store: new MemoryBlobStore() }));
describeJobQueueContract("memory, in workerd", (processor) => {
  const queue = new MemoryJobQueue({ processor, maxAttempts: 3 });
  return {
    queue,
    drain: () => queue.drain(),
    deadLetters: () => queue.deadLetters,
    maxAttempts: 3,
  };
});
describeSearchIndexContract("memory, in workerd", () => ({ index: new MemorySearchIndex() }));

describe("Workers runtime facts the ports rely on", () => {
  const derive = async (iterations: number) => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("pw"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    return crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(16), iterations },
      key,
      256,
    );
  };

  // Older workerd rejected PBKDF2 above 100 000 iterations; the default relies on that cap
  // being gone. If this fails after a runtime upgrade, lower PBKDF2_DEFAULT_ITERATIONS.
  it(`computes PBKDF2 at the default ${PBKDF2_DEFAULT_ITERATIONS} iterations`, async () => {
    const bits = await derive(PBKDF2_DEFAULT_ITERATIONS);
    expect(bits.byteLength).toBe(32);
  });

  it("runs the typed API client against Hono routes from the route table", async () => {
    const app = new Hono();
    app.onError(problemErrorHandler());
    bindRoutes(
      app,
      { getTitle: routes.getTitle, addToMyList: routes.addToMyList },
      {
        getTitle: ({ params }) => makeTitleDetail({ id: params.id }),
        addToMyList: () => undefined,
      },
      { guard: requireClientHeader, validateResponses: true },
    );
    let credentials: unknown;
    const api = createRouteClient(routes, {
      validateResponses: true,
      fetch: async (url, init) => {
        credentials = init.credentials;
        return app.request(url, init);
      },
    });
    expect((await api.getTitle({ params: { id: "t-sintel" } })).id).toBe("t-sintel");
    await expect(api.addToMyList({ params: { titleId: "t-sintel" } })).resolves.toBeUndefined();
    // Omitted only where the runtime's Request lacks the member; never a thrown TypeError.
    expect(credentials === "include" || credentials === undefined).toBe(true);
  });
});
