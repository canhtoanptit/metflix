import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode, utf8Decode, utf8Encode } from "../encoding.ts";
import type { TokenSigner } from "../ports/token-signer.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface TokenSignerHarness extends HarnessBase {
  signer: TokenSigner;
  /** The current time in epoch ms as seen by `signer` (to mint unexpired tokens). */
  now(): number;
  /** A signer whose keys `signer` does not know (for `unknown_key`). Optional. */
  foreignSigner?: TokenSigner;
}

/** Contract every `TokenSigner` must pass. */
export function describeTokenSignerContract(
  name: string,
  factory: HarnessFactory<TokenSignerHarness>,
): void {
  describe(`TokenSigner contract: ${name}`, () => {
    const h = useHarness(factory);
    const exp = (secondsFromNow: number) => Math.floor(h().now() / 1000) + secondsFromNow;

    it("round-trips claims and produces URL-path-safe tokens", async () => {
      const { signer } = h();
      const claims = { purpose: "media", exp: exp(600), a: "asset-1", s: "ps-1", n: [1, 2] };
      const token = await signer.sign(claims);
      expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
      const result = await signer.verify(token, "media");
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.claims).toEqual(claims);
    });

    it("rejects tokens minted for another purpose", async () => {
      const { signer } = h();
      const token = await signer.sign({ purpose: "cursor", exp: exp(600) });
      expect(await signer.verify(token, "media")).toEqual({
        valid: false,
        reason: "wrong_purpose",
      });
    });

    it("rejects expired tokens", async () => {
      const { signer } = h();
      const token = await signer.sign({ purpose: "media", exp: exp(-1) });
      expect(await signer.verify(token, "media")).toEqual({ valid: false, reason: "expired" });
    });

    it("rejects tampered claims and signatures", async () => {
      const { signer } = h();
      const token = await signer.sign({ purpose: "media", exp: exp(600), a: "asset-1" });
      const [payload = "", signature = ""] = token.split(".");
      const claims = JSON.parse(utf8Decode(base64UrlDecode(payload))) as Record<string, unknown>;
      const forged = base64UrlEncode(utf8Encode(JSON.stringify({ ...claims, a: "asset-2" })));
      expect(await signer.verify(`${forged}.${signature}`, "media")).toEqual({
        valid: false,
        reason: "bad_signature",
      });
      const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BA" : "AA"}`;
      expect(await signer.verify(`${payload}.${flipped}`, "media")).toEqual({
        valid: false,
        reason: "bad_signature",
      });
    });

    it("rejects malformed tokens without throwing", async () => {
      const { signer } = h();
      for (const token of ["", "abc", "a.b.c", "!!!.???", `${"a".repeat(5000)}.b`]) {
        expect(await signer.verify(token, "media"), token).toEqual({
          valid: false,
          reason: "malformed",
        });
      }
    });

    it("rejects tokens signed with an unknown key", async (context) => {
      const { signer, foreignSigner } = h();
      if (!foreignSigner) return context.skip();
      const token = await foreignSigner.sign({ purpose: "media", exp: exp(600) });
      expect(await signer.verify(token, "media")).toEqual({ valid: false, reason: "unknown_key" });
    });

    it("expires tokens as time passes", async (context) => {
      const { signer, time } = h();
      if (!time) return context.skip();
      const token = await signer.sign({ purpose: "media", exp: exp(60) });
      expect((await signer.verify(token, "media")).valid).toBe(true);
      await time.advance(61_000);
      expect(await signer.verify(token, "media")).toEqual({ valid: false, reason: "expired" });
    });
  });
}
