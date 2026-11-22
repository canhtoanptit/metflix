import type { PaymentProviderId } from "@webflix/contracts";
import { AppError } from "../../errors.ts";
import {
  billingIdempotencyKey,
  type PaymentFailureCode,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderCall,
} from "../../ports/payment-provider.ts";
import { createHmacTokenSigner, type TokenSigner } from "../../ports/token-signer.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { AreaSeams } from "../module.ts";
import type { BillingOperationKind, DeclineReason } from "./repository.ts";

/**
 * The membership record kept changing under a sync (other replicas or the worker writing it):
 * nothing was written; reading again later succeeds. Transient, like a provider's `unavailable`.
 */
export class ProjectionContendedError extends Error {
  override readonly name = "ProjectionContendedError";
}

/**
 * A failure that is an ordinary event with several replicas and says nothing about the
 * membership (finding K12): the provider briefly unavailable or rate limited, the same
 * idempotent call in flight elsewhere (the fake's `unavailable`, Stripe's 409
 * `idempotency_key_in_use`), or the projection contended. A request that meets one answers
 * the current state where it has one, else a retryable `service_unavailable`.
 */
export function isTransient(error: unknown): boolean {
  return (
    (error instanceof PaymentProviderError && error.retryable) ||
    error instanceof ProjectionContendedError
  );
}

/** For logs: which transient failure it was (never a provider message). */
export function transientReason(error: unknown): string {
  if (error instanceof PaymentProviderError) return error.code;
  return error instanceof ProjectionContendedError ? "projection_contended" : "unknown";
}

/** What every part of the billing area works with, built once per service. */
export interface BillingContext {
  deps: ServiceDependencies;
  seams: AreaSeams;
  payments: PaymentProvider;
  provider: PaymentProviderId;
  graceSec: number;
  /** Signs plan-change preview tokens (purpose-bound, with the deployment's token keys). */
  signer: TokenSigner;
  now(): number;
}

export function createBillingContext(deps: ServiceDependencies, seams: AreaSeams): BillingContext {
  return {
    deps,
    seams,
    payments: deps.payments,
    provider: deps.payments.id,
    graceSec: deps.config.billing.graceSec,
    signer: createHmacTokenSigner({ keys: deps.config.media.tokenKeys, clock: deps.clock }),
    now: () => deps.clock.now(),
  };
}

/**
 * One attempt of a money-moving provider call (§5.3): recorded in `billing_operations` before
 * the call, with the key `billingIdempotencyKey(operation, attempt)`, then marked with its
 * outcome. Calling again with the same operation and attempt sends the same key, so the
 * provider replays the first outcome instead of charging twice (a decline included).
 */
export async function providerCall<T>(
  context: BillingContext,
  operation: { id: string; attempt: number; kind: BillingOperationKind; accountId: string },
  run: (call: ProviderCall) => Promise<T>,
  ref: (result: T) => string | null = () => null,
): Promise<T> {
  const { repos, clock } = context.deps;
  const idempotencyKey = billingIdempotencyKey(operation.id, operation.attempt);
  const now = clock.now();
  const rowId = `${operation.id}:${operation.attempt}`;
  await repos.billing.startOperation({
    id: rowId,
    accountId: operation.accountId,
    kind: operation.kind,
    attempt: operation.attempt,
    idempotencyKey,
    status: "pending",
    provider: context.provider,
    providerRef: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  });
  try {
    const result = await run({ idempotencyKey });
    await repos.billing.finishOperation(
      rowId,
      operation.attempt,
      { status: "succeeded", providerRef: ref(result), errorCode: null },
      clock.now(),
    );
    return result;
  } catch (error) {
    if (error instanceof PaymentProviderError && !error.retryable) {
      await repos.billing.finishOperation(
        rowId,
        operation.attempt,
        { status: "failed", providerRef: null, errorCode: error.code },
        clock.now(),
      );
    }
    throw error;
  }
}

/**
 * The attempt to use for an operation: the first, or the one after a declined attempt (a
 * decline is replayed under its key, so trying again with a fixed card needs a new key), or the
 * same one when the last attempt's outcome is unknown or succeeded (replayed, never repeated).
 */
export async function nextAttempt(context: BillingContext, operationId: string): Promise<number> {
  let attempt = 1;
  for (;;) {
    const existing = await context.deps.repos.billing.findOperationByKey(
      billingIdempotencyKey(operationId, attempt),
    );
    if (existing?.status !== "failed") return attempt;
    attempt += 1;
  }
}

const DECLINES: Partial<Record<PaymentFailureCode, DeclineReason>> = {
  card_declined: "card_declined",
  insufficient_funds: "insufficient_funds",
  expired_card: "expired_card",
  incorrect_cvc: "card_declined",
  processing_error: "card_declined",
  authentication_required: "card_declined",
};

/** A provider failure as Webflix's decline reason (never the provider's own message). */
export function declineReason(code: PaymentFailureCode | null): DeclineReason {
  return (code && DECLINES[code]) ?? "card_declined";
}

/**
 * A provider refusal as the member's error: declines are `payment_declined`; an outage is
 * `service_unavailable` (retry); anything else is a conflict with what the provider holds.
 */
export function providerProblem(error: unknown): unknown {
  if (error instanceof ProjectionContendedError) {
    return new AppError("service_unavailable", {
      detail: "The membership is being updated. Try again in a moment.",
    });
  }
  if (!(error instanceof PaymentProviderError)) return error;
  if (error.code in DECLINES) {
    return new AppError("payment_declined", { declineReason: declineReason(error.code) });
  }
  if (error.retryable) {
    return new AppError("service_unavailable", {
      detail: "The payment provider is not answering. Try again in a moment.",
    });
  }
  return new AppError("checkout_state_conflict", {
    detail: "The payment provider refused this change in the membership's current state.",
  });
}
