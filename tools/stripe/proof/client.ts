import Stripe from "stripe";
import { type ApiCall, activeScope } from "./context.ts";

/**
 * The API version this proof (and the adapter) pins. stripe-node 23.2.0 is generated for it and
 * its types accept only this literal, so a library upgrade that moves the version fails the
 * typecheck here instead of silently changing payload shapes.
 */
export const API_VERSION = "2026-11-18.endive" satisfies Stripe.LatestApiVersion;

/** Every request made outside any scenario (setup, teardown). */
export const unscopedCalls: ApiCall[] = [];

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

/**
 * A `fetch` that records every request (method, path, status, timing, request id, idempotency
 * key, replay and rate-limit headers) against the scenario running it. It wraps the global
 * fetch only: no Node transport is involved, exactly as on Workers.
 */
export const countingFetch: typeof fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const started = performance.now();
  const response = await fetch(input, init);
  const authorization = headerOf(init, "Authorization") ?? "";
  const scope = activeScope.getStore();
  const call: ApiCall = {
    scenario: scope?.scenario.name ?? "(setup)",
    step: scope?.scenario.currentStep ?? "",
    method: (init?.method ?? "GET").toUpperCase(),
    path: `${url.pathname}${url.search}`,
    status: response.status,
    ms: Math.round(performance.now() - started),
    auth: /Bearer pk_/.test(authorization) ? "publishable" : "secret",
    requestId: response.headers.get("Request-Id"),
    idempotencyKey: headerOf(init, "Idempotency-Key"),
    replayed: response.headers.get("Idempotent-Replayed") === "true",
    rateLimitedReason: response.headers.get("Stripe-Rate-Limited-Reason"),
    at: new Date().toISOString(),
  };
  if (scope) scope.scenario.calls.push(call);
  else unscopedCalls.push(call);
  return response;
};

export function createStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: API_VERSION,
    httpClient: Stripe.createFetchHttpClient(countingFetch),
    // The library adds an idempotency key to every retried POST (see the idempotency scenario).
    maxNetworkRetries: 2,
    timeout: 80_000,
    telemetry: false,
  });
}

/** Web Crypto signature verification, the path Workers use. */
export const subtleCrypto = Stripe.createSubtleCryptoProvider();

/**
 * What the browser sends after the Payment Element has a payment method: the publishable key
 * and the intent's client secret, never the secret key. Raw card numbers are refused on this
 * surface (`unsupported_publishable_key_tokenization_surface`: only Stripe.js may send them), so
 * the proof uses Stripe's test PaymentMethod ids (`pm_card_visa`, …).
 */
export async function browserConfirm(
  publishableKey: string,
  kind: "setup_intents" | "payment_intents",
  intentId: string,
  clientSecret: string,
  paymentMethod: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await countingFetch(`https://api.stripe.com/v1/${kind}/${intentId}/confirm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${publishableKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": API_VERSION,
    },
    body: new URLSearchParams({
      client_secret: clientSecret,
      payment_method: paymentMethod,
      // Where the 3-D Secure page would send the member back (never reached in this run).
      return_url: "http://localhost:5510/return",
    }).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
