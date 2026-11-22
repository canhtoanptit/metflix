import { type Logger, type PaymentFailureCode, PaymentProviderError } from "@webflix/core";

/**
 * The API version this adapter is written against (docs/STRIPE.md §14): every request pins it,
 * so payload shapes never move under the adapter. The webhook endpoint (or `stripe listen`)
 * must render events in the same version.
 */
export const STRIPE_API_VERSION = "2026-11-18.endive";
export const STRIPE_API_BASE = "https://api.stripe.com";

export type StripeObject = Record<string, unknown>;
export type StripeParams = Record<string, unknown>;

export interface StripeClientOptions {
  secretKey: string;
  fetch?: typeof fetch;
  apiBase?: string;
  apiVersion?: string;
  /** Retries of network errors, 409 (key in use), 429 and 5xx, with the same idempotency key. */
  maxNetworkRetries?: number;
  logger?: Logger;
  /** Waits between retries (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
}

/** A Stripe API error, mapped to the port's codes; Stripe's message is kept for logs only. */
export class StripeApiError extends PaymentProviderError {
  readonly status: number;
  readonly stripeType: string | null;
  readonly stripeCode: string | null;
  readonly declineCode: string | null;

  constructor(
    code: PaymentFailureCode,
    details: {
      status: number;
      type: string | null;
      code: string | null;
      declineCode: string | null;
    },
  ) {
    super(code, `Stripe ${details.status} ${details.type ?? ""} ${details.code ?? ""}`.trim());
    this.status = details.status;
    this.stripeType = details.type;
    this.stripeCode = details.code;
    this.declineCode = details.declineCode;
  }
}

/**
 * Stripe's form encoding: nested objects and arrays in bracket notation
 * (`items[0][price]=…`, `expand[]=…`). Undefined and null values are left out.
 */
export function encodeForm(params: StripeParams): string {
  const pairs: [string, string][] = [];
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        add(isScalar(item) && key === "expand" ? `${key}[]` : `${key}[${index}]`, item);
      });
    } else if (typeof value === "object") {
      for (const [child, nested] of Object.entries(value as Record<string, unknown>)) {
        add(`${key}[${child}]`, nested);
      }
    } else {
      pairs.push([key, String(value)]);
    }
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return new URLSearchParams(pairs).toString();
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Stripe's error → the port's failure code (never its message: docs/STRIPE.md §14). */
export function mapStripeError(
  status: number,
  error: { type?: unknown; code?: unknown; decline_code?: unknown } | undefined,
): PaymentFailureCode {
  const type = typeof error?.type === "string" ? error.type : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const decline = typeof error?.decline_code === "string" ? error.decline_code : null;
  if (status === 429 || code === "rate_limit" || code === "lock_timeout") return "rate_limited";
  if (status >= 500) return "unavailable";
  if (type === "idempotency_error") return "idempotency_conflict";
  if (status === 409 && code === "idempotency_key_in_use") return "unavailable";
  if (status === 404 || code === "resource_missing") return "not_found";
  if (
    code === "invoice_payment_intent_requires_action" ||
    code === "authentication_required" ||
    decline === "authentication_required"
  ) {
    return "authentication_required";
  }
  if (type === "card_error" || status === 402) {
    const reason = decline ?? code;
    switch (reason) {
      case "insufficient_funds":
        return "insufficient_funds";
      case "expired_card":
        return "expired_card";
      case "incorrect_cvc":
      case "invalid_cvc":
        return "incorrect_cvc";
      case "processing_error":
        return "processing_error";
      default:
        return "card_declined";
    }
  }
  return "invalid_request";
}

/**
 * A minimal Stripe REST client on `fetch` (no SDK on the request path, so it runs on Workers):
 * form-encoded requests, the pinned `Stripe-Version`, the caller's idempotency key on every
 * POST (never a generated one: keys come from Webflix operations, docs/STRIPE.md §7), and
 * bounded retries with the same key for what Stripe documents as safe to retry.
 */
export class StripeClient {
  private readonly secretKey: string;
  private readonly fetcher: typeof fetch;
  private readonly apiBase: string;
  private readonly apiVersion: string;
  private readonly maxRetries: number;
  private readonly logger: Logger | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: StripeClientOptions) {
    this.secretKey = options.secretKey;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.apiBase = (options.apiBase ?? STRIPE_API_BASE).replace(/\/$/, "");
    this.apiVersion = options.apiVersion ?? STRIPE_API_VERSION;
    this.maxRetries = options.maxNetworkRetries ?? 2;
    this.logger = options.logger;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get<T extends StripeObject = StripeObject>(path: string, params: StripeParams = {}): Promise<T> {
    return this.request<T>("GET", path, params, null);
  }

  /** `idempotencyKey` is required: a money-moving call without one could charge twice. */
  post<T extends StripeObject = StripeObject>(
    path: string,
    params: StripeParams,
    idempotencyKey: string,
  ): Promise<T> {
    return this.request<T>("POST", path, params, idempotencyKey);
  }

  delete<T extends StripeObject = StripeObject>(path: string): Promise<T> {
    return this.request<T>("DELETE", path, {}, null);
  }

  /** A GET that answers null for a missing object instead of throwing. */
  async find<T extends StripeObject = StripeObject>(
    path: string,
    params: StripeParams = {},
  ): Promise<T | null> {
    try {
      return await this.get<T>(path, params);
    } catch (error) {
      if (error instanceof PaymentProviderError && error.code === "not_found") return null;
      throw error;
    }
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: StripeParams,
    idempotencyKey: string | null,
  ): Promise<T> {
    const form = encodeForm(params);
    const url = `${this.apiBase}${path}${method !== "POST" && form ? `?${form}` : ""}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      "Stripe-Version": this.apiVersion,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    }
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          ...(method === "POST" ? { body: form } : {}),
        });
      } catch (cause) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new PaymentProviderError("unavailable", "Stripe could not be reached", { cause });
      }
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (response.ok) return body as T;
      const error = (body as { error?: Record<string, unknown> } | null)?.error;
      const code = mapStripeError(response.status, error);
      const retryable =
        response.status === 409 || response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(backoff(attempt, response.headers.get("Retry-After")));
        continue;
      }
      // The request id and Stripe's own type/code help an operator; the message stays out
      // (sandbox messages carry links and are never shown to members).
      this.logger?.warn("stripe.request_failed", {
        method,
        path: path.replace(
          /\/(cus|sub|in|seti|pi|pm|price|prod|promo|re|evt)_[A-Za-z0-9]+/g,
          "/$1_…",
        ),
        status: response.status,
        type: typeof error?.type === "string" ? error.type : null,
        code: typeof error?.code === "string" ? error.code : null,
        requestId: response.headers.get("Request-Id"),
      });
      throw new StripeApiError(code, {
        status: response.status,
        type: typeof error?.type === "string" ? error.type : null,
        code: typeof error?.code === "string" ? error.code : null,
        declineCode: typeof error?.decline_code === "string" ? error.decline_code : null,
      });
    }
  }
}

function backoff(attempt: number, retryAfter?: string | null): number {
  const hinted = Number(retryAfter);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, 5_000);
  return Math.min(250 * 2 ** attempt, 2_000) + Math.floor(Math.random() * 100);
}
