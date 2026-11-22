import * as z from "zod";
import { Entitlement, MembershipState } from "./billing.ts";
import { Id, IsoDateTime } from "./common.ts";
import {
  CARD_BRANDS,
  DEVICE_TYPES,
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SUBSCRIPTION_STATUSES,
} from "./constants.ts";
import { ExperimentAssignments } from "./experiments.ts";
import { Plan, PlanId } from "./plans.ts";
import { Profile } from "./profiles.ts";

/** Emails are trimmed and lowercased before validation, on both client and server. */
export const EmailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: "Enter a valid email address" }));

export const Password = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .refine(
    (password) =>
      new TextEncoder().encode(password.normalize("NFKC")).byteLength <= PASSWORD_MAX_BYTES,
    { message: "Password is too long" },
  );

export const Account = z
  .object({
    id: Id,
    email: z.email(),
    createdAt: IsoDateTime,
    /**
     * The shared demo account: its sign-in details, membership and profiles cannot be changed
     * (`demo_account_protected`). Absent on other accounts.
     */
    isDemo: z.literal(true).optional(),
    /**
     * Milestone 2 (§4.3): whether the email address was verified (automatic linking of an
     * issuer identity depends on it). Absent until identity serves it.
     */
    emailVerified: z.boolean().optional(),
    /**
     * Milestone 2 (§4.1): false for an account created through an issuer that never set a
     * password ("Confirm it's you" then offers a fresh sign-in). Absent until identity serves it.
     */
    hasPassword: z.boolean().optional(),
  })
  .meta({ id: "Account" });
export type Account = z.output<typeof Account>;

export const SubscriptionStatus = z.enum(SUBSCRIPTION_STATUSES).meta({ id: "SubscriptionStatus" });
export type SubscriptionStatus = z.output<typeof SubscriptionStatus>;

export const Subscription = z
  .object({
    planId: PlanId,
    status: SubscriptionStatus,
    startedAt: IsoDateTime,
    currentPeriodEnd: IsoDateTime,
    canceledAt: IsoDateTime.nullable(),
  })
  .meta({ id: "Subscription" });
export type Subscription = z.output<typeof Subscription>;

export const PaymentMethod = z
  .object({
    brand: z.enum(CARD_BRANDS),
    last4: z.string().regex(/^\d{4}$/),
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int(),
  })
  .meta({ id: "PaymentMethod" });
export type PaymentMethod = z.output<typeof PaymentMethod>;

/**
 * Subscription together with its resolved plan; returned by every change of an existing
 * membership (plan change, cancel, resume), so never null there.
 */
export const Membership = z
  .object({
    subscription: Subscription,
    plan: Plan,
  })
  .meta({ id: "Membership" });
export type Membership = z.output<typeof Membership>;

export const AccountDetails = z
  .object({
    account: Account,
    /**
     * Milestone 1's view of the membership; null when the account has none (`membership.status`
     * is `none`): never a stand-in.
     */
    subscription: Subscription.nullable(),
    /** The membership's plan; null when the account has none. */
    plan: Plan.nullable(),
    paymentMethod: PaymentMethod.nullable(),
    /**
     * Milestone 2 (§5.2, §5.6): the membership projection, driven by provider events. The web
     * waits on it after checkout. Absent until billing serves it.
     */
    membership: MembershipState.optional(),
    /** Milestone 2 (§5.2): whether the account may play, and why not. Absent until billing serves it. */
    entitlement: Entitlement.optional(),
  })
  .meta({ id: "AccountDetails" });
export type AccountDetails = z.output<typeof AccountDetails>;

// --- Session bootstrap ------------------------------------------------------------------------

export const AnonymousSession = z
  .object({
    authenticated: z.literal(false),
    /**
     * Milestone 2 (§8.1): experiment assignments of this device (the unit before sign-in),
     * key → variant. Absent until experiments serve it.
     */
    experiments: ExperimentAssignments.optional(),
  })
  .meta({ id: "AnonymousSession" });

export const AuthenticatedSession = z
  .object({
    authenticated: z.literal(true),
    account: Account,
    /** Null when the account has no membership (`membership.status` is `none`). */
    subscription: Subscription.nullable(),
    /** Null when the account has no membership. */
    plan: Plan.nullable(),
    profiles: z.array(Profile),
    /** Bound server-side to the session cookie; null until a profile is selected. */
    activeProfile: Profile.nullable(),
    /**
     * Milestone 2 (§5.2, billing): the membership projection, as `GET /account` has it. An
     * account without a membership is `none` here, and `subscription` and `plan` are null.
     * Absent from older servers.
     */
    membership: MembershipState.optional(),
    /** Milestone 2 (§5.2, billing): whether the account may play, and why not. */
    entitlement: Entitlement.optional(),
    /**
     * Milestone 2 (§8.1): experiment assignments of the active profile (of the device at the
     * profile gate), key → variant. Absent until experiments serve it.
     */
    experiments: ExperimentAssignments.optional(),
  })
  .meta({ id: "AuthenticatedSession" });
