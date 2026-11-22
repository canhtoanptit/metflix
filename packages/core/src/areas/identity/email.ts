import { EMAIL_TEMPLATES } from "@webflix/contracts";
import { type EmailTemplateData, renderEmail } from "@webflix/email";
import * as z from "zod";
import type { EmailTemplate } from "../../ports/email-sender.ts";
import { defineJob } from "../../ports/job-queue.ts";
import type { ServiceDependencies } from "../../services/context.ts";

/** A templated email: a template of `packages/email`, its data and the caller's idempotency key. */
export interface EmailRequest<T extends EmailTemplate = EmailTemplate> {
  to: string;
  template: T;
  data: EmailTemplateData[T];
  /** One message per key, whatever the retries (e.g. `receipt:<invoice id>`). */
  idempotencyKey: string;
}

/**
 * Render a template and send it now through `deps.email`, unless the address bounced or
 * complained before (the suppression list). For callers that are already a job (an export, a
 * billing event): at most one message per idempotency key, so a retried job sends nothing new.
 * Callers that are not a job queue one instead (`seams.sendEmail`). Throws when the template's
 * data is invalid (a link that is not http(s)) or when the sender fails (the job retries).
 */
export async function sendTemplatedEmail<T extends EmailTemplate>(
  deps: Pick<ServiceDependencies, "repos" | "email" | "logger">,
  request: EmailRequest<T>,
): Promise<
  { sent: false; reason: "suppressed" } | { sent: true; messageId: string; deduplicated: boolean }
> {
  if (await deps.repos.identity.isSuppressed(request.to)) {
    deps.logger.info("identity.email_suppressed", { template: request.template });
    return { sent: false, reason: "suppressed" };
  }
  const rendered = renderEmail(request.template, request.data);
  const result = await deps.email.send(
    { to: request.to, template: request.template, ...rendered },
    { idempotencyKey: request.idempotencyKey },
  );
  deps.logger.info("identity.email_sent", {
    template: request.template,
    deduplicated: result.deduplicated,
  });
  return { sent: true, messageId: result.messageId, deduplicated: result.deduplicated };
}

/**
 * The identity area's email jobs (§8.2: sending is a job with an idempotency key). Each job's id
 * is stable across redeliveries, so it is the idempotency key of the message it sends: a retried
 * job never sends twice. Links that carry a secret (verification, reset) are minted inside the
 * job, so the queue never holds a usable token.
 */

const Address = z.string().min(3).max(254);

/** Any rendered template to one address (welcome, security alerts, other areas' messages). */
export const sendEmailJob = defineJob(
  "identity.email.send",
  z.object({
    to: Address,
    template: z.enum(EMAIL_TEMPLATES),
    data: z.record(z.string(), z.unknown()),
    /** The caller's idempotency key: one message per key, whatever the retries. */
    key: z.string().min(1).max(200),
  }),
);

/** Mint a verification token for the account's current address and email the link. */
export const verificationEmailJob = defineJob(
  "identity.email-verification",
  z.object({ accountId: z.string().min(1).max(64) }),
);

/**
 * Look the address up and, only if it has an account, mint a reset token and email the link.
 * The lookup happens here, never in the request, so the response cannot depend on it.
 */
export const passwordResetEmailJob = defineJob(
  "identity.password-reset",
  z.object({ email: Address }),
);

/** Expired claims and spent tokens, a bounded batch at a time. */
export const identityCleanupJob = defineJob("identity.cleanup", z.object({}));
