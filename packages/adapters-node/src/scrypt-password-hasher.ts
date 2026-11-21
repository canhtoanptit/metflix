import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  formatPhc,
  MAX_PASSWORD_BYTES,
  normalizePassword,
  type PasswordHasher,
  parsePhc,
} from "@webflix/core";

const scrypt = promisify(scryptCallback) as (
  password: Uint8Array,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_ID = "scrypt";
/** Largest scrypt working set accepted from a stored hash (128 * N * r bytes). */
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;

export interface ScryptOptions {
  /** log2(N). Default 15 (N = 32768). */
  logN?: number;
  /** Block size. Default 8. */
  r?: number;
  /** Parallelism. Default 3. */
  p?: number;
  keyBytes?: number;
  saltBytes?: number;
}

/**
 * Memory-hard scrypt for Node (dev and k8s). Defaults follow OWASP's equivalent setting
 * N=2^15, r=8, p=3: 32 MiB per hash, so a small pod survives concurrent sign-ins.
 * PHC format: `$scrypt$ln=15,r=8,p=3$<salt>$<hash>`.
 */
export function createScryptPasswordHasher(options: ScryptOptions = {}): PasswordHasher {
  const logN = options.logN ?? 15;
  const r = options.r ?? 8;
  const p = options.p ?? 3;
  const keyBytes = options.keyBytes ?? 32;
  const saltBytes = options.saltBytes ?? 16;

  const derive = (
    password: Uint8Array,
    salt: Uint8Array,
    ln: number,
    rr: number,
    pp: number,
    length: number,
  ) =>
    scrypt(password, salt, length, {
      N: 2 ** ln,
      r: rr,
      p: pp,
      // Node's default cap (32 MiB) is exactly the requirement; leave headroom.
      maxmem: 2 * 128 * 2 ** ln * rr,
    });

  return {
    algorithm: SCRYPT_ID,

    supports(encoded) {
      return parsePhc(encoded)?.id === SCRYPT_ID;
    },

    async hash(password) {
      const normalized = normalizePassword(password);
      if (normalized.byteLength > MAX_PASSWORD_BYTES) throw new RangeError("Password too long");
      const salt = randomBytes(saltBytes);
      const hash = await derive(normalized, salt, logN, r, p, keyBytes);
      return formatPhc({
        id: SCRYPT_ID,
        params: { ln: String(logN), r: String(r), p: String(p) },
        salt: new Uint8Array(salt),
        hash: new Uint8Array(hash),
      });
    },

    async verify(password, encoded) {
      const invalid = { valid: false, needsRehash: false };
      const phc = parsePhc(encoded);
      if (!phc || phc.id !== SCRYPT_ID) return invalid;
      const [ln, rr, pp] = [phc.params.ln, phc.params.r, phc.params.p].map(Number);
      const integer = (value: number | undefined, min: number, max: number): value is number =>
        value !== undefined && Number.isInteger(value) && value >= min && value <= max;
      if (!integer(ln, 1, 20) || !integer(rr, 1, 32) || !integer(pp, 1, 16)) return invalid;
      // A tampered row must not make one verify allocate gigabytes.
      if (128 * 2 ** ln * rr > MAX_SCRYPT_MEMORY_BYTES || phc.hash.byteLength === 0) return invalid;
      const normalized = normalizePassword(password);
      if (normalized.byteLength > MAX_PASSWORD_BYTES) return invalid;
      let candidate: Buffer;
      try {
        candidate = await derive(normalized, phc.salt, ln, rr, pp, phc.hash.byteLength);
      } catch {
        // Parameter combinations Node rejects (e.g. p * r too large) are simply invalid hashes.
        return invalid;
      }
      const valid = timingSafeEqual(candidate, phc.hash);
      const weaker = ln < logN || rr < r || pp < p || phc.hash.byteLength < keyBytes;
      return { valid, needsRehash: valid && weaker };
    },
  };
}
