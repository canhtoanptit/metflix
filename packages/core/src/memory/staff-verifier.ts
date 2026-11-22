import { STAFF_API_AUDIENCE } from "@webflix/contracts";
import {
  base64UrlDecode,
  base64UrlEncode,
  randomBytes,
  timingSafeEqual,
  utf8Decode,
  utf8Encode,
} from "../encoding.ts";
import { type Clock, systemClock } from "../ports/clock.ts";
import {
  mapStaffRoles,
  type StaffIdentity,
  StaffTokenError,
  type StaffVerifier,
} from "../ports/staff-verifier.ts";

/** Claims of a staff token minted by `MemoryStaffVerifier.mint` (Keycloak's shape). */
export interface MemoryStaffToken {
  subject: string;
  name?: string | null;
  email?: string | null;
  /** `resource_access.<client>.roles`. */
  clientRoles?: Record<string, string[]>;
  /** `realm_access.roles` (noise a role mapping must ignore). */
  realmRoles?: string[];
  /** Default 300 (negative: already expired). */
  expiresInSec?: number;
  /** Seconds from now the token becomes valid (`nbf`, `iat`); default 0. */
  notBeforeSec?: number;
  audience?: string | string[];
  issuer?: string;
  /** `access` (default) or `id` (an ID token presented as an access token). */
  tokenType?: "access" | "id";
}

const PREFIX = "wfx-staff";
const SKEW_SEC = 60;

/**
 * In-process `StaffVerifier` with its own issuer: tokens are HMAC-SHA256 signed claims (Web
 * Crypto), so every check the JWKS adapter makes (signature, issuer, audience, type, time) is
 * made here too. `mint` is the issuer's side, for tests and local tooling.
 */
export class MemoryStaffVerifier implements StaffVerifier {
  readonly issuer: string;
  private readonly audience: string;
  private readonly clock: Clock;
  private readonly key: Promise<CryptoKey>;

  constructor(
    options: { issuer?: string; audience?: string; clock?: Clock; secret?: Uint8Array } = {},
  ) {
    this.issuer = options.issuer ?? "https://memory-idp.test/staff";
    this.audience = options.audience ?? STAFF_API_AUDIENCE;
    this.clock = options.clock ?? systemClock;
    const secret = options.secret ?? randomBytes(32);
    this.key = crypto.subtle.importKey(
      "raw",
      new Uint8Array(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  async mint(token: MemoryStaffToken): Promise<string> {
    const now = Math.floor(this.clock.now() / 1000);
    const notBefore = now + (token.notBeforeSec ?? 0);
    const claims = {
      iss: token.issuer ?? this.issuer,
      aud: token.audience ?? [this.audience, "account"],
      sub: token.subject,
      typ: token.tokenType === "id" ? "ID" : "Bearer",
      azp: "webflix-admin",
      iat: notBefore,
      nbf: notBefore,
      exp: now + (token.expiresInSec ?? 300),
      name: token.name ?? null,
      email: token.email ?? null,
      realm_access: { roles: token.realmRoles ?? ["offline_access", "uma_authorization"] },
      resource_access: Object.fromEntries(
        Object.entries(token.clientRoles ?? {}).map(([client, roles]) => [client, { roles }]),
      ),
    };
    const body = base64UrlEncode(utf8Encode(JSON.stringify(claims)));
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.key,
      utf8Encode(`${PREFIX}.${body}`),
    );
    return `${PREFIX}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  async verify(token: string): Promise<StaffIdentity> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) throw new StaffTokenError("malformed");
    const [, body = "", signature = ""] = parts;
    let expected: Uint8Array;
    let claims: Record<string, unknown>;
    try {
      expected = new Uint8Array(
        await crypto.subtle.sign("HMAC", await this.key, utf8Encode(`${PREFIX}.${body}`)),
      );
      claims = JSON.parse(utf8Decode(base64UrlDecode(body))) as Record<string, unknown>;
    } catch {
      throw new StaffTokenError("malformed");
    }
    let given: Uint8Array;
    try {
      given = base64UrlDecode(signature);
    } catch {
      throw new StaffTokenError("signature");
    }
    if (!timingSafeEqual(given, expected)) throw new StaffTokenError("signature");
    if (claims.iss !== this.issuer) throw new StaffTokenError("issuer");
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(this.audience)) throw new StaffTokenError("audience");
    if (claims.typ !== "Bearer") throw new StaffTokenError("token_type");
    const now = this.clock.now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp <= now - SKEW_SEC) {
      throw new StaffTokenError("expired");
    }
    if (typeof claims.nbf === "number" && claims.nbf > now + SKEW_SEC) {
      throw new StaffTokenError("not_yet_valid");
    }
    if (typeof claims.sub !== "string" || claims.sub === "") throw new StaffTokenError("malformed");
    return {
      subject: claims.sub,
      name: typeof claims.name === "string" ? claims.name : null,
      email: typeof claims.email === "string" ? claims.email : null,
      roles: mapStaffRoles(claims),
      expiresAt: claims.exp * 1000,
    };
  }
}
