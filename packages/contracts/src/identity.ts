/**
 * Milestone 2 sign-in (docs/BLUEPRINT-M2.md §4): federation through OpenID Connect, linked
 * identities, the account-holder proof, email verification and password reset. Provider facts
 * the relying party must handle are in packages/dev-idp/README.md.
 */
import * as z from "zod";
import { EmailAddress, Password } from "./account.ts";
import { IsoDateTime } from "./common.ts";
import {
  EMAIL_TEMPLATES,
  OIDC_INTENTS,
  OIDC_PROVIDERS,
  PASSWORD_MAX_LENGTH,
  REAUTH_METHODS,
} from "./constants.ts";

export const OidcProviderId = z.enum(OIDC_PROVIDERS).meta({ id: "OidcProviderId" });
export type OidcProviderId = z.output<typeof OidcProviderId>;

export const OidcProviderParams = z.object({ provider: OidcProviderId });

/**
 * A same-origin path to return to after a navigation (never `//host`, never a scheme, never a
 * backslash: an open redirect otherwise).
 */
export const ReturnPath = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[^\s\\]*$/, "Expected a same-origin path");

export const OidcStartQuery = z.object({
  /** Default `signin`. `link` and `reauth` need a signed-in session. */
  intent: z.enum(OIDC_INTENTS).optional(),
  /** Where the SPA continues; the callback appends `?oidc=<outcome>`. Default `/`. */
  returnTo: ReturnPath.optional(),
});
export type OidcStartQuery = z.input<typeof OidcStartQuery>;

const callbackValue = (max: number) => z.string().max(max).optional();

/**
 * The authorisation response as a query (`response_mode=query`). Every member is optional: an
 * error response carries `error` and no `code`. Validated in full by the relying party (state
 * against the transaction cookie first), never trusted as is.
 */
export const OidcCallbackQuery = z.object({
  code: callbackValue(4096),
  state: callbackValue(1024),
  /** RFC 9207: the issuer that answered, where the issuer sends it. */
  iss: callbackValue(512),
  error: callbackValue(256),
  error_description: callbackValue(1024),
});
export type OidcCallbackQuery = z.input<typeof OidcCallbackQuery>;

/**
 * The authorisation response as a cross-site form post (`response_mode=form_post`, Apple).
 * `user` is Apple's unsigned JSON (name on the first authorisation only): a display name, never
 * identity or email.
 */
export const OidcCallbackForm = OidcCallbackQuery.extend({
  user: callbackValue(4096),
});
export type OidcCallbackForm = z.input<typeof OidcCallbackForm>;

// --- Linked identities (§4.1) -----------------------------------------------------------------

export const LinkedIdentity = z
  .object({
    provider: OidcProviderId,
    /** The address the issuer asserted when it was linked (it may have changed since). */
    emailAtLink: z.string().nullable(),
    linkedAt: IsoDateTime,
  })
  .meta({ id: "LinkedIdentity" });
export type LinkedIdentity = z.output<typeof LinkedIdentity>;

export const IdentityList = z
  .object({
    items: z.array(LinkedIdentity),
    /** False for an account that never set a password: its last identity cannot be unlinked. */
    hasPassword: z.boolean(),
  })
  .meta({ id: "IdentityList" });
export type IdentityList = z.output<typeof IdentityList>;

// --- Account-holder proof (§4.2) --------------------------------------------------------------

/**
 * The session's proof of being the account holder. Sensitive changes need `elevatedUntil` in
 * the future (else `reauthentication_required`); `methods` are the ways this account can give
 * one: its password, or a fresh sign-in with a linked issuer that reports `auth_time`.
 */
export const Elevation = z
  .object({
    elevatedUntil: IsoDateTime.nullable(),
    methods: z.array(z.enum(REAUTH_METHODS)),
  })
  .meta({ id: "Elevation" });
export type Elevation = z.output<typeof Elevation>;

export const ElevateBody = z
  .object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) })
  .meta({ id: "ElevateBody" });
export type ElevateBody = z.input<typeof ElevateBody>;

// --- Email verification and password reset (§4.3) ---------------------------------------------

/** The single-use token from an emailed link (stored only as a hash). */
export const EmailLinkToken = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/, "Invalid link token");

export const ConfirmEmailVerificationBody = z
  .object({ token: EmailLinkToken })
  .meta({ id: "ConfirmEmailVerificationBody" });
export type ConfirmEmailVerificationBody = z.input<typeof ConfirmEmailVerificationBody>;

/** Always answered the same way, whether or not the address has an account. */
export const RequestPasswordResetBody = z
  .object({ email: EmailAddress })
  .meta({ id: "RequestPasswordResetBody" });
export type RequestPasswordResetBody = z.input<typeof RequestPasswordResetBody>;

export const ConfirmPasswordResetBody = z
  .object({ token: EmailLinkToken, newPassword: Password })
  .meta({ id: "ConfirmPasswordResetBody" });
export type ConfirmPasswordResetBody = z.input<typeof ConfirmPasswordResetBody>;

// --- Email provider webhooks (§8.2: a suppression list honours bounces) ----------------------

export const EmailWebhookParams = z.object({
  /** The HTTP email provider's id in configuration (verified per provider). */
  provider: z.string().regex(/^[a-z0-9-]{1,32}$/, "Invalid provider"),
});

// --- Local mailbox (non-production diagnostics) -----------------------------------------------

export const MailboxQuery = z.object({
  to: EmailAddress,
  /** Only messages created at or after this instant. */
  since: IsoDateTime.optional(),
});
export type MailboxQuery = z.input<typeof MailboxQuery>;

export const MailboxMessage = z
  .object({
    id: z.string(),
    to: z.string(),
    from: z.string(),
    subject: z.string(),
    template: z.enum(EMAIL_TEMPLATES),
    text: z.string(),
    html: z.string(),
    /** Every link in the message, in order (verification and reset links for the suites). */
    links: z.array(z.string()),
    createdAt: IsoDateTime,
  })
  .meta({ id: "MailboxMessage" });
export type MailboxMessage = z.output<typeof MailboxMessage>;

export const Mailbox = z.object({ items: z.array(MailboxMessage) }).meta({ id: "Mailbox" });
export type Mailbox = z.output<typeof Mailbox>;
