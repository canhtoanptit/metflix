import {
  PLAN_IDS,
  RATE_LIMIT_POLICY_NAMES,
  type RateLimitPolicyName,
  type RouteSpec,
  routes,
  videoQualityForHeight,
  videoQualityLabel,
} from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  assertRateLimitTable,
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  ConfigError,
  compareMaturity,
  createHmacTokenSigner,
  createJobProcessor,
  createJsonCache,
  createJsonLogger,
  createMediaTokens,
  createPasswordHasherChain,
  createPbkdf2PasswordHasher,
  createSequentialIdGenerator,
  createUuidV7Generator,
  DEV_ONLY_MEDIA_TOKEN_KEY,
  decodeCursor,
  defineJob,
  encodeCursor,
  getPlan,
  handleJob,
  isWithinMaturityCeiling,
  type LogRecord,
  loadCoreConfig,
  ManualClock,
  MemoryLogger,
  maturityLevelsUpTo,
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
  parseHttpRange,
  parsePhc,
  resolveMaturityCeiling,
  timingSafeEqual,
  UUID_V7_PATTERN,
} from "../src/index.ts";
import { MemoryKeyValueCache } from "../src/memory/index.ts";

describe("encoding", () => {
  it("round-trips base64 and base64url for every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    expect(base64UrlEncode(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects invalid input", () => {
    expect(() => base64UrlDecode("a+b")).toThrow(TypeError);
    expect(() => base64Decode("a")).toThrow(TypeError);
  });

  it("compares in constant structure", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

describe("ids", () => {
  it("generates strictly increasing UUIDv7 values, even within one millisecond", () => {
    const clock = new ManualClock(Date.UTC(2026, 0, 1));
    const ids = createUuidV7Generator({ clock });
    const values = Array.from({ length: 5_000 }, () => ids.next());
    for (const value of values) expect(value).toMatch(UUID_V7_PATTERN);
    expect([...values].sort()).toEqual(values);
    expect(new Set(values).size).toBe(values.length);
    // The timestamp prefix encodes the clock (borrowing ms only on counter overflow).
    expect(Number.parseInt(values[0]?.replace("-", "").slice(0, 12) ?? "", 16)).toBe(clock.now());
  });

  it("offers deterministic sequential ids", () => {
    const ids = createSequentialIdGenerator("t");
    expect([ids.next(), ids.next()]).toEqual(["t-000001", "t-000002"]);
  });
});

describe("maturity", () => {
  it("orders levels ALL < 7+ < 13+ < 16+ < 18+", () => {
    expect(compareMaturity("ALL", "7+")).toBeLessThan(0);
    expect(compareMaturity("18+", "16+")).toBeGreaterThan(0);
    expect(isWithinMaturityCeiling("13+", "13+")).toBe(true);
    expect(isWithinMaturityCeiling("16+", "13+")).toBe(false);
    expect(maturityLevelsUpTo("13+")).toEqual(["ALL", "7+", "13+"]);
  });

  it("caps kids profiles at 7+", () => {
    expect(resolveMaturityCeiling(true)).toBe("7+");
    expect(resolveMaturityCeiling(true, "18+")).toBe("7+");
    expect(resolveMaturityCeiling(true, "ALL")).toBe("ALL");
    expect(resolveMaturityCeiling(false)).toBe("18+");
  });
});

describe("plans", () => {
  it("defines every plan id with increasing stream limits", () => {
    const plans = PLAN_IDS.map(getPlan);
    expect(plans.map((plan) => plan.maxStreams)).toEqual([1, 2, 4]);
    expect(plans.map((plan) => plan.maxVideoHeight)).toEqual([720, 1080, 2160]);
  });

  it("says quality and the stream limit in the words every screen uses", () => {
    for (const plan of PLAN_IDS.map(getPlan)) {
      const quality = videoQualityLabel(videoQualityForHeight(plan.maxVideoHeight));
      const screens = `${plan.maxStreams} ${plan.maxStreams === 1 ? "screen" : "screens"} at a time`;
      expect(plan.features.slice(0, 2)).toEqual([`${quality} video`, screens]);
      // Never "devices" for the stream limit, never 720p/1080p for quality.
      expect(plan.features.join(" ")).not.toMatch(/devices?|\d{3,4}p\b/i);
    }
  });
});

describe("cursors", () => {
  it("round-trips and rejects tampering", () => {
    const schema = z.object({ after: z.string(), n: z.number() });
    const cursor = encodeCursor({ after: "t-1", n: 2 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, schema)).toEqual({ after: "t-1", n: 2 });
    expect(decodeCursor("not-a-cursor", schema)).toBeNull();
    expect(decodeCursor(encodeCursor({ after: 1 }), schema)).toBeNull();
  });
});

describe("AppError", () => {
  it("carries the contract status and builds a problem", () => {
    const error = new AppError("rate_limited", { retryAfterSec: 12, detail: "Slow down" });
    expect(error.status).toBe(429);
    expect(error.message).toBe("Slow down");
    expect(error.toProblem({ requestId: "r1" })).toEqual({
      type: "urn:webflix:problem:rate_limited",
      title: "Too many requests",
      status: 429,
      code: "rate_limited",
      detail: "Slow down",
      requestId: "r1",
      retryAfterSec: 12,
    });
    expect(AppError.is(error, "rate_limited")).toBe(true);
    expect(AppError.is(new Error("x"))).toBe(false);
  });
});

describe("media tokens", () => {
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const signer = createHmacTokenSigner({ keys: [DEV_ONLY_MEDIA_TOKEN_KEY], clock });
  const tokens = createMediaTokens(signer, clock);

  it("binds a token to its asset and expires it", async () => {
    const { token, expiresAt } = await tokens.issue({
      assetId: "v-sintel",
      playbackSessionId: "ps-1",
      ttlSec: 3600,
      maxVideoHeight: 720,
    });
    expect(expiresAt).toBe(clock.now() + 3_600_000);
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(await tokens.verify(token, "v-sintel")).toEqual({
      valid: true,
      claims: {
        assetId: "v-sintel",
        playbackSessionId: "ps-1",
        exp: expiresAt / 1000,
        maxVideoHeight: 720,
      },
    });
    expect(await tokens.verify(token, "v-other")).toEqual({ valid: false, reason: "wrong_asset" });
    clock.advance(3_600_000);
    expect(await tokens.verify(token, "v-sintel")).toEqual({ valid: false, reason: "expired" });
  });

  it("reads tokens minted before the height claim as uncapped, and refuses a bad claim", async () => {
    const exp = clock.now() / 1000 + 60;
    const legacy = await signer.sign({ purpose: "media", exp, a: "v-sintel", s: "ps-1" });
    expect(await tokens.verify(legacy, "v-sintel")).toMatchObject({
      valid: true,
      claims: { maxVideoHeight: null },
    });
    const odd = await signer.sign({ purpose: "media", exp, a: "v-sintel", s: "ps-1", h: "720" });
    expect(await tokens.verify(odd, "v-sintel")).toEqual({ valid: false, reason: "malformed" });
  });

  it("does not accept a generic token for another purpose", async () => {
    const token = await signer.sign({
      purpose: "other",
      exp: clock.now() / 1000 + 60,
      a: "v-sintel",
      s: "x",
    });
    expect(await tokens.verify(token, "v-sintel")).toEqual({
      valid: false,
      reason: "wrong_purpose",
    });
  });
});

describe("password hashing", () => {
  it("rejects nonsensical PBKDF2 iteration counts", () => {
    expect(() => createPbkdf2PasswordHasher({ iterations: 0 })).toThrow(RangeError);
    expect(() => createPbkdf2PasswordHasher({ iterations: PBKDF2_MAX_ITERATIONS + 1 })).toThrow(
      RangeError,
    );
  });

  it("uses the OWASP iteration count by default and records it in the hash", async () => {
    const encoded = await createPbkdf2PasswordHasher().hash("pw");
    expect(PBKDF2_DEFAULT_ITERATIONS).toBe(600_000);
    expect(parsePhc(encoded)?.params).toEqual({ i: String(PBKDF2_DEFAULT_ITERATIONS) });
  });

  it("treats a tampered hash demanding absurd work as invalid instead of computing it", async () => {
    const encoded = await createPbkdf2PasswordHasher({ iterations: 1_000 }).hash("pw");
    const tampered = encoded.replace("$i=1000$", `$i=${PBKDF2_MAX_ITERATIONS + 1}$`);
    expect(await createPbkdf2PasswordHasher().verify("pw", tampered)).toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it("flags weaker or legacy hashes for rehash after a successful verify", async () => {
    const weak = createPbkdf2PasswordHasher({ iterations: 1_000 });
    const strong = createPbkdf2PasswordHasher({ iterations: 2_000 });
    const legacyHash = await weak.hash("pw");
    expect(await strong.verify("pw", legacyHash)).toEqual({ valid: true, needsRehash: true });
    const chain = createPasswordHasherChain(strong, weak);
    expect(await chain.verify("pw", await strong.hash("pw"))).toEqual({
      valid: true,
      needsRehash: false,
    });
    expect(await chain.verify("wrong", legacyHash)).toEqual({ valid: false, needsRehash: false });
  });
});

describe("JSON cache", () => {
  it("validates on read and loads on miss", async () => {
    const clock = new ManualClock();
    const raw = new MemoryKeyValueCache({ clock });
    const cache = createJsonCache(raw, {
      schema: z.object({ n: z.number() }),
      prefix: "rows:",
      ttlSec: 60,
    });
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { n: 1 };
    };
    expect(await cache.getOrLoad("a", load)).toEqual({ n: 1 });
    expect(await cache.getOrLoad("a", load)).toEqual({ n: 1 });
    expect(loads).toBe(1);
    await raw.set("rows:b", '{"n":"not a number"}', { ttlSec: 60 });
    expect(await cache.get("b")).toBeNull();
  });
});

describe("job processor", () => {
  const Rollup = defineJob("stats.rollup", z.object({ day: z.iso.date() }));

  it("publishes the input form so transforms run once, in the consumer", () => {
    const Trimmed = defineJob("titles.reindex", z.object({ id: z.string().trim() }));
    expect(Trimmed.create({ id: "  t-1 " }).payload).toEqual({ id: "  t-1 " });
  });

  it("validates payloads at publish time", () => {
    expect(Rollup.create({ day: "2026-01-01" })).toEqual({
      type: "stats.rollup",
      payload: { day: "2026-01-01" },
    });
    expect(() => Rollup.create({ day: "yesterday" })).toThrow();
  });

  it("acks handled jobs and retries everything else with backoff", async () => {
    const logger = new MemoryLogger();
    const seen: string[] = [];
    const processor = createJobProcessor({
      logger,
      retry: { baseDelaySec: 2, maxDelaySec: 10 },
      jobs: [
        handleJob(Rollup, async (payload, context) => {
          if (context.attempt < 3) throw new Error("transient");
          seen.push(payload.day);
        }),
      ],
    });
    const delivery = {
      id: "j1",
      type: "stats.rollup",
      payload: { day: "2026-01-01" },
      enqueuedAt: 0,
    };
    expect(await processor({ ...delivery, attempt: 1 })).toEqual({ action: "retry", delaySec: 2 });
    expect(await processor({ ...delivery, attempt: 2 })).toEqual({ action: "retry", delaySec: 4 });
    expect(await processor({ ...delivery, attempt: 3 })).toEqual({ action: "ack" });
    expect(await processor({ ...delivery, attempt: 9 })).toEqual({ action: "ack" });
    expect(seen).toEqual(["2026-01-01", "2026-01-01"]);

    // Unknown types and invalid payloads retry (and eventually dead-letter), never vanish.
    expect(await processor({ ...delivery, attempt: 1, type: "nope.job" })).toEqual({
      action: "retry",
      delaySec: 2,
    });
    expect(await processor({ ...delivery, attempt: 2, payload: { day: 5 } })).toEqual({
      action: "retry",
      delaySec: 4,
    });
    expect(logger.records.map((record) => record.msg)).toEqual(
      expect.arrayContaining(["job.failed", "job.unknown_type", "job.invalid_payload"]),
    );
  });
});

describe("JSON logger", () => {
  it("writes one JSON line per record with bindings and serialised errors", () => {
    const lines: string[] = [];
    const records: LogRecord[] = [];
    const logger = createJsonLogger({
      level: "info",
      clock: new ManualClock(Date.UTC(2026, 0, 1)),
      sink: (record, line) => {
        records.push(record);
        lines.push(line);
      },
    }).child({ requestId: "r1" });
    logger.debug("hidden");
    logger.error("failed", { error: new Error("boom", { cause: new Error("root") }), n: 1n });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed).toMatchObject({
      level: "error",
      msg: "failed",
      time: "2026-01-01T00:00:00.000Z",
      requestId: "r1",
      n: "1",
      error: { name: "Error", message: "boom", cause: { message: "root" } },
    });
  });
});

describe("config", () => {
  it("applies development defaults", () => {
    const config = loadCoreConfig({ WEBFLIX_MODE: "dev", PATH: "/usr/bin" });
    expect(config).toMatchObject({
      mode: "dev",
      environment: "development",
      publicOrigin: "http://localhost:5173",
      cookies: { secure: false, sessionCookieName: "webflix_session" },
      media: { tokenKeys: [DEV_ONLY_MEDIA_TOKEN_KEY], tokenTtlSec: 21_600 },
      playback: { heartbeatIntervalSec: 30, leaseTtlSec: 75 },
    });
    expect(config.rateLimits.auth).toEqual({ name: "auth", limit: 10, windowSec: 60 });
  });

  it("parses overrides and ignores non-string bindings (Workers env)", () => {
    const config = loadCoreConfig({
      WEBFLIX_MODE: "cloudflare",
      WEBFLIX_PUBLIC_ORIGIN: "https://webflix.example.com/",
      WEBFLIX_MEDIA_TOKEN_KEYS: `k2:${"a".repeat(32)}, k1:${"b".repeat(32)}`,
      WEBFLIX_RATE_LIMIT_PROFILE_PIN: "3/10",
      DB: { prepare() {} },
    });
    expect(config.publicOrigin).toBe("https://webflix.example.com");
    expect(config.cookies).toEqual({
      secure: true,
      sessionCookieName: "__Host-webflix_session",
      knownDeviceCookieName: "__Host-webflix_device",
    });
    expect(config.media.tokenKeys.map((key) => key.id)).toEqual(["k2", "k1"]);
    expect(config.rateLimits["profile-pin"]).toEqual({
      name: "profile-pin",
      limit: 3,
      windowSec: 10,
    });
  });

  it("resolves every rate limit a route or handler charges, whatever is overridden", () => {
    const relaxed = Object.fromEntries(
      RATE_LIMIT_POLICY_NAMES.map((name) => [
        `WEBFLIX_RATE_LIMIT_${name.toUpperCase().replaceAll("-", "_")}`,
        "60/60",
      ]),
    );
    const variants: Array<Record<string, string>> = [
      { WEBFLIX_MODE: "dev" },
      // An older relaxed table that predates some policies (they keep their defaults).
      { WEBFLIX_MODE: "dev", WEBFLIX_RATE_LIMIT_AUTH: "60/60" },
      { WEBFLIX_MODE: "cloudflare", ...relaxed },
      {
        WEBFLIX_MODE: "k8s",
        WEBFLIX_ENV: "production",
        WEBFLIX_MEDIA_TOKEN_KEYS: `k1:${"a".repeat(32)}`,
      },
    ];
    const charged = new Set<string>(RATE_LIMIT_POLICY_NAMES);
    for (const route of Object.values(routes) as RouteSpec[]) {
      if (route.rateLimit) expect(charged.has(route.rateLimit), route.rateLimit).toBe(true);
    }
    for (const env of variants) {
      const { rateLimits } = loadCoreConfig(env);
      for (const name of charged) {
        expect(
          rateLimits[name as RateLimitPolicyName]?.name,
          `${name} in ${JSON.stringify(env)}`,
        ).toBe(name);
      }
      expect(() => assertRateLimitTable(rateLimits)).not.toThrow();
    }
  });

  it("refuses a rate-limit table that lacks a policy", () => {
    const { rateLimits } = loadCoreConfig({ WEBFLIX_MODE: "dev" });
    const { "playback-start": _dropped, ...incomplete } = rateLimits;
    expect(() => assertRateLimitTable(incomplete)).toThrow(ConfigError);
    expect(() =>
      assertRateLimitTable({ ...rateLimits, auth: { name: "auth", limit: 0, windowSec: 60 } }),
    ).toThrow(/rate limit "auth"/);
  });

  it("refuses unsafe production settings and reports every problem", () => {
    const attempt = () =>
      loadCoreConfig({ WEBFLIX_MODE: "k8s", WEBFLIX_ENV: "production", WEBFLIX_LOG_LEVEL: "loud" });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      expect((error as ConfigError).issues.join("\n")).toContain("WEBFLIX_LOG_LEVEL");
    }
    expect(() =>
      loadCoreConfig({
        WEBFLIX_MODE: "k8s",
        WEBFLIX_ENV: "production",
        WEBFLIX_MEDIA_TOKEN_KEYS: `dev:${DEV_ONLY_MEDIA_TOKEN_KEY.secret}`,
      }),
    ).toThrow(/development key/);
    expect(() => loadCoreConfig({ WEBFLIX_MODE: "k8s", WEBFLIX_ENV: "production" })).toThrow(
      /WEBFLIX_MEDIA_TOKEN_KEYS: required/,
    );
  });
});

describe("HTTP Range parsing", () => {
  it.each([
    ["bytes=0-499", { offset: 0, length: 500 }],
    ["bytes=500-", { offset: 500 }],
    ["bytes=-200", { suffix: 200 }],
    ["bytes=5-4", null],
    ["bytes=0-99999999999999999999", { offset: 0 }],
    ["bytes=-99999999999999999999", { suffix: Number.MAX_SAFE_INTEGER }],
    ["bytes=99999999999999999999-", { offset: Number.MAX_SAFE_INTEGER }],
    ["bytes=0-1,5-6", null],
    ["items=0-1", null],
    ["", null],
  ] as const)("%s", (header, expected) => {
    expect(parseHttpRange(header)).toEqual(expected);
  });
});
