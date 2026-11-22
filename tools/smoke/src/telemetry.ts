/**
 * Client behaviour events as the telemetry SDK builds them (`ClientEventInput`, milestone 2
 * §6.1): UUIDv7 ids, an anonymous device id, a per-device session sequence. Never an identity:
 * the server stamps the subject.
 */
import { randomBytes } from "node:crypto";
import type { ClientEventInput } from "@webflix/contracts";

/** A UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version 7, variant 10, random rest. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let time = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An anonymous device id, as the SDK keeps one per browser. */
export function deviceId(tag: string): string {
  return `smk-${tag}-${randomBytes(6).toString("hex")}`.slice(0, 64);
}

type Payload<T extends ClientEventInput["type"]> = Extract<
  ClientEventInput,
  { type: T }
>["payload"];

/** A device's event stream: `sessionSeq` counts up like the SDK's within one app session. */
export class EventStream {
  readonly deviceId: string;
  private seq = 0;

  constructor(device: string) {
    this.deviceId = device;
  }

  event<T extends ClientEventInput["type"]>(
    type: T,
    payload: Payload<T>,
    context: Partial<ClientEventInput["context"]> = {},
  ): ClientEventInput {
    this.seq += 1;
    return {
      eventId: uuidv7(),
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      deviceId: this.deviceId,
      sessionSeq: this.seq,
      app: { platform: "web", version: "smoke" },
      context: {
        surface: "home",
        rowId: null,
        rowRank: null,
        rank: null,
        experiments: {},
        policy: null,
        ...context,
      },
      payload,
    } as ClientEventInput;
  }
}
