/**
 * A minimal browser-like cookie jar for one origin. The suite talks to a single origin (the
 * SPA and the API are always same-origin), so domain and path matching are not modelled; expiry
 * is, because sign-out works by expiring the session cookie.
 */

export interface SetCookie {
  name: string;
  value: string;
  /** Lower-cased attribute names; flag attributes map to "". */
  attributes: Record<string, string>;
}

/** Parse one `Set-Cookie` header value (RFC 6265 §5.2, the parts a single origin needs). */
export function parseSetCookie(header: string): SetCookie | null {
  const [pair = "", ...rest] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  const attributes: Record<string, string> = {};
  for (const part of rest) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const equals = trimmed.indexOf("=");
    const key = (equals === -1 ? trimmed : trimmed.slice(0, equals)).trim().toLowerCase();
    attributes[key] = equals === -1 ? "" : trimmed.slice(equals + 1).trim();
  }
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    attributes,
  };
}

/** Whether a parsed cookie deletes itself (Max-Age ≤ 0 or Expires in the past). */
export function isExpiring(cookie: SetCookie, now = Date.now()): boolean {
  const maxAge = cookie.attributes["max-age"];
  if (maxAge !== undefined && Number(maxAge) <= 0) return true;
  const expires = cookie.attributes.expires;
  if (expires !== undefined) {
    const at = Date.parse(expires);
    if (Number.isFinite(at) && at <= now) return true;
  }
  return false;
}

interface StoredCookie {
  value: string;
  /** Epoch ms; null for a browser-session cookie. */
  expiresAt: number | null;
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();
  /** Every Set-Cookie seen, newest last (for attribute assertions). */
  readonly history: SetCookie[] = [];

  /** Apply the `Set-Cookie` headers of a response. */
  store(setCookieHeaders: readonly string[], now = Date.now()): void {
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header);
      if (!cookie) continue;
      this.history.push(cookie);
      if (isExpiring(cookie, now)) {
        this.cookies.delete(cookie.name);
        continue;
      }
      const maxAge = cookie.attributes["max-age"];
      const expires = cookie.attributes.expires;
      const expiresAt =
        maxAge !== undefined
          ? now + Number(maxAge) * 1000
          : expires !== undefined && Number.isFinite(Date.parse(expires))
            ? Date.parse(expires)
            : null;
      this.cookies.set(cookie.name, { value: cookie.value, expiresAt });
    }
  }

  /** The `Cookie` request header, or null when the jar is empty. */
  header(now = Date.now()): string | null {
    const parts: string[] = [];
    for (const [name, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(name);
        continue;
      }
      parts.push(`${name}=${cookie.value}`);
    }
    return parts.length > 0 ? parts.join("; ") : null;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value;
  }

  set(name: string, value: string): void {
    this.cookies.set(name, { value, expiresAt: null });
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  names(): string[] {
    return [...this.cookies.keys()];
  }

  /** A copy of the current cookies (to replay an old session after sign-out). */
  snapshot(): Map<string, string> {
    return new Map([...this.cookies].map(([name, cookie]) => [name, cookie.value]));
  }

  /** The most recent Set-Cookie for `name` (any attributes), if any. */
  lastSetCookie(name: (candidate: string) => boolean): SetCookie | undefined {
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const cookie = this.history[index];
      if (cookie && name(cookie.name)) return cookie;
    }
    return undefined;
  }
}

/** The session cookie is `webflix_session`, or `__Host-webflix_session` on https origins. */
export function isSessionCookieName(name: string): boolean {
  return name === "webflix_session" || name === "__Host-webflix_session";
}
