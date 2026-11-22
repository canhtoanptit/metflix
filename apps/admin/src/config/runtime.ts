/**
 * The console's deployment settings, read at start from `config.json` next to `index.html`
 * (written by the build, replaceable by the platform: apps/admin/server/console-config.ts).
 * Everything here is public: the issuer's address, the console's public client id, the scopes.
 */
export interface RuntimeConfig {
  /** The staff issuer, exactly as it signs `iss`. */
  issuer: string;
  clientId: string;
  scope: string;
  /** The console's base path, `/admin/`-shaped. */
  base: string;
  /** Where the issuer sends the browser back with a code (registered with the issuer). */
  redirectUri: string;
  /** Where the issuer sends the browser after signing out (registered with the issuer). */
  postLogoutRedirectUri: string;
  /** The issuer is the development stand-in the API mounts outside production. */
  development: boolean;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** The base path the bundle was built for (`/admin/`). */
export function consoleBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

/** Validate a parsed `config.json` against the page's origin. */
export function parseRuntimeConfig(raw: unknown, origin: string, base: string): RuntimeConfig {
  if (typeof raw !== "object" || raw === null)
    throw new ConfigError("config.json is not an object");
  const record = raw as Record<string, unknown>;
  const issuerValue = typeof record.issuer === "string" ? record.issuer.trim() : "";
  const clientId = typeof record.clientId === "string" ? record.clientId.trim() : "";
  const scope = typeof record.scope === "string" ? record.scope.trim() : "openid profile email";
  if (!issuerValue) throw new ConfigError("config.json names no staff issuer");
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(clientId)) {
    throw new ConfigError("config.json names no valid client id");
  }
  if (!scope.split(/\s+/).includes("openid"))
    throw new ConfigError("The scope must include openid");
  let issuer: string;
  try {
    // A path is the development issuer on this origin; anything else must be absolute.
    issuer = new URL(issuerValue, origin).href.replace(/\/+$/, "");
  } catch {
    throw new ConfigError(`The staff issuer is not a URL: ${issuerValue}`);
  }
  const issuerUrl = new URL(issuer);
  const local = issuerUrl.hostname === "localhost" || issuerUrl.hostname === "127.0.0.1";
  if (issuerUrl.protocol !== "https:" && !local) {
    throw new ConfigError("The staff issuer must use https");
  }
  return {
    issuer,
    clientId,
    scope: scope.replace(/\s+/g, " "),
    base,
    redirectUri: `${origin}${base}auth/callback`,
    postLogoutRedirectUri: `${origin}${base}`,
    development: issuerUrl.origin === origin && issuerUrl.pathname.startsWith("/dev-idp/"),
  };
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const base = consoleBase();
  let response: Response;
  try {
    response = await fetch(`${base}config.json`, { cache: "no-store", credentials: "omit" });
  } catch {
    throw new ConfigError("The console's settings could not be loaded (network error)");
  }
  if (!response.ok) {
    throw new ConfigError(`The console's settings could not be loaded (${response.status})`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ConfigError("The console's settings are not valid JSON");
  }
  return parseRuntimeConfig(raw, window.location.origin, base);
}
