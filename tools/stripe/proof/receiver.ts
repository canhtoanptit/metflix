import { createServer, type IncomingMessage } from "node:http";
import type Stripe from "stripe";
import { subtleCrypto } from "./client.ts";

/** One HTTP delivery of an event to the receiver, in arrival order. */
export interface Delivery {
  /** Arrival order across the whole run, from 0. */
  seq: number;
  receivedAt: string;
  receivedAtMs: number;
  /** The raw body exactly as received (what the signature covers). */
  raw: string;
  signatureHeader: string;
  /** `t=` from the signature header: when Stripe (or the CLI) signed this delivery. */
  signedAt: number | null;
  signatureVerified: boolean;
  verificationError: string | null;
  /** The verified event, or the parsed body when verification failed (for diagnosis). */
  event: Stripe.Event | null;
  /** 1 for the first delivery of an event id, 2 for the second, … */
  deliveryOfId: number;
  respondedWith: number;
}

export interface Receiver {
  url: string;
  port: number;
  deliveries: Delivery[];
  waitFor(predicate: (d: Delivery) => boolean, timeoutMs: number, what: string): Promise<Delivery>;
  /** Answer the next deliveries matching `predicate` with `status` (e.g. 500), `times` times. */
  failNext(predicate: (event: Stripe.Event) => boolean, status: number, times: number): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * A local webhook endpoint (127.0.0.1, port in 5500–5549) that does what the Webflix handler
 * must do: verify the signature over the raw body with Web Crypto, then answer quickly. It
 * records every delivery, including duplicates, in the order they arrive.
 */
export async function startReceiver(options: {
  port: number;
  secret: string;
  stripe: Stripe;
}): Promise<Receiver> {
  const deliveries: Delivery[] = [];
  const countById = new Map<string, number>();
  const waiters = new Set<{
    predicate: (d: Delivery) => boolean;
    resolve: (d: Delivery) => void;
  }>();
  const failures: Array<{
    predicate: (event: Stripe.Event) => boolean;
    status: number;
    remaining: number;
  }> = [];

  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/webhook")) {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const receivedAtMs = Date.now();
      const raw = await readBody(request);
      const signatureHeader = String(request.headers["stripe-signature"] ?? "");
      let event: Stripe.Event | null = null;
      let verificationError: string | null = null;
      try {
        event = await options.stripe.webhooks.constructEventAsync(
          raw,
          signatureHeader,
          options.secret,
          300,
          subtleCrypto,
        );
      } catch (error) {
        verificationError = error instanceof Error ? error.message : String(error);
        try {
          event = JSON.parse(raw) as Stripe.Event;
        } catch {
          event = null;
        }
      }
      const id = event?.id ?? "";
      const deliveryOfId = (countById.get(id) ?? 0) + 1;
      countById.set(id, deliveryOfId);

      let status = verificationError ? 400 : 200;
      if (event && !verificationError) {
        const failure = failures.find((f) => f.remaining > 0 && f.predicate(event as Stripe.Event));
        if (failure) {
          failure.remaining--;
          status = failure.status;
        }
      }
      const signedAt = /(?:^|,)t=(\d+)/.exec(signatureHeader)?.[1];
      const delivery: Delivery = {
        seq: deliveries.length,
        receivedAt: new Date(receivedAtMs).toISOString(),
        receivedAtMs,
        raw,
        signatureHeader,
        signedAt: signedAt ? Number(signedAt) : null,
        signatureVerified: verificationError === null,
        verificationError,
        event,
        deliveryOfId,
        respondedWith: status,
      };
      deliveries.push(delivery);
      response.writeHead(status, { "Content-Type": "application/json" }).end('{"received":true}');
      for (const waiter of waiters) {
        if (waiter.predicate(delivery)) {
          waiters.delete(waiter);
          waiter.resolve(delivery);
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });

  return {
    url: `http://localhost:${options.port}/webhook`,
    port: options.port,
    deliveries,
    waitFor(predicate, timeoutMs, what) {
      const existing = deliveries.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (waiters.delete(waiter))
            reject(new Error(`Timed out after ${timeoutMs / 1000} s waiting for ${what}`));
        }, timeoutMs);
        const waiter = {
          predicate,
          resolve: (delivery: Delivery) => {
            clearTimeout(timer);
            resolve(delivery);
          },
        };
        waiters.add(waiter);
      });
    },
    failNext(predicate, status, times) {
      failures.push({ predicate, status, remaining: times });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
