import type { Clock } from "../../ports/clock.ts";
import {
  assertEmailMessage,
  type DeliveredEmail,
  type EmailSender,
  type EmailTemplate,
  type LocalMailbox,
} from "../../ports/email-sender.ts";
import type { IdGenerator } from "../../ports/ids.ts";
import type { IdentityRepository } from "./repository.ts";

/** Messages the mailbox API returns at most per address. */
const MAILBOX_LIMIT = 100;

/**
 * The outbox `EmailSender` (`WEBFLIX_EMAIL_SENDER=outbox`, local Cloudflare, §9): a message is
 * "delivered" by recording it, bodies included, in `email_outbox` under its idempotency key (a
 * unique key, so at most once across isolates and replicas), and the local mailbox reads it back
 * from there. Never for production: the bodies hold live verification and reset links.
 */
export function createOutboxEmailSender(options: {
  repository: IdentityRepository;
  ids: IdGenerator;
  clock: Clock;
  from: string;
}): EmailSender & LocalMailbox {
  const { repository, ids, clock, from } = options;
  return {
    async send(message, { idempotencyKey }) {
      const sender = message.from ?? from;
      assertEmailMessage({ ...message, from: sender }, idempotencyKey);
      const id = ids.next();
      const now = clock.now();
      const recorded = await repository.recordEmail({
        id,
        idempotencyKey,
        to: message.to,
        from: sender,
        template: message.template,
        subject: message.subject,
        html: message.html,
        text: message.text,
        status: "sent",
        providerMessageId: id,
        createdAt: now,
        sentAt: now,
      });
      return { messageId: recorded.id, deduplicated: !recorded.created };
    },

    async listDelivered(to, since = 0): Promise<DeliveredEmail[]> {
      const entries = await repository.listMailbox(to, since, MAILBOX_LIMIT);
      return entries.map((entry) => ({
        to: entry.to,
        from: entry.from,
        subject: entry.subject,
        html: entry.html ?? "",
        text: entry.text ?? "",
        template: entry.template as EmailTemplate,
        messageId: entry.id,
        idempotencyKey: entry.idempotencyKey,
        sentAt: entry.sentAt ?? entry.createdAt,
      }));
    },
  };
}

/**
 * The development issuer's store (`DevIdpStore`: `claim`, `has`) on the identity area's claims
 * table, so its codes and refresh tokens stay single-use across replicas and isolates that share
 * the database (packages/dev-idp/README.md, "State without a server store").
 */
export function createClaimStore(repository: IdentityRepository, clock: Clock) {
  return {
    claim: (key: string, expiresAt: number) =>
      repository.claim(`dev-idp:${key}`, expiresAt, clock.now()),
    has: (key: string) => repository.hasClaim(`dev-idp:${key}`, clock.now()),
  };
}
