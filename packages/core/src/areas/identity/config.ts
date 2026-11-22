import { OIDC_PROVIDERS, type OidcProvider } from "@webflix/contracts";
import { parseMailbox } from "../../ports/email-sender.ts";
import {
  type AreaConfigInput,
  type AreaConfigResult,
  choice,
  positiveInteger,
  secret,
} from "../config.ts";

/**
 * `oidc`: the generic relying party (default): each offered issuer is configured below, and
 * outside production Google and Apple fall back to the development issuer mounted at
 * `/dev-idp/*`. `memory`: no browser-usable issuer (tests inject a `MemoryIdentityProvider`).
 */
export const IDENTITY_PROVIDER_ADAPTERS = ["memory", "oidc"] as const;
/** `memory`: the dev mailbox; `smtp` (Mailpit on kind), `http` (a provider), `outbox` (D1). */
export const EMAIL_SENDER_ADAPTERS = ["memory", "smtp", "http", "outbox"] as const;
/** HTTP email providers the `http` sender speaks (Resend's API: JSON, idempotency keys, Svix-signed webhooks). */
export const EMAIL_HTTP_PROVIDERS = ["resend"] as const;
export const SMTP_TLS_MODES = ["none", "implicit"] as const;

/** How the relying party authenticates to one issuer's token endpoint. */
export type OidcClientSecretConfig =
  | { method: "client_secret_basic" | "client_secret_post"; secret: string }
  | { method: "apple_client_secret"; teamId: string; keyId: string; privateKey: string }
  | { method: "none" };

/** One real issuer's client registration (Google, Apple, Keycloak), from the environment. */
export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  authentication: OidcClientSecretConfig;
  /** Offer a fresh sign-in with this issuer as the account-holder proof (§4.2). */
  reportsAuthTime: boolean;
}

export interface EmailHttpConfig {
  provider: (typeof EMAIL_HTTP_PROVIDERS)[number];
  endpoint: string;
  apiKey: string;
  /** Verifies `POST /webhooks/email/{provider}` (bounces, complaints); null: the webhook is off. */
  webhookSecret: string | null;
}

export interface SmtpConfig {
  host: string;
  port: number;
  tls: (typeof SMTP_TLS_MODES)[number];
  username: string | null;
  password: string | null;
}

/** Portable identity and email settings (milestone 2 §4, §8.2). Owned by the identity area. */
export interface IdentityAreaConfig {
  identityProvider: (typeof IDENTITY_PROVIDER_ADAPTERS)[number];
  /** Consumer issuers offered, in the order of the sign-in buttons. */
  oidcProviders: OidcProvider[];
  /** True when `WEBFLIX_OIDC_PROVIDERS` was set: an offered issuer without a client is an error. */
  oidcProvidersExplicit: boolean;
  /** Client registrations of the real issuers; absent ones use the development issuer outside production. */
  oidcClients: Partial<Record<OidcProvider, OidcClientConfig>>;
  /** Deadline of each call to an issuer (discovery, JWKS, token). */
  oidcTimeoutMs: number;
  /** An unknown signing key refetches the JWKS only when the last fetch is at least this old. */
  oidcJwksRefetchCooldownSec: number;
  emailSender: (typeof EMAIL_SENDER_ADAPTERS)[number];
  emailFrom: string;
  emailHttp: EmailHttpConfig | null;
  smtp: SmtpConfig | null;
  /**
   * Seals the development issuer's codes and sessions; every replica or isolate of a
   * deployment must share it. Null: random per instance (one process only).
   */
  devIdpSecret: string | null;
}

const DEFAULT_ISSUERS: Record<OidcProvider, string | null> = {
  google: "https://accounts.google.com",
  apple: "https://appleid.apple.com",
  keycloak: null,
};

/** A PEM in one environment variable often arrives with literal `\n`. */
function pem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

function issuerUrl(value: string, name: string, issues: string[]): string {
  if (!URL.canParse(value) || new URL(value).hash !== "" || value.endsWith("/")) {
    issues.push(`${name}: expected an issuer URL without a trailing slash`);
  }
  return value;
}

