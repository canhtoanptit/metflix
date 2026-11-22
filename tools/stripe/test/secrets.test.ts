import { describe, expect, it } from "vitest";
import { describeKey, findSecrets, redact } from "../src/secrets.ts";
import { fake } from "./fakes.ts";

describe("redact", () => {
  it.each(Object.entries(fake))("removes a %s", (_name, value) => {
    const line = `prefix ${value} suffix`;
    const out = redact(line);
    expect(out).not.toContain(value);
    expect(out).toMatch(/^prefix \[redacted [a-z_ ]+\] suffix$/);
  });

  it("redacts every occurrence in multi-line CLI output", () => {
    const output = `{\n  "secret_key": "${fake.sandboxKey}",\n  "publishable_key": "${fake.publishableKey}",\n  "claim_url": "${fake.claimUrl}"\n}\nReady! Your webhook signing secret is ${fake.webhookSecret} (^C to quit)`;
    const out = redact(output);
    for (const value of [fake.sandboxKey, fake.publishableKey, fake.claimUrl, fake.webhookSecret]) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain("Ready! Your webhook signing secret is [redacted webhook_secret]");
  });

  it("leaves documentation placeholders, ids and enum values alone", () => {
    const text =
      "sk_test_... whsec_xxx cus_RkQ8tZ3cVhJ2aB create_prorations pm_card_visa price_1AbXyZ7xQm2LpRt9XGWCKPwC";
    expect(redact(text)).toBe(text);
  });
});

describe("findSecrets", () => {
  it("reports kind and line, and only a prefix of the value", () => {
    const findings = findSecrets(`a\nb ${fake.secretKey}\n${fake.webhookSecret}`);
    expect(findings.map((f) => [f.kind, f.line])).toEqual([
      ["api_key", 2],
      ["webhook_secret", 3],
    ]);
    for (const f of findings) expect(f.preview.length).toBeLessThanOrEqual(9);
  });

  it("finds a claim link with its token", () => {
    expect(findSecrets(fake.claimUrl).map((f) => f.kind)).toEqual(["claim_url"]);
  });

  it("finds Stripe's masked key form", () => {
    expect(
      findSecrets(`The provided key '${fake.maskedKey}' does not have`).map((f) => f.kind),
    ).toEqual(["masked_key"]);
  });
});

describe("describeKey", () => {
  it("names the key from its prefix without echoing it", () => {
    expect(describeKey(fake.sandboxKey)).toBe("restricted sandbox key (test mode)");
    expect(describeKey(fake.secretKey)).toBe("secret key (test mode)");
    expect(describeKey(fake.liveKey)).toBe("restricted key (live mode)");
    expect(describeKey("nonsense")).toBe("unrecognised key format");
  });
});
