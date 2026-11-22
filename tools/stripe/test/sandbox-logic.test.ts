import { describe, expect, it } from "vitest";
import {
  decide,
  describeExpiry,
  expiryInstant,
  firstJsonObject,
  parseCreateOutput,
} from "../src/sandbox-logic.ts";
import { fake } from "./fakes.ts";

describe("parseCreateOutput (stripe sandboxes create, CLI 1.55.x)", () => {
  it("reads a freshly provisioned sandbox from the JSON block", () => {
    const stdout = `Setting up your sandbox... done.\n${JSON.stringify(
      {
        secret_key: fake.sandboxKey,
        publishable_key: fake.publishableKey,
        claim_url: fake.claimUrl,
        account_id: "acct_1AbCDE7xQm2LpRt9",
        expires_at: "2026-11-28",
      },
      null,
      2,
    )}\n\nUse the keys above to start building your integration.\n`;
    expect(parseCreateOutput(stdout)).toEqual({
      kind: "created",
      secretKey: fake.sandboxKey,
      publishableKey: fake.publishableKey,
      claimUrl: fake.claimUrl,
      accountId: "acct_1AbCDE7xQm2LpRt9",
      expiresOn: "2026-11-28",
    });
  });

  it("reads an RFC 3339 expiry as its date", () => {
    const stdout = JSON.stringify({
      secret_key: fake.sandboxKey,
      publishable_key: fake.publishableKey,
      account_id: "acct_1",
      expires_at: "2026-11-28T17:57:50Z",
    });
    expect(parseCreateOutput(stdout)).toMatchObject({
      kind: "created",
      expiresOn: "2026-11-28",
      claimUrl: null,
    });
  });

  it("adopts the sandbox an existing profile already holds", () => {
    const stdout = [
      "You already have an active sandbox.",
      "",
      `Secret key:      ${fake.sandboxKey}`,
      `Publishable key: ${fake.publishableKey}`,
      "Account ID:      acct_1AbCDE7xQm2LpRt9",
      "",
      "This sandbox expires 2026-11-28 (in 6 days). Claim it before then by running `stripe sandboxes claim`.",
    ].join("\n");
    expect(parseCreateOutput(stdout)).toEqual({
      kind: "existing",
      secretKey: fake.sandboxKey,
      publishableKey: fake.publishableKey,
      accountId: "acct_1AbCDE7xQm2LpRt9",
      expiresOn: "2026-11-28",
      claimed: false,
    });
  });

  it("recognises the expired-profile message", () => {
    expect(parseCreateOutput("Your sandbox session has expired.\nRun `stripe login` …").kind).toBe(
      "expired",
    );
  });

  it("recognises the browser-login fallback, in JSON and in text", () => {
    expect(
      parseCreateOutput(
        JSON.stringify({
          browser_url: "https://dashboard.stripe.com/x",
          verification_code: "a-b-c",
        }),
      ).kind,
    ).toBe("login-fallback");
    expect(
      parseCreateOutput("\nCould not provision a sandbox automatically. Opening browser…").kind,
    ).toBe("login-fallback");
  });

  it("recognises a logged-in profile", () => {
    expect(
      parseCreateOutput(
        "You're already authenticated; sandbox management is available in Dashboard.",
      ).kind,
    ).toBe("authenticated");
  });

  it("does not guess at anything else", () => {
    expect(parseCreateOutput("something new").kind).toBe("unrecognised");
    expect(parseCreateOutput('{"secret_key": "x"}').kind).toBe("unrecognised");
  });
});

describe("firstJsonObject", () => {
  it("handles braces inside strings and text around the object", () => {
    expect(firstJsonObject('noise {"a": "}{", "b": {"c": 1}} trailing {"d": 2}')).toEqual({
      a: "}{",
      b: { c: 1 },
    });
    expect(firstJsonObject("no json")).toBeNull();
    expect(firstJsonObject("{broken")).toBeNull();
  });
});

describe("decide", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const valid = { credentials: "valid" as const, claimed: false };

  it("creates when nothing is configured", () => {
    expect(
      decide({ hasState: false, expiresOn: null, probe: null, now, minRemainingHours: 24 }).action,
    ).toBe("create");
  });

  it("reuses a working sandbox that is not about to expire", () => {
    expect(
      decide({ hasState: true, expiresOn: "2026-11-28", probe: valid, now, minRemainingHours: 24 })
        .action,
    ).toBe("reuse");
  });

  it("replaces a sandbox whose key Stripe rejects", () => {
    const d = decide({
      hasState: true,
      expiresOn: "2026-11-28",
      probe: { credentials: "invalid", claimed: null },
      now,
      minRemainingHours: 24,
    });
    expect(d.action).toBe("create");
    expect(d.reason).toMatch(/rejected/);
  });

  it("replaces a sandbox that expires within the minimum", () => {
    // 00:00 UTC on the 23rd is 12 hours away.
    const d = decide({
      hasState: true,
      expiresOn: "2026-11-23",
      probe: valid,
      now,
      minRemainingHours: 24,
    });
    expect(d).toEqual({
      action: "create",
      reason: "the sandbox expires in 12 h, under the 24 h minimum",
    });
    expect(
      decide({ hasState: true, expiresOn: "2026-11-23", probe: valid, now, minRemainingHours: 6 })
        .action,
    ).toBe("reuse");
  });

  it("never replaces a sandbox because the network is down", () => {
    expect(
      decide({
        hasState: true,
        expiresOn: "2026-11-28",
        probe: { credentials: "unreachable", claimed: null },
        now,
        minRemainingHours: 24,
      }).action,
    ).toBe("fail");
  });
});

describe("expiry", () => {
  it("follows the CLI: expired from 00:00 UTC on the expiry date", () => {
    expect(expiryInstant("2026-11-28").toISOString()).toBe("2026-11-28T00:00:00.000Z");
  });

  it("describes the days left like the CLI", () => {
    const now = new Date("2026-11-21T17:57:50Z");
    expect(describeExpiry("2026-11-28", now)).toBe("2026-11-28 (in 7 days)");
    expect(describeExpiry("2026-11-22", now)).toBe("2026-11-22 (in 1 day)");
    expect(describeExpiry("2026-11-20", now)).toBe("2026-11-20 (expired)");
    expect(describeExpiry(null, now)).toMatch(/unknown/);
  });
});