function wholeNumber(
  input: AreaConfigInput,
  name: string,
  fallback: number,
  issues: string[],
): number {
  const value = input.vars[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  issues.push(`${name}: expected a whole number >= 0`);
  return fallback;
}

function flag(input: AreaConfigInput, name: string, fallback: boolean, issues: string[]): boolean {
  const value = input.vars[name];
  if (value === undefined) return fallback;
  if (value === "true" || value === "false") return value === "true";
  issues.push(`${name}: expected true or false`);
  return fallback;
}

function oidcClient(
  input: AreaConfigInput,
  provider: OidcProvider,
  issues: string[],
): OidcClientConfig | null {
  const prefix = `WEBFLIX_OIDC_${provider.toUpperCase()}_`;
  const v = (name: string) => input.vars[`${prefix}${name}`];
  const clientId = v("CLIENT_ID");
  const related = Object.keys(input.vars).filter((name) => name.startsWith(prefix));
  if (clientId === undefined) {
    if (related.length > 0) issues.push(`${prefix}CLIENT_ID: required with ${related.join(", ")}`);
    return null;
  }
  const issuerValue = v("ISSUER") ?? DEFAULT_ISSUERS[provider];
  if (issuerValue === null) {
    issues.push(`${prefix}ISSUER: required for ${provider}`);
    return null;
  }
  const issuer = issuerUrl(issuerValue, `${prefix}ISSUER`, issues);
  let authentication: OidcClientSecretConfig;
  if (provider === "apple") {
    const teamId = v("TEAM_ID");
    const keyId = v("KEY_ID");
    const privateKey = v("PRIVATE_KEY");
    if (!teamId || !keyId || !privateKey) {
      issues.push(
        `${prefix}TEAM_ID, ${prefix}KEY_ID and ${prefix}PRIVATE_KEY are required for Apple`,
      );
      return null;
    }
    authentication = { method: "apple_client_secret", teamId, keyId, privateKey: pem(privateKey) };
  } else {
    const clientSecret = secret(input, `${prefix}CLIENT_SECRET`, 16, issues);
    authentication =
      clientSecret === null
        ? { method: "none" }
        : { method: "client_secret_basic", secret: clientSecret };
    if (provider === "google" && clientSecret === null) {
      issues.push(`${prefix}CLIENT_SECRET: required for Google`);
    }
  }
  return {
    issuer,
    clientId,
    authentication,
    // Keycloak always sends auth_time; Google's discovery does not promise it, and Apple's
    // behaviour under max_age is unverified: both fail closed until the owner checks (§4.2).
    reportsAuthTime: flag(input, `${prefix}REPORTS_AUTH_TIME`, provider === "keycloak", issues),
  };
}

/**
 * Variables (docs/BACKEND.md §4): WEBFLIX_IDENTITY_PROVIDER (default oidc), WEBFLIX_OIDC_PROVIDERS
 * (comma list, default google,apple), WEBFLIX_OIDC_<PROVIDER>_{ISSUER, CLIENT_ID, CLIENT_SECRET,
 * TEAM_ID, KEY_ID, PRIVATE_KEY, REPORTS_AUTH_TIME}, WEBFLIX_OIDC_TIMEOUT_MS,
 * WEBFLIX_OIDC_JWKS_REFETCH_COOLDOWN_SEC, WEBFLIX_EMAIL_SENDER
 * (default memory), WEBFLIX_EMAIL_FROM, WEBFLIX_EMAIL_HTTP_{PROVIDER, URL, API_KEY},
 * WEBFLIX_EMAIL_WEBHOOK_SECRET, WEBFLIX_SMTP_{HOST, PORT, TLS, USERNAME, PASSWORD},
 * WEBFLIX_DEV_IDP_SECRET (32+ characters).
 */
export function loadIdentityConfig(input: AreaConfigInput): AreaConfigResult<IdentityAreaConfig> {
  const issues: string[] = [];
  const listed = input.vars.WEBFLIX_OIDC_PROVIDERS;
  const providers = (listed ?? "google,apple")
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
  const oidcClients: Partial<Record<OidcProvider, OidcClientConfig>> = {};
  for (const provider of OIDC_PROVIDERS) {
    const client = oidcClient(input, provider, issues);
    if (client) oidcClients[provider] = client;
  }

  const emailSender = choice(
    input,
    "WEBFLIX_EMAIL_SENDER",
    EMAIL_SENDER_ADAPTERS,
    "memory",
    issues,
  );
  const emailFrom = input.vars.WEBFLIX_EMAIL_FROM ?? "Webflix <no-reply@webflix.dev>";
  if (parseMailbox(emailFrom) === null) {
    issues.push("WEBFLIX_EMAIL_FROM: expected an address or Name <address> on one line");
  }

  let emailHttp: EmailHttpConfig | null = null;
  if (emailSender === "http") {
    const apiKey = secret(input, "WEBFLIX_EMAIL_HTTP_API_KEY", 8, issues);
    const endpoint = input.vars.WEBFLIX_EMAIL_HTTP_URL ?? "https://api.resend.com/emails";
    if (!URL.canParse(endpoint)) issues.push("WEBFLIX_EMAIL_HTTP_URL: expected a URL");
    if (apiKey === null)
      issues.push("WEBFLIX_EMAIL_HTTP_API_KEY: required for WEBFLIX_EMAIL_SENDER=http");
    else {
      emailHttp = {
        provider: choice(
          input,
          "WEBFLIX_EMAIL_HTTP_PROVIDER",
          EMAIL_HTTP_PROVIDERS,
          "resend",
          issues,
        ),
        endpoint,
        apiKey,
        webhookSecret: secret(input, "WEBFLIX_EMAIL_WEBHOOK_SECRET", 16, issues),
      };
    }
  }

  let smtp: SmtpConfig | null = null;
  if (emailSender === "smtp") {
    const host = input.vars.WEBFLIX_SMTP_HOST;
    if (!host) issues.push("WEBFLIX_SMTP_HOST: required for WEBFLIX_EMAIL_SENDER=smtp");
    const tls = choice(input, "WEBFLIX_SMTP_TLS", SMTP_TLS_MODES, "none", issues);
    const username = input.vars.WEBFLIX_SMTP_USERNAME ?? null;
    const password = input.vars.WEBFLIX_SMTP_PASSWORD ?? null;
    if ((username === null) !== (password === null)) {
      issues.push("WEBFLIX_SMTP_USERNAME and WEBFLIX_SMTP_PASSWORD go together");
    }
    if (username !== null && tls === "none") {
      issues.push(
        "WEBFLIX_SMTP_USERNAME: credentials are only sent over TLS (WEBFLIX_SMTP_TLS=implicit)",
      );
    }
    if (host) {
      smtp = {
        host,
        port: positiveInteger(input, "WEBFLIX_SMTP_PORT", tls === "implicit" ? 465 : 1025, issues),
        tls,
        username,
        password,
      };
    }
  }

  return {
    config: {
      identityProvider: choice(
        input,
        "WEBFLIX_IDENTITY_PROVIDER",
        IDENTITY_PROVIDER_ADAPTERS,
        "oidc",
        issues,
      ),
      oidcProviders: [
        ...new Set(
          providers.filter((entry): entry is OidcProvider =>
            (OIDC_PROVIDERS as readonly string[]).includes(entry),
          ),
        ),
      ],
      oidcProvidersExplicit: listed !== undefined,
      oidcClients,
      oidcTimeoutMs: positiveInteger(input, "WEBFLIX_OIDC_TIMEOUT_MS", 5000, issues),
      oidcJwksRefetchCooldownSec: wholeNumber(
        input,
        "WEBFLIX_OIDC_JWKS_REFETCH_COOLDOWN_SEC",
        10,
        issues,
      ),
      emailSender,
      emailFrom,
      emailHttp,
      smtp,
      devIdpSecret: secret(input, "WEBFLIX_DEV_IDP_SECRET", 32, issues),
    },
    issues,
  };
}
