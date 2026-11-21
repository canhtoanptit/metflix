/**
 * What each limit is keyed by: sign-ins per email address as well as per client address (a
 * browser that signed in before is exempt), client addresses by IPv6 /64, playback starts per
 * account.
 */
import { API_BASE_PATH, ApiError, CLIENT_HEADER, CLIENT_HEADER_VALUE } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { clientAddressKey } from "../src/client-address.ts";
import { createTestApp, DEMO, onboard, type TestApp } from "./support.ts";

const PASSWORD = "correct horse battery";

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (ApiError.is(error) ? error.code : String(error)),
  );
}

/** A sign-in from a fresh browser at `ip`, answered as a problem code (null when signed in). */
async function signInFrom(t: TestApp, ip: string, email: string, password: string) {
  const response = await t.request(`${API_BASE_PATH}/auth/login`, {
    method: "POST",
    headers: {
      [CLIENT_HEADER]: CLIENT_HEADER_VALUE,
      "Content-Type": "application/json",
      "X-Test-Ip": ip,
    },
    body: JSON.stringify({ email, password }),
  });
  if (response.ok) return null;
  return ((await response.json()) as { code: string }).code;
}

describe("sign-ins per email address", () => {
  const config = { WEBFLIX_RATE_LIMIT_AUTH: "100/60", WEBFLIX_RATE_LIMIT_AUTH_EMAIL: "3/900" };

  it("limits guesses at one account from any number of addresses, before hashing", async () => {
    const t = await createTestApp({ config });
    await onboard(t, { email: "owner@example.com" });
    const verify = t.deps.passwords.verify.bind(t.deps.passwords);
    let verifications = 0;
    t.deps.passwords.verify = async (password, encoded) => {
      verifications += 1;
      return verify(password, encoded);
    };
    const codes: Array<string | null> = [];
    for (let guess = 0; guess < 6; guess += 1) {
      codes.push(await signInFrom(t, `198.51.100.${guess}`, "owner@example.com", `guess-${guess}`));
    }
    expect(codes).toEqual([
      "invalid_credentials",
      "invalid_credentials",
      "invalid_credentials",
      "rate_limited",
      "rate_limited",
      "rate_limited",
    ]);
    expect(verifications).toBe(3);
    // The right password from a new browser waits too; other accounts do not.
    expect(await signInFrom(t, "198.51.100.77", "owner@example.com", PASSWORD)).toBe(
      "rate_limited",
    );
    await onboard(t, { email: "neighbour@example.com" });
    expect(await signInFrom(t, "198.51.100.77", "neighbour@example.com", PASSWORD)).toBeNull();
    t.clock.advance(1_800_000);
    expect(await signInFrom(t, "198.51.100.77", "owner@example.com", PASSWORD)).toBeNull();
  });

  it("never locks out a browser that signed in to the account before", async () => {
    const t = await createTestApp({ config });
    const { device: owner } = await onboard(t, { email: "owner@example.com" });
    await owner.api.logout();
    for (let guess = 0; guess < 5; guess += 1) {
      await signInFrom(t, `198.51.100.${guess}`, "owner@example.com", `guess-${guess}`);
    }
    expect(await signInFrom(t, "198.51.100.9", "owner@example.com", PASSWORD)).toBe("rate_limited");
    // The owner's browser kept its "known device" cookie through the sign-out.
    const session = await owner.api.login({
      body: { email: "owner@example.com", password: PASSWORD },
    });
    expect(session.account.email).toBe("owner@example.com");
    // A browser known to another account is not known to this one.
    const { device: stranger } = await onboard(t, { email: "stranger@example.com" });
    expect(
      await codeOf(
        stranger.api.login({ body: { email: "owner@example.com", password: PASSWORD } }),
      ),
    ).toBe("rate_limited");
  });

  it("charges unknown addresses alike, and never the demo account (its password is public)", async () => {
    const t = await createTestApp({ config });
    const unknown = [];
    for (let guess = 0; guess < 4; guess += 1) {
      unknown.push(await signInFrom(t, "198.51.100.1", "nobody@example.com", `guess-${guess}`));
    }
    expect(unknown).toEqual([
      "invalid_credentials",
      "invalid_credentials",
      "invalid_credentials",
      "rate_limited",
    ]);
    for (let visitor = 0; visitor < 6; visitor += 1) {
      expect(await signInFrom(t, `198.51.100.${visitor}`, DEMO.email, DEMO.password)).toBeNull();
    }
  });
});

describe("client addresses", () => {
  it("keys IPv6 addresses by their /64 and IPv4-mapped ones as IPv4", () => {
    expect(clientAddressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientAddressKey("2001:0DB8:0001:0002:ffff:ffff:ffff:fffe")).toBe("2001:db8:1:2::/64");
    expect(clientAddressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientAddressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(clientAddressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientAddressKey("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(clientAddressKey("::1")).toBe("0:0:0:0::/64");
    expect(clientAddressKey("unknown")).toBe("unknown");
    expect(clientAddressKey("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(clientAddressKey("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });

  it("limits a whole IPv6 /64 as one client, for sign-ins and email lookups", async () => {
    const t = await createTestApp({
      config: { WEBFLIX_RATE_LIMIT_AUTH: "3/60", WEBFLIX_RATE_LIMIT_EMAIL_LOOKUP: "3/60" },
    });
    const rotating = ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2:abcd::9"];
    for (const [index, ip] of rotating.entries()) {
      expect(await signInFrom(t, ip, `n${index}@example.com`, "whatever-1")).toBe(
        "invalid_credentials",
      );
    }
    expect(await signInFrom(t, "2001:db8:1:2:ffff::1", "n9@example.com", "whatever-1")).toBe(
      "rate_limited",
    );
    expect(await signInFrom(t, "2001:db8:1:3::1", "n9@example.com", "whatever-1")).toBe(
      "invalid_credentials",
    );
    const lookup = (ip: string) =>
      t.request(`${API_BASE_PATH}/auth/email-status?email=x%40example.com`, {
        headers: { "X-Test-Ip": ip },
      });
    for (const ip of rotating) expect((await lookup(ip)).status).toBe(200);
    expect((await lookup("2001:db8:1:2::77")).status).toBe(429);
    expect((await lookup("2001:db8:9:9::1")).status).toBe(200);
  });
});

describe("playback starts per account", () => {
  it("limits starting streams per account, whichever device starts them", async () => {
    const t = await createTestApp({ config: { WEBFLIX_RATE_LIMIT_PLAYBACK_START: "3/60" } });
    const { device } = await onboard(t, { email: "zapper@example.com" });
    for (let start = 0; start < 3; start += 1) {
      await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    }
    expect(
      await codeOf(device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } })),
    ).toBe("rate_limited");
    const { device: other } = await onboard(t, { email: "other@example.com" });
    await other.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    t.clock.advance(120_000);
    await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
  });
});
