import { OIDC_PROVIDERS, type OidcProvider } from "@webflix/contracts";
import { type AreaConfigInput, type AreaConfigResult, choice, secret } from "../config.ts";

/** `memory` is the in-process stand-in; `oidc` the generic relying party (identity area). */
export const IDENTITY_PROVIDER_ADAPTERS = ["memory", "oidc"] as const;
/** `memory`: the dev mailbox; `smtp` (Mailpit on kind), `http` (a provider), `outbox` (D1). */
export const EMAIL_SENDER_ADAPTERS = ["memory", "smtp", "http", "outbox"] as const;

/** Portable identity and email settings (milestone 2 §4, §8.2). Owned by the identity area. */
export interface IdentityAreaConfig {
  identityProvider: (typeof IDENTITY_PROVIDER_ADAPTERS)[number];
  /** Consumer issuers offered, in the order of the sign-in buttons. */
  oidcProviders: OidcProvider[];
  emailSender: (typeof EMAIL_SENDER_ADAPTERS)[number];
  emailFrom: string;
  /**
   * Seals the development issuer's codes and sessions; every replica or isolate of a
   * deployment must share it. Null: random per instance (one process only).
   */
  devIdpSecret: string | null;
}

/**
 * Variables: WEBFLIX_IDENTITY_PROVIDER (default memory), WEBFLIX_OIDC_PROVIDERS (comma list,
 * default google,apple), WEBFLIX_EMAIL_SENDER (default memory), WEBFLIX_EMAIL_FROM,
 * WEBFLIX_DEV_IDP_SECRET (32+ characters).
 */
export function loadIdentityConfig(input: AreaConfigInput): AreaConfigResult<IdentityAreaConfig> {
  const issues: string[] = [];
  const providers = (input.vars.WEBFLIX_OIDC_PROVIDERS ?? "google,apple")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = providers.filter(
    (entry) => !(OIDC_PROVIDERS as readonly string[]).includes(entry),
  );
  if (unknown.length > 0) {
    issues.push(
      `WEBFLIX_OIDC_PROVIDERS: unknown ${unknown.join(", ")} (expected ${OIDC_PROVIDERS.join(", ")})`,
    );
  }
  return {
    config: {
      identityProvider: choice(
        input,
        "WEBFLIX_IDENTITY_PROVIDER",
        IDENTITY_PROVIDER_ADAPTERS,
        "memory",
        issues,
      ),
      oidcProviders: [
        ...new Set(
          providers.filter((entry): entry is OidcProvider =>
            (OIDC_PROVIDERS as readonly string[]).includes(entry),
          ),
        ),
      ],
      emailSender: choice(input, "WEBFLIX_EMAIL_SENDER", EMAIL_SENDER_ADAPTERS, "memory", issues),
      emailFrom: input.vars.WEBFLIX_EMAIL_FROM ?? "Webflix <no-reply@webflix.dev>",
      devIdpSecret: secret(input, "WEBFLIX_DEV_IDP_SECRET", 32, issues),
    },
    issues,
  };
}
