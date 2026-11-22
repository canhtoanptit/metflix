/**
 * The issuer's signing keys and their life cycle. Per algorithm there is one `current` key
 * (signs), a `next` key (published ahead of use, so a relying party that cached the JWKS before a
 * rotation still knows it), `previous` keys (published until what they signed has expired),
 * `late` keys (published the moment one fault-injected token is signed with them; never sign
 * otherwise) and `retired` keys (no longer published; kept only so a fault can sign with one).
 */
import {
  assertPrivateSigningJwk,
  generateSigningJwk,
  importSigningKey,
  importVerificationKey,
  type Jwk,
  type PrivateSigningJwk,
  type SigningAlgorithm,
  toPublicJwk,
} from "./jose.ts";

export type KeyStatus = "current" | "next" | "previous" | "late" | "retired";

export interface RingKey {
  readonly jwk: PrivateSigningJwk;
  status: KeyStatus;
}

/** A key handed to the issuer: its status defaults to `current` for the first key of each alg, `next` otherwise. */
export interface SigningKeyInput {
  jwk: PrivateSigningJwk;
  status?: KeyStatus;
}

const PUBLISH_ORDER: Record<KeyStatus, number> = {
  current: 0,
  next: 1,
  previous: 2,
  late: 3,
  retired: 4,
};

/** Late keys kept published per algorithm; older ones are retired. */
const MAX_LATE_KEYS = 2;

export class KeyRing {
  private readonly entries: RingKey[] = [];
  // Imported keys by kid, cached once imported (never a pending import shared between requests).
  private readonly signing = new Map<string, CryptoKey>();
  private readonly verifying = new Map<string, CryptoKey>();

  constructor(keys: readonly SigningKeyInput[]) {
    const seen = new Set<SigningAlgorithm>();
    for (const input of keys) {
      assertPrivateSigningJwk(input.jwk);
      if (this.find(input.jwk.kid)) throw new Error(`Duplicate signing key id ${input.jwk.kid}`);
      const status = input.status ?? (seen.has(input.jwk.alg) ? "next" : "current");
      if (status === "current" && this.currentEntry(input.jwk.alg)) {
        throw new Error(`More than one current ${input.jwk.alg} key`);
      }
      if (status === "current") seen.add(input.jwk.alg);
      this.entries.push({ jwk: input.jwk, status });
    }
  }

  algorithms(): SigningAlgorithm[] {
    return this.entries.filter((entry) => entry.status === "current").map((entry) => entry.jwk.alg);
  }

  current(alg: SigningAlgorithm): PrivateSigningJwk {
    const entry = this.currentEntry(alg);
    if (!entry) throw new Error(`No current ${alg} signing key`);
    return entry.jwk;
  }

  find(kid: string): RingKey | undefined {
    return this.entries.find((entry) => entry.jwk.kid === kid);
  }

  /** The newest retired key for `alg`, if any. */
  retired(alg: SigningAlgorithm): PrivateSigningJwk | undefined {
    return this.entries.findLast((entry) => entry.status === "retired" && entry.jwk.alg === alg)
      ?.jwk;
  }

  /** The JWKS: every key that is not retired, signing keys first. Public members only. */
  publicKeys(): Jwk[] {
    return this.entries
      .filter((entry) => entry.status !== "retired")
      .sort((a, b) => PUBLISH_ORDER[a.status] - PUBLISH_ORDER[b.status])
      .map((entry) => toPublicJwk(entry.jwk));
  }

  snapshot(): Array<{ kid: string; alg: SigningAlgorithm; status: KeyStatus }> {
    return this.entries.map((entry) => ({
      kid: entry.jwk.kid,
      alg: entry.jwk.alg,
      status: entry.status,
    }));
  }

  async signingKey(jwk: PrivateSigningJwk): Promise<CryptoKey> {
    const cached = this.signing.get(jwk.kid);
    if (cached) return cached;
    const key = await importSigningKey(jwk);
    this.signing.set(jwk.kid, key);
    return key;
  }

  /** A verification key for a key this ring published (or retired), or undefined. */
  async verificationKey(kid: string, alg: SigningAlgorithm): Promise<CryptoKey | undefined> {
    const entry = this.find(kid);
    if (!entry || entry.jwk.alg !== alg) return undefined;
    const cached = this.verifying.get(kid);
    if (cached) return cached;
    const key = await importVerificationKey(entry.jwk, alg);
    this.verifying.set(kid, key);
    return key;
  }

  /**
   * Rotates `alg`: `next` starts signing, the old `current` stays published as `previous`, the
   * older `previous` keys are retired, and a freshly generated key is published as `next`.
   * Returns the kid that signs from now on.
   */
  async rotate(alg: SigningAlgorithm): Promise<string> {
    const generated = await generateSigningJwk(alg);
    for (const entry of this.entries) {
      if (entry.jwk.alg !== alg) continue;
      if (entry.status === "previous") entry.status = "retired";
    }
    const current = this.currentEntry(alg);
    const next = this.entries.find((entry) => entry.jwk.alg === alg && entry.status === "next");
    if (current) current.status = "previous";
    if (next) {
      next.status = "current";
      this.entries.push({ jwk: generated, status: "next" });
      return next.jwk.kid;
    }
    this.entries.push({ jwk: generated, status: "current" });
    return generated.kid;
  }

  /**
   * A fresh key, published from now on, for one token: what a relying party sees when an issuer
   * rotates between the relying party's last JWKS fetch and the token it validates. The signing
   * key of every other token stays `current`; at most two late keys per algorithm stay published.
   */
  async publishLate(alg: SigningAlgorithm): Promise<PrivateSigningJwk> {
    const generated = await generateSigningJwk(alg);
    this.entries.push({ jwk: generated, status: "late" });
    const late = this.entries.filter((entry) => entry.jwk.alg === alg && entry.status === "late");
    for (const entry of late.slice(0, Math.max(0, late.length - MAX_LATE_KEYS))) {
      entry.status = "retired";
    }
    return generated;
  }

  /** Adds a key that is known but not published (fault `removedKey` on a ring without one). */
  addRetired(jwk: PrivateSigningJwk): void {
    assertPrivateSigningJwk(jwk);
    if (!this.find(jwk.kid)) this.entries.push({ jwk, status: "retired" });
  }

  /** Removes a key from the JWKS. Retiring the current key promotes `next` (or fails without one). */
  retire(kid: string): void {
    const entry = this.find(kid);
    if (!entry) throw new Error(`Unknown key ${kid}`);
    if (entry.status === "current") {
      const next = this.entries.find(
        (candidate) => candidate.jwk.alg === entry.jwk.alg && candidate.status === "next",
      );
      if (!next)
        throw new Error(`Cannot retire the current ${entry.jwk.alg} key without a next key`);
      next.status = "current";
    }
    entry.status = "retired";
  }

  private currentEntry(alg: SigningAlgorithm): RingKey | undefined {
    return this.entries.find((entry) => entry.jwk.alg === alg && entry.status === "current");
  }
}
