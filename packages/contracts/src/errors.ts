import * as z from "zod";
import { SubscriptionStatus } from "./account.ts";
import { MembershipStatus } from "./billing.ts";
import { PAYMENT_DECLINE_REASONS, PROMOTION_FAILURE_REASONS, STAFF_ROLES } from "./constants.ts";
import { ERROR_CATALOG, ERROR_CODES, type ErrorCode, problemType } from "./error-codes.ts";
import { MaturityLevel } from "./maturity.ts";
import { ActiveStream } from "./playback.ts";
import { ROUTE_AREAS } from "./route.ts";

export const ErrorCodeSchema = z.enum(ERROR_CODES).meta({ id: "ErrorCode" });

export const VALIDATION_LOCATIONS = ["params", "query", "body", "headers"] as const;

export const ValidationIssue = z
  .object({
    location: z.enum(VALIDATION_LOCATIONS),
    /** Dot path into the location, e.g. `payment.cardNumber`; empty for the whole value. */
    path: z.string(),
    message: z.string(),
    code: z.string(),
  })
  .meta({ id: "ValidationIssue" });
export type ValidationIssue = z.output<typeof ValidationIssue>;

/** Extra members carried by specific problem codes (RFC 9457 extension members). */
const PROBLEM_EXTENSION_SHAPES = {
  validation_failed: { issues: z.array(ValidationIssue) },
  rate_limited: { retryAfterSec: z.number().int().positive() },
  stream_limit_reached: {
    limit: z.number().int().positive(),
    activeStreams: z.array(ActiveStream),
  },
  subscription_required: {
    subscriptionStatus: SubscriptionStatus,
    /** Milestone 2: the membership projection's state (§5.2), once billing serves it. */
    membershipStatus: MembershipStatus.optional(),
  },
  maturity_restricted: { maturity: MaturityLevel, profileMaturityCeiling: MaturityLevel },
  payment_declined: { declineReason: z.enum(PAYMENT_DECLINE_REASONS) },
  range_not_satisfiable: { size: z.number().int().nonnegative() },
  not_implemented: { operationId: z.string(), area: z.enum(ROUTE_AREAS) },
  promotion_code_invalid: { promotionReason: z.enum(PROMOTION_FAILURE_REASONS) },
  payment_action_required: { clientSecret: z.string().min(1) },
  staff_role_required: { requiredRole: z.enum(STAFF_ROLES) },
} satisfies Partial<Record<ErrorCode, z.ZodRawShape>>;

type ExtensionShapes = typeof PROBLEM_EXTENSION_SHAPES;
type ExtensionShape<C extends ErrorCode> = C extends keyof ExtensionShapes
  ? ExtensionShapes[C]
  : Record<never, never>;

const problemBaseShape = {
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
};

type ProblemSchemaFor<C extends ErrorCode> = z.ZodObject<
  typeof problemBaseShape & { code: z.ZodLiteral<C> } & ExtensionShape<C>
>;

/** RFC 9457 problem details, discriminated by `code`. `Problem<"rate_limited">` narrows. */
export type Problem<C extends ErrorCode = ErrorCode> = C extends ErrorCode
  ? z.output<ProblemSchemaFor<C>>
  : never;

/** Extension members of one code (`{}` with no keys for codes without extensions). */
export type ProblemExtensions<C extends ErrorCode> = C extends keyof ExtensionShapes
  ? z.output<z.ZodObject<ExtensionShapes[C]>>
  : Record<never, never>;

function problemVariant(code: ErrorCode) {
  const extension: z.ZodRawShape =
    (PROBLEM_EXTENSION_SHAPES as Partial<Record<ErrorCode, z.ZodRawShape>>)[code] ?? {};
  return z.object({ ...problemBaseShape, code: z.literal(code), ...extension });
}

const problemVariants = ERROR_CODES.map(problemVariant);

/** Runtime schema for any problem document. Parses into the discriminated `Problem` type. */
export const Problem = z
  .discriminatedUnion(
    "code",
    // The tuple type cannot be expressed through `map`; every element is a problem variant.
    problemVariants as unknown as [
      (typeof problemVariants)[number],
      ...(typeof problemVariants)[number][],
    ],
  )
  .meta({ id: "Problem" }) as unknown as z.ZodType<Problem>;

/** Codes that carry no extension members (can be raised with just a code). */
export type PlainErrorCode = {
  [C in ErrorCode]: keyof ProblemExtensions<C> extends never ? C : never;
}[ErrorCode];

export interface ProblemOptions {
  detail?: string;
  instance?: string;
  requestId?: string;
}

type ProblemArgs<C extends ErrorCode> = keyof ExtensionShape<C> extends never
  ? [options?: ProblemOptions]
  : [options: ProblemOptions & ProblemExtensions<C>];

/** Build a problem document for `code`; codes with extension members require them. */
export function createProblem<C extends ErrorCode>(code: C, ...args: ProblemArgs<C>): Problem<C> {
  const spec = ERROR_CATALOG[code];
  const { detail, instance, requestId, ...extensions } = (args[0] ?? {}) as ProblemOptions &
    Record<string, unknown>;
  return {
    type: problemType(code),
    title: spec.title,
    status: spec.status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(instance === undefined ? {} : { instance }),
    ...(requestId === undefined ? {} : { requestId }),
    ...extensions,
  } as Problem<C>;
}