export type AuthenticatedSession = z.output<typeof AuthenticatedSession>;

/**
 * `GET /session` always answers 200 so the SPA can boot without an error round-trip;
 * discriminate on `authenticated`.
 */
export const SessionState = z
  .discriminatedUnion("authenticated", [AnonymousSession, AuthenticatedSession])
  .meta({ id: "SessionState" });
export type SessionState = z.output<typeof SessionState>;

/**
 * Anonymous, client-generated id of a browser or app install (the telemetry SDK's `deviceId`):
 * the experiment unit before sign-in (milestone 2 §6.1, §8.1). Never an identity.
 */
export const DeviceId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid device id")
  .meta({ id: "DeviceId" });

export const SessionQuery = z.object({
  /** Milestone 2: the device whose experiment assignments to return before sign-in. */
  deviceId: DeviceId.optional(),
});
export type SessionQuery = z.input<typeof SessionQuery>;

// --- Auth requests ----------------------------------------------------------------------------

export const EmailStatusQuery = z.object({ email: EmailAddress });
export type EmailStatusQuery = z.input<typeof EmailStatusQuery>;

/** Where the landing page should send this email next. */
export const EmailStatus = z
  .object({ next: z.enum(["login", "signup"]) })
  .meta({ id: "EmailStatus" });
export type EmailStatus = z.output<typeof EmailStatus>;

/**
 * Milestone 2 (§5.1): sign-up creates the account and a session with no membership (`none`);
 * the plan is chosen and paid at checkout, card data going to the payment provider only
 * (principle 4). Strict: a body with anything else (milestone 1's `planId` and `payment`, a
 * card) is refused (`validation_failed`), never stored or logged.
 */
export const SignupBody = z
  .object({
    email: EmailAddress,
    password: Password,
  })
  .strict()
  .meta({ id: "SignupBody" });
export type SignupBody = z.input<typeof SignupBody>;

export const LoginBody = z
  .object({
    email: EmailAddress,
    // Login accepts any length the user typed; only sign-up enforces the policy.
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    rememberMe: z.boolean().optional(),
  })
  .meta({ id: "LoginBody" });
export type LoginBody = z.input<typeof LoginBody>;

/**
 * Changing email or password requires the current password, or (milestone 2, §4.2) a fresh
 * account-holder proof held by the session (`POST /session/elevation` or a fresh sign-in with a
 * linked issuer): an account created through an issuer has no password to send. At least one
 * change is required.
 */
export const UpdateAccountBody = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
    email: EmailAddress.optional(),
    newPassword: Password.optional(),
  })
  .refine((body) => body.email !== undefined || body.newPassword !== undefined, {
    message: "Provide a new email or a new password",
  })
  .meta({ id: "UpdateAccountBody" });
export type UpdateAccountBody = z.input<typeof UpdateAccountBody>;

/** Strict: card data (milestone 1's `payment`) is refused (`validation_failed`). */
export const ChangePlanBody = z
  .object({
    planId: PlanId,
    /**
     * Milestone 2 (§12): the token of the `POST /billing/subscription/preview` the member
     * accepted, so the change is applied exactly as previewed (same proration date).
     */
    previewToken: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .meta({ id: "ChangePlanBody" });
export type ChangePlanBody = z.input<typeof ChangePlanBody>;

// --- Devices ----------------------------------------------------------------------------------

/** A signed-in browser/device (one row of the `sessions` table). */
export const DeviceSession = z
  .object({
    id: Id,
    /** True for the session making this request. */
    current: z.boolean(),
    label: z.string().meta({ description: 'Human label, e.g. "Chrome on macOS".' }),
    deviceType: z.enum(DEVICE_TYPES),
    createdAt: IsoDateTime,
    lastSeenAt: IsoDateTime,
  })
  .meta({ id: "DeviceSession" });
export type DeviceSession = z.output<typeof DeviceSession>;

export const DeviceSessionList = z
  .object({ items: z.array(DeviceSession) })
  .meta({ id: "DeviceSessionList" });
export type DeviceSessionList = z.output<typeof DeviceSessionList>;
