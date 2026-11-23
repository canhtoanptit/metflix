import { createProblem } from "@webflix/contracts";
import type { CoreConfig } from "@webflix/core";
import { problemResponse } from "@webflix/http";
import { CONSOLE_BASE } from "./spa.ts";

/** Where the console reads its settings (apps/admin/server/console-config.ts). */
export const CONSOLE_CONFIG_PATH = `${CONSOLE_BASE}config.json`;
/** The scopes the console asks for (apps/admin's default; no setting needs to change them). */
export const CONSOLE_SCOPE = "openid profile email";
/** The development staff issuer this Worker mounts outside production, as a path on its origin. */
export const DEVELOPMENT_STAFF_ISSUER = "/dev-idp/staff";

/**
 * The issuer the console signs in with: `WEBFLIX_STAFF_ISSUER`, else, outside production, the
 * development issuer this Worker serves; null in production without one.
 */
export function consoleIssuer(core: Pick<CoreConfig, "admin" | "environment">): string | null {
  return (
    core.admin.staffIssuer ?? (core.environment === "production" ? null : DEVELOPMENT_STAFF_ISSUER)
  );
}

/**
 * `/admin/config.json`, the staff console's settings (`{issuer, clientId, scope}`), from the same
 * configuration the staff API verifies tokens with, so the two can never disagree: the issuer is
 * `WEBFLIX_STAFF_ISSUER`, else, outside production, the development issuer this Worker serves;
 * the client is `WEBFLIX_STAFF_CLIENT_ID`. The build's own `config.json` is not staged: this
 * answer replaces it, as apps/admin's README asks of a platform, and is never cached.
 *
 * Production without a staff issuer (the shipped configuration: the staff API admits nobody until
 * one is set) answers 503 saying so; the console shows that its settings could not be loaded.
 */
export function consoleConfigResponse(core: Pick<CoreConfig, "admin" | "environment">): Response {
  const { admin } = core;
  const issuer = consoleIssuer(core);
  if (issuer === null) {
    const problem = problemResponse(
      createProblem("service_unavailable", {
        detail:
          "No staff issuer is configured (WEBFLIX_STAFF_VERIFIER=oidc and WEBFLIX_STAFF_ISSUER): the staff console cannot sign anyone in.",
      }),
    );
    const headers = new Headers(problem.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(problem.body, { status: problem.status, headers });
  }
  return new Response(
    JSON.stringify({ issuer, clientId: admin.staffClientId, scope: CONSOLE_SCOPE }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
