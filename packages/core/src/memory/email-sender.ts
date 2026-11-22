import { type Clock, systemClock } from "../ports/clock.ts";
import {
  assertEmailMessage,
  type DeliveredEmail,
  type EmailMessage,
  type EmailSender,
  type EmailSendResult,
  type LocalMailbox,
} from "../ports/email-sender.ts";
import { createUuidV7Generator, type IdGenerator } from "../ports/ids.ts";

/**
 * In-process `EmailSender`: an outbox the local mailbox API reads (`GET /diagnostics/mailbox`).
 * Holds the most recent `capacity` messages; idempotency keys are remembered for as long. One
 * process (or one Workers isolate) only: the D1 outbox serves every isolate.
 */
export class MemoryEmailSender implements EmailSender, LocalMailbox {
  private readonly delivered: DeliveredEmail[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly from: string;
  private readonly capacity: number;

  constructor(
    options: { clock?: Clock; ids?: IdGenerator; from?: string; capacity?: number } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? createUuidV7Generator({ clock: this.clock });
    this.from = options.from ?? "Webflix <no-reply@webflix.dev>";
    this.capacity = options.capacity ?? 10_000;
  }

  async send(message: EmailMessage, options: { idempotencyKey: string }): Promise<EmailSendResult> {
    assertEmailMessage(message, options.idempotencyKey);
    const existing = this.byKey.get(options.idempotencyKey);
    if (existing) return { messageId: existing, deduplicated: true };
    const messageId = this.ids.next();
    this.byKey.set(options.idempotencyKey, messageId);
    this.delivered.push({
      ...message,
      from: message.from ?? this.from,
      messageId,
      idempotencyKey: options.idempotencyKey,
      sentAt: this.clock.now(),
    });
    if (this.delivered.length > this.capacity) {
      const dropped = this.delivered.shift();
      if (dropped) this.byKey.delete(dropped.idempotencyKey);
    }
    return { messageId, deduplicated: false };
  }

  async listDelivered(to: string, since = 0): Promise<DeliveredEmail[]> {
    return this.mailbox(to).filter((message) => message.sentAt >= since);
  }

  /** Delivered messages, oldest first, optionally for one recipient (case-insensitive). */
  mailbox(to?: string): DeliveredEmail[] {
    const wanted = to?.toLowerCase();
    return this.delivered
      .filter((message) => wanted === undefined || message.to.toLowerCase() === wanted)
      .map((message) => ({ ...message }));
  }
}
