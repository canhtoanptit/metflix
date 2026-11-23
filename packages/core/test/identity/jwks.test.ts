/**
 * `createJwksKeySet`: the one verifier of JWS signatures against an issuer's published keys,
 * shared by the member relying party and the staff API's resource server. Every rule is driven
 * here against a scripted issuer (keys, status, delay), with a manual clock.
 */
import { describe, expect, it } from "vitest";
import { base64UrlEncode, utf8Encode } from "../../src/encoding.ts";
import { createJwksKeySet, JwksError, type JwksFailure, parseJws } from "../../src/index.ts";
import { ManualClock } from "../../src/ports/clock.ts";

const RSA = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { kty: "RSA", n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" },
  };
}

const encode = (value: unknown) => base64UrlEncode(utf8Encode(JSON.stringify(value)));

async function sign(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  payload: Record<string, unknown> = { sub: "x" },
) {
  const input = `${encode({ alg: "RS256", ...header })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, utf8Encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** A scripted issuer: the keys it publishes, how it answers, how many times it was asked. */
function issuer(initial: Array<Awaited<ReturnType<typeof keyPair>>>) {
  const state = { keys: initial, status: 200, delayMs: 0, fetches: 0 };
  const fetch = async (request: Request) => {
    expect(request.url).toBe("https://issuer.test/jwks");
    state.fetches += 1;
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    if (state.status !== 200) return new Response("down", { status: state.status });
    return Response.json({ keys: state.keys.map((key) => key.publicJwk) });
  };
  return { state, fetch };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (error === null) return "accepted";
  expect(error).toBeInstanceOf(JwksError);
  return `${(error as JwksError).reason}:${(error as JwksError).message}`;
}

function parsed(token: string) {
  const jws = parseJws(token);
  if (!jws) throw new Error("not a JWS");
  return jws;
}

describe("createJwksKeySet", () => {
  it("verifies a signature by a published key, and refuses a tampered token", async () => {
    const current = await keyPair("k1");
    const { fetch } = issuer([current]);
    const keys = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock: new ManualClock(0),
    });
    const token = await sign(current.privateKey, { kid: "k1" });
    expect(await refusal(keys.verify(parsed(token)))).toBe("accepted");
    const [header, , signature] = token.split(".");
    const tampered = `${header}.${encode({ sub: "someone-else" })}.${signature}`;
    expect(await refusal(keys.verify(parsed(tampered)))).toBe("bad_signature:bad_signature");
  });

  it("takes the algorithm from configuration and refuses crit and a missing kid", async () => {
    const current = await keyPair("k1");
    const { fetch, state } = issuer([current]);
    const keys = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock: new ManualClock(0),
    });
    const cases: Array<[Record<string, unknown>, JwksFailure]> = [
      [{ alg: "none", kid: "k1" }, "alg_not_allowed"],
      [{ alg: "HS256", kid: "k1" }, "alg_not_allowed"],
      [{ alg: "ES256", kid: "k1" }, "alg_not_allowed"],
      [{ kid: "k1", crit: ["exp"] }, "crit_not_understood"],
      [{}, "kid_missing"],
    ];
    for (const [header, reason] of cases) {
      const token = await sign(current.privateKey, header);
      expect(await refusal(keys.verify(parsed(token))), JSON.stringify(header)).toBe(
        `${reason}:${reason}`,
      );
    }
    // Refused before any key was looked at.
    expect(state.fetches).toBe(0);
  });

  it("never uses a key the token carries", async () => {
    const published = await keyPair("k1");
    const attacker = await keyPair("evil");
    const { fetch } = issuer([published]);
    const keys = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock: new ManualClock(0),
    });
    const token = await sign(attacker.privateKey, {
      kid: "evil",
      jwk: attacker.publicJwk,
      jku: "https://evil.test/jwks",
    });
    expect(await refusal(keys.verify(parsed(token)))).toBe("unknown_kid:unknown_kid");
  });

  it("refetches once for an unknown kid, at most once per cooldown, and accepts a rotated key", async () => {
    const clock = new ManualClock(0);
    const current = await keyPair("k1");
    const next = await keyPair("k2");
    const { fetch, state } = issuer([current]);
    const keys = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock,
      refetchCooldownSec: 10,
    });
    expect(await refusal(keys.verify(parsed(await sign(current.privateKey, { kid: "k1" }))))).toBe(
      "accepted",
    );
    expect(state.fetches).toBe(1);
    // Rotated in within the cooldown: not refetched yet.
    state.keys = [current, next];
    const rotated = parsed(await sign(next.privateKey, { kid: "k2" }));
    expect(await refusal(keys.verify(rotated))).toBe("unknown_kid:unknown_kid");
    expect(state.fetches).toBe(1);
    clock.advance(10_000);
    expect(await refusal(keys.verify(rotated))).toBe("accepted");
    expect(state.fetches).toBe(2);
    // A bogus kid right after: no new fetch inside the cooldown.
    const bogus = await keyPair("bogus");
    expect(await refusal(keys.verify(parsed(await sign(bogus.privateKey, { kid: "bogus" }))))).toBe(
      "unknown_kid:unknown_kid",
    );
    expect(state.fetches).toBe(2);
  });

  it("keeps trusted keys through an issuer outage, and fails without any", async () => {
    const clock = new ManualClock(0);
    const current = await keyPair("k1");
    const { fetch, state } = issuer([current]);
    const token = parsed(await sign(current.privateKey, { kid: "k1" }));
    state.status = 503;
    const cold = createJwksKeySet({ jwksUri: "https://issuer.test/jwks", fetch, clock });
    expect(await refusal(cold.verify(token))).toBe("unavailable:jwks_status_503");
    state.status = 200;
    const warm = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock,
      cacheTtlSec: 60,
    });
    expect(await refusal(warm.verify(token))).toBe("accepted");
    state.status = 503;
    clock.advance(61_000); // stale: the refresh fails, the trusted set stays
    expect(await refusal(warm.verify(token))).toBe("accepted");
  });

  it("times out a slow issuer, fetches for each concurrent verification on a cold cache, passes the resolver's error through", async () => {
    const current = await keyPair("k1");
    const { fetch, state } = issuer([current]);
    const token = parsed(await sign(current.privateKey, { kid: "k1" }));
    state.delayMs = 300;
    const slow = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock: new ManualClock(0),
      timeoutMs: 50,
    });
    expect(await refusal(slow.verify(token))).toBe("unavailable:issuer_timeout");

    state.delayMs = 20;
    state.fetches = 0;
    const shared = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock: new ManualClock(0),
    });
    // No in-flight fetch is shared (on Workers one request may not await a promise another
    // request settles, docs/CLOUDFLARE.md §2): with nothing trusted yet, each one fetches.
    const outcomes = await Promise.all([1, 2, 3, 4].map(() => refusal(shared.verify(token))));
    expect(outcomes).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    expect(state.fetches).toBe(4);
    expect(await refusal(shared.verify(token))).toBe("accepted");
    expect(state.fetches).toBe(4);

    const failing = createJwksKeySet({
      jwksUri: async () => {
        throw new TypeError("discovery names another issuer");
      },
      fetch,
      clock: new ManualClock(0),
    });
    await expect(failing.verify(token)).rejects.toThrow("discovery names another issuer");
  });

  it("refreshes a stale set once while concurrent verifications keep it, and refetches an unknown kid once, whoever asks", async () => {
    const clock = new ManualClock(0);
    const current = await keyPair("k1");
    const next = await keyPair("k2");
    const { fetch, state } = issuer([current]);
    const keys = createJwksKeySet({
      jwksUri: "https://issuer.test/jwks",
      fetch,
      clock,
      cacheTtlSec: 60,
      refetchCooldownSec: 10,
    });
    const token = parsed(await sign(current.privateKey, { kid: "k1" }));
    expect(await refusal(keys.verify(token))).toBe("accepted");
    expect(state.fetches).toBe(1);

    state.delayMs = 20;
    clock.advance(61_000); // stale: the first refreshes, the others use the trusted set meanwhile
    const stale = await Promise.all([1, 2, 3, 4].map(() => refusal(keys.verify(token))));
    expect(stale).toEqual(["accepted", "accepted", "accepted", "accepted"]);
    expect(state.fetches).toBe(2);

    state.keys = [current, next];
    clock.advance(10_000); // past the cooldown: a rotated key is refetched, by one of them only
    const rotated = parsed(await sign(next.privateKey, { kid: "k2" }));
    const outcomes = await Promise.all([1, 2, 3, 4].map(() => refusal(keys.verify(rotated))));
    expect(state.fetches).toBe(3);
    expect(outcomes.filter((outcome) => outcome === "accepted")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "unknown_kid:unknown_kid")).toHaveLength(3);
    expect(await refusal(keys.verify(rotated))).toBe("accepted");
    expect(state.fetches).toBe(3);
  });
});
