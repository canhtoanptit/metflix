import { describe, expect, it } from "vitest";
import { parseKeyFile, validateKeys } from "../src/import-key.ts";
import { fake } from "./fakes.ts";

describe("make stripe-use-key", () => {
  it("reads the dotenv format the tooling itself writes", () => {
    const text = `# comment\nSTRIPE_SECRET_KEY=${fake.secretKey}\nSTRIPE_PUBLISHABLE_KEY="${fake.publishableKey}"\nOTHER=x\n`;
    expect(parseKeyFile(text)).toEqual({
      secretKey: fake.secretKey,
      publishableKey: fake.publishableKey,
    });
  });

  it("accepts test-mode secret, restricted and sandbox keys", () => {
    for (const secretKey of [fake.secretKey, fake.sandboxKey]) {
      expect(validateKeys({ secretKey, publishableKey: fake.publishableKey })).toEqual([]);
    }
  });

  it("refuses live keys and swapped or missing keys without echoing them", () => {
    const live = validateKeys({ secretKey: fake.liveKey, publishableKey: fake.publishableKey });
    expect(live).toEqual([
      "STRIPE_SECRET_KEY is a live-mode key; only test-mode keys are accepted",
    ]);
    const swapped = validateKeys({
      secretKey: fake.publishableKey,
      publishableKey: fake.secretKey,
    });
    expect(swapped).toHaveLength(2);
    expect(validateKeys({})).toEqual([
      "STRIPE_SECRET_KEY is missing",
      "STRIPE_PUBLISHABLE_KEY is missing",
    ]);
    for (const problem of [...live, ...swapped]) {
      expect(problem).not.toContain(fake.liveKey);
      expect(problem).not.toContain(fake.secretKey);
    }
  });
});
