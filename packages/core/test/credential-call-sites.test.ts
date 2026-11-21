/**
 * Every password or PIN comparison after sign-in goes through `services/credentials.ts`, which
 * charges the account's credential budget before hashing (docs/DECISIONS.md D25). This walks
 * the server sources and lists every `PasswordHasher.verify` call: a new one fails here until it
 * is routed through the credential checks (or, if it is not a guess an attacker controls,
 * listed below with the reason).
 */
import { describe, expect, it } from "vitest";

const sources = {
  ...import.meta.glob<string>("../../*/src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob<string>("../../../apps/{api,edge}/{src,scripts}/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

/** `.verify(` receivers that are token signatures, not secrets a person typed. */
const SIGNATURE_VERIFIERS = /\b(?:signer|deviceSigner|mediaTokens|subtle)\.verify\(/;

/** The only places a password or PIN is compared, and why each is safe. */
const ALLOWED: Record<string, { calls: number; why: string }> = {
  "core/src/services/credentials.ts": {
    calls: 2,
    why: "the credential checks: charged before hashing",
  },
  "core/src/services/auth.ts": {
    calls: 1,
    why: "sign-in: limited per address (auth) and per email (auth-email) before hashing",
  },
  "core/src/services/seed.ts": {
    calls: 2,
    why: "the seeder comparing the demo account with its public seed (an operator command)",
  },
  "core/src/ports/password-hasher.ts": {
    calls: 1,
    why: "the hasher chain delegating to the hasher that made the hash",
  },
};

function passwordVerifications(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const [path, source] of Object.entries(sources)) {
    if (path.includes("/testing/") || path.includes("/node_modules/")) continue;
    // Keys are relative to this file; name each source from the repository root.
    const name = new URL(path, "file:///repo/packages/core/test/").pathname.replace(
      /^\/repo\/(packages\/)?/,
      "",
    );
    for (const line of source.split("\n")) {
      if (!/\.verify\(/.test(line) || SIGNATURE_VERIFIERS.test(line)) continue;
      found[name] = (found[name] ?? 0) + 1;
    }
  }
  return found;
}

describe("password and PIN comparisons", () => {
  it("happen only where they are charged or cannot be guessed through", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(passwordVerifications()).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([path, { calls }]) => [path, calls])),
    );
  });
});
