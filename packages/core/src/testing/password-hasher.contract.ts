import { describe, expect, it } from "vitest";
import { MAX_PASSWORD_BYTES, type PasswordHasher } from "../ports/password-hasher.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface PasswordHasherHarness extends HarnessBase {
  hasher: PasswordHasher;
}

/** Contract every `PasswordHasher` must pass. Use cheap parameters in tests. */
export function describePasswordHasherContract(
  name: string,
  factory: HarnessFactory<PasswordHasherHarness>,
): void {
  describe(`PasswordHasher contract: ${name}`, () => {
    const h = useHarness(factory);

    it("produces a self-describing PHC string that does not contain the password", async () => {
      const { hasher } = h();
      const encoded = await hasher.hash("correct horse battery staple");
      expect(encoded.startsWith(`$${hasher.algorithm}$`)).toBe(true);
      expect(encoded).not.toContain("correct horse");
      expect(hasher.supports(encoded)).toBe(true);
    });

    it("verifies the right password and rejects others", async () => {
      const { hasher } = h();
      const encoded = await hasher.hash("webflix-demo");
      expect(await hasher.verify("webflix-demo", encoded)).toEqual({
        valid: true,
        needsRehash: false,
      });
      expect((await hasher.verify("webflix-Demo", encoded)).valid).toBe(false);
      expect((await hasher.verify("", encoded)).valid).toBe(false);
    });

    it("salts every hash", async () => {
      const { hasher } = h();
      expect(await hasher.hash("same")).not.toBe(await hasher.hash("same"));
    });

    it("treats canonically equivalent Unicode passwords as equal", async () => {
      const { hasher } = h();
      // Built from code points so no editor or formatter can normalise the fixture away.
      const precomposed = `caf${String.fromCodePoint(0xe9)}-${String.fromCodePoint(0x2460)}`;
      const decomposed = `cafe${String.fromCodePoint(0x301)}-1`;
      const encoded = await hasher.hash(precomposed);
      expect((await hasher.verify(decomposed, encoded)).valid).toBe(true);
    });

    it("never throws on malformed or foreign hashes", async () => {
      const { hasher } = h();
      for (const encoded of [
        "",
        "garbage",
        "$x$y$z$w",
        "$scrypt$$$",
        "$pbkdf2-sha256$i=abc$AA$AA",
      ]) {
        expect(await hasher.verify("pw", encoded), encoded).toEqual({
          valid: false,
          needsRehash: false,
        });
      }
      expect(hasher.supports("garbage")).toBe(false);
    });

    it("rejects oversized passwords", async () => {
      const { hasher } = h();
      const encoded = await hasher.hash("short");
      const huge = "x".repeat(MAX_PASSWORD_BYTES + 1);
      await expect(hasher.hash(huge)).rejects.toThrow(RangeError);
      expect((await hasher.verify(huge, encoded)).valid).toBe(false);
    });
  });
}
