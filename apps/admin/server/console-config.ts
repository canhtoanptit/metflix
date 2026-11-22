/**
 * The console's deployment settings, read from the environment by the dev server and the build
 * (vite.config.ts). The browser never sees an environment variable: it reads `config.json` next
 * to `index.html`, which the dev server answers from these values and the build writes once. A
 * platform that serves one bundle in several environments replaces that file (same three keys)
 * and serves it with `Cache-Control: no-store`.
 *
 *   WEBFLIX_ADMIN_BASE        path the console is served under (default `/admin/`); the staff
 *                             issuer's registered redirect is `{origin}{base}auth/callback`
 *   WEBFLIX_ADMIN_ISSUER      the staff issuer, exactly as it signs `iss` (a Keycloak realm URL),
 *                             or a path on the console's own origin (default `/dev-idp/staff`,
 *                             the development issuer the API mounts outside production)
 *   WEBFLIX_ADMIN_CLIENT_ID   the console's public OpenID client (default `webflix-admin`)
 *   WEBFLIX_ADMIN_SCOPE       scopes asked for (default `openid profile email`)
 */
export interface ConsoleConfig {
  issuer: string;
  clientId: string;
  scope: string;
}

export const DEFAULT_ISSUER = "/dev-idp/staff";
export const DEFAULT_CLIENT_ID = "webflix-admin";
export const DEFAULT_SCOPE = "openid profile email";

type Env = Record<string, string | undefined>;

/** `/admin/`-shaped: leading and trailing slash, nothing else. */
export function consoleBase(env: Env): string {
  const raw = (env.WEBFLIX_ADMIN_BASE ?? "/admin/").trim() || "/admin/";
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

export function consoleConfig(env: Env): ConsoleConfig {
  const issuer = (env.WEBFLIX_ADMIN_ISSUER ?? DEFAULT_ISSUER).trim().replace(/\/+$/, "");
  if (!/^(?:https?:\/\/[^/\s]+(?:\/\S*)?|\/\S+)$/.test(issuer)) {
    throw new Error(
      `WEBFLIX_ADMIN_ISSUER must be an http(s) URL or an absolute path, got ${JSON.stringify(issuer)}`,
    );
  }
  const clientId = (env.WEBFLIX_ADMIN_CLIENT_ID ?? DEFAULT_CLIENT_ID).trim();
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(clientId)) {
    throw new Error(
      `WEBFLIX_ADMIN_CLIENT_ID is not a valid client id: ${JSON.stringify(clientId)}`,
    );
  }
  const scope = (env.WEBFLIX_ADMIN_SCOPE ?? DEFAULT_SCOPE).trim().replace(/\s+/g, " ");
  if (!scope.split(" ").includes("openid")) {
    throw new Error("WEBFLIX_ADMIN_SCOPE must include openid");
  }
  return { issuer, clientId, scope };
}
