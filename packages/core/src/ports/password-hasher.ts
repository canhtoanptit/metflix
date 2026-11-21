import {
  base64Decode,
  base64Encode,
  randomBytes,
  timingSafeEqual,
  utf8Encode,
} from "../encoding.ts";

export interface PasswordVerification {
  valid: boolean;
  /** The hash is valid but was made with an older algorithm or weaker parameters. */
  needsRehash: boolean;
}

/**
 * Port: password hashing. Stored hashes are self-describing PHC strings
 * (`$<algorithm>$<params>$<salt>$<hash>`), so a deployment can verify hashes made by another
 * algorithm and upgrade them on login (`needsRehash`).
 *
 * Per runtime (blueprint §2.1): Node uses memory-hard scrypt (`@webflix/adapters-node`);
 * Workers use PBKDF2-SHA256 on WebCrypto (no memory-hard KDF is native there). The portable
 * PBKDF2 hasher below runs everywhere, so a hash made in any mode verifies in every mode.
 * CPU: ~40 ms per hash at the default 600 000 iterations; Workers Free (10 ms CPU) cannot run
 * any sensible KDF, so the Cloudflare mode needs Workers Paid.
 */
export interface PasswordHasher {
  /** PHC identifier this hasher produces, e.g. `scrypt`, `pbkdf2-sha256`. */
  readonly algorithm: string;
  /** True when `encoded` is a hash this hasher can verify. */
  supports(encoded: string): boolean;
  hash(password: string): Promise<string>;
  /** Never throws for wrong or malformed input; returns `valid: false`. */
  verify(password: string, encoded: string): Promise<PasswordVerification>;
}

/** Longest accepted password, in UTF-8 bytes after normalisation (DoS guard). */
export const MAX_PASSWORD_BYTES = 1024;

/** NFKC so that visually identical passwords typed on different keyboards match. */
export function normalizePassword(password: string): Uint8Array<ArrayBuffer> {
  return utf8Encode(password.normalize("NFKC"));
}

export interface PhcHash {
  id: string;
  params: Record<string, string>;
  salt: Uint8Array<ArrayBuffer>;
  hash: Uint8Array<ArrayBuffer>;
}

export function formatPhc(phc: PhcHash): string {
  const params = Object.entries(phc.params)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `$${phc.id}$${params}$${base64Encode(phc.salt)}$${base64Encode(phc.hash)}`;
}

/** Parses `$id$k=v,k=v$salt$hash`; returns null for anything else. */
export function parsePhc(encoded: string): PhcHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "") return null;
  const [, id, rawParams, salt, hash] = parts;
  if (!id || rawParams === undefined || !salt || !hash) return null;
  const params: Record<string, string> = {};
  for (const pair of rawParams.split(",")) {
    const [key, value, extra] = pair.split("=");
    if (!key || value === undefined || extra !== undefined) return null;
    params[key] = value;
  }
  try {
    return { id, params, salt: base64Decode(salt), hash: base64Decode(hash) };
  } catch {
    return null;
  }
}

/** Largest PBKDF2 iteration count workerd accepts. */
/** OWASP (2023) recommendation for PBKDF2-HMAC-SHA256. */
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;
/**
 * Upper bound accepted from a stored hash: a DoS guard against tampered rows, not a runtime
 * limit (current workerd accepts any count; older workerd capped PBKDF2 at 100 000).
 */
export const PBKDF2_MAX_ITERATIONS = 10_000_000;

const PBKDF2_ID = "pbkdf2-sha256";

/**
 * PBKDF2-HMAC-SHA256 on WebCrypto. Not memory-hard; it exists because it is the strongest KDF
 * Workers provide natively. Defaults to `PBKDF2_DEFAULT_ITERATIONS`.
 */
export function createPbkdf2PasswordHasher(
  options: { iterations?: number; saltBytes?: number; keyBytes?: number } = {},
): PasswordHasher {
  const iterations = options.iterations ?? PBKDF2_DEFAULT_ITERATIONS;
  const saltBytes = options.saltBytes ?? 16;
  const keyBytes = options.keyBytes ?? 32;
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError(`iterations must be an integer in 1..${PBKDF2_MAX_ITERATIONS}`);
  }

  const derive = async (
    password: Uint8Array<ArrayBuffer>,
    salt: Uint8Array<ArrayBuffer>,
    rounds: number,
    length: number,
  ) => {
    const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds },
      key,
      length * 8,
    );
    return new Uint8Array(bits);
  };

  return {
    algorithm: PBKDF2_ID,

    supports(encoded) {
      return parsePhc(encoded)?.id === PBKDF2_ID;
    },

    async hash(password) {
      const normalized = normalizePassword(password);
      if (normalized.byteLength > MAX_PASSWORD_BYTES) throw new RangeError("Password too long");
      const salt = randomBytes(saltBytes);
      const hash = await derive(normalized, salt, iterations, keyBytes);
      return formatPhc({ id: PBKDF2_ID, params: { i: String(iterations) }, salt, hash });
    },

    async verify(password, encoded) {
      const invalid = { valid: false, needsRehash: false };
      const phc = parsePhc(encoded);
      const rounds = Number(phc?.params.i);
      if (!phc || phc.id !== PBKDF2_ID || !Number.isSafeInteger(rounds) || rounds < 1) {
        return invalid;
      }
      if (rounds > PBKDF2_MAX_ITERATIONS) return invalid;
      const normalized = normalizePassword(password);
      if (normalized.byteLength > MAX_PASSWORD_BYTES || phc.hash.byteLength === 0) return invalid;
      const candidate = await derive(normalized, phc.salt, rounds, phc.hash.byteLength);
      const valid = timingSafeEqual(candidate, phc.hash);
      return {
        valid,
        needsRehash: valid && (rounds < iterations || phc.hash.byteLength < keyBytes),
      };
    },
  };
}

/**
 * Hash with `primary`; verify with whichever hasher supports the stored hash. Hashes from a
 * non-primary hasher report `needsRehash` so callers upgrade them after a successful login.
 */
export function createPasswordHasherChain(
  primary: PasswordHasher,
  ...fallbacks: PasswordHasher[]
): PasswordHasher {
  const all = [primary, ...fallbacks];
  return {
    algorithm: primary.algorithm,
    supports: (encoded) => all.some((hasher) => hasher.supports(encoded)),
    hash: (password) => primary.hash(password),
    async verify(password, encoded) {
      const hasher = all.find((candidate) => candidate.supports(encoded));
      if (!hasher) return { valid: false, needsRehash: false };
      const result = await hasher.verify(password, encoded);
      return {
        valid: result.valid,
        needsRehash: result.valid && (hasher !== primary || result.needsRehash),
      };
    },
  };
}
