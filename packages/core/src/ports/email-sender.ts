/**
 * Port: sends one rendered message (milestone 2 §3, §8.2). In-memory outbox with a mailbox API
 * (dev), SMTP (Mailpit on kind) or an HTTP provider; a D1 outbox for local Cloudflare.
 * Rendering is `packages/email`'s, and so is the message shape and its one validation, which
 * every adapter runs (re-exported here so services and adapters import the port from core).
 * Sending is a job, so this port is called at least once per message and must be idempotent.
 *
 * Contract (`describeEmailSenderContract`):
 * - A message is delivered at most once per `idempotencyKey`: a repeated call answers the
 *   first call's `messageId` with `deduplicated: true` and delivers nothing.
 * - Headers cannot be injected: a recipient, sender or subject with a line break is refused
 *   (`assertEmailMessage`), as is an address that is not one.
 * - UTF-8 subjects and bodies arrive unchanged.
 * - The suppression list (bounces) is the caller's to consult; the port sends what it is given.
 */
export {
  assertEmailMessage,
  type DeliveredEmail,
  type EmailMessage,
  type EmailSender,
  type EmailSendResult,
  type EmailTemplate,
  emailLinks,
  isEmailAddress,
  isLocalMailbox,
  type LocalMailbox,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  parseMailbox,
} from "@webflix/email";
