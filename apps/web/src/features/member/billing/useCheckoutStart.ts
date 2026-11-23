import {
  ApiError,
  type AppliedPromotion,
  type Checkout,
  type Money,
  type PlanId,
} from "@webflix/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { clearHandOff, handOffOf } from "./checkoutMemory.ts";
import type { DeclineReason, PromotionFailureReason } from "./copy.ts";
import { patiently } from "./polling.ts";

export type CheckoutStartState =
  | { kind: "starting" }
  /** A checkout waiting for the card: `clientSecret` is what the provider's form confirms. */
  | { kind: "ready"; checkout: Checkout & { clientSecret: string } }
  /** The checkout is past the card (or done): the confirming state takes over. */
  | { kind: "confirming"; checkoutId: string }
  /** The account already has a membership, or one that recovers with a new card instead. */
  | { kind: "conflict" }
  /** The account's deletion is scheduled: no membership can be started until it is kept. */
  | { kind: "deletion" }
  | { kind: "error"; error: unknown };

export interface AppliedCode {
  code: string;
  /** What the code does (from the checkout that carries it, or from its quote). */
  promotion: AppliedPromotion;
  /** The quoted price with it, when it was just quoted (the checkout's own amounts win). */
  discountedPrice: Money | null;
}

/**
 * Why applying or removing a code failed, and at which step: checking the code (the promo-code
 * budget) or restarting the checkout with it (either budget). The page words a `rate_limited`
 * by it, with when to try again (UX review, rate limits).
 */
export class CodeStepError extends Error {
  readonly step: "check" | "checkout";
  readonly error: unknown;
  constructor(step: "check" | "checkout", error: unknown) {
    super(`promo code ${step} failed`);
    this.step = step;
    this.error = error;
  }
}

/** A code the checkout could not keep for this plan (it applied to the plan chosen before). */
export interface DroppedCode {
  code: string;
  reason: PromotionFailureReason | undefined;
}

/** Thrown inside a start sequence that was superseded (the page moved on): not an error. */
class Superseded extends Error {}

/**
 * One `POST /billing/checkout` per plan and code at a time: a screen that mounts twice (React's
 * development double effects, a quick remount) shares the request in flight instead of racing a
 * second one against it.
 */
const inFlight = new Map<string, Promise<Checkout>>();

function startOnce(planId: PlanId, promotionCode: string | null): Promise<Checkout> {
  const key = `${planId}:${promotionCode ?? ""}`;
  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;
  const request = patiently(() =>
    api().startCheckout({ body: { planId, ...(promotionCode ? { promotionCode } : {}) } }),
  ).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/**
 * Start (or pick up) the checkout for `planId` and keep it ready for the provider's form.
 *
 * The account's checkout in progress is looked at first (`GET /billing/checkout`, on any
 * device): one past the card goes straight to the confirming state, its promo code is kept, and
 * one whose card this browser handed to the provider's form without a result coming back (the
 * Back button on the provider's page, a closed tab) is asked about once, so a decline there is
 * reported here with its reason instead of being lost. Then `POST /billing/checkout` starts one,
 * or resumes the open one (the server keeps one per account), with that code.
 */
export function useCheckoutStart(accountId: string, planId: PlanId, enabled: boolean) {
  const [state, setState] = useState<CheckoutStartState>({ kind: "starting" });
  const [declined, setDeclined] = useState<DeclineReason | null>(null);
  const [applied, setApplied] = useState<AppliedCode | null>(null);
  const [dropped, setDropped] = useState<DroppedCode | null>(null);
  /** Whether the account can still have a free trial (the server's answer; null until known). */
  const [trialEligible, setTrialEligible] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The current sequence: anything an older one would set is dropped. */
  const generation = useRef(0);

  /** Start (or resume) with `promotionCode`; the code shown is the one the checkout carries. */
  const start = useCallback(
    async (
      promotionCode: string | null,
      owner: number,
      quoted: Money | null = null,
    ): Promise<void> => {
      const checkout = await startOnce(planId, promotionCode);
      if (owner !== generation.current) throw new Superseded();
      setApplied(
        checkout.promotion
          ? {
              code: checkout.promotion.code,
              promotion: checkout.promotion,
              discountedPrice: quoted,
            }
          : null,
      );
      if (checkout.status === "requires_setup" && checkout.clientSecret) {
        setState({ kind: "ready", checkout: { ...checkout, clientSecret: checkout.clientSecret } });
      } else {
        setState({ kind: "confirming", checkoutId: checkout.id });
      }
    },
    [planId],
  );

  useEffect(() => {
    generation.current += 1;
    const owner = generation.current;
    if (!enabled) return;
    const current = () => {
      if (owner !== generation.current) throw new Superseded();
    };
    setState({ kind: "starting" });
    const run = async () => {
      const answer = await patiently(() => api().getOpenCheckout());
      current();
      const open = answer.checkout;
      setTrialEligible(answer.trialEligible ?? null);
      const code: string | null = open?.promotion?.code ?? null;
      if (open) {
        const pastTheCard =
          open.status === "processing" ||
          (open.status === "requires_payment" && open.planId === planId);
        if (pastTheCard) {
          setState({ kind: "confirming", checkoutId: open.id });
          return;
        }
        if (open.status === "requires_setup" && handOffOf(accountId, open.id) === "setup") {
          const id = open.id;
          clearHandOff();
          try {
            const confirmed = await patiently(() => api().confirmCheckout({ params: { id } }));
            current();
            setState({ kind: "confirming", checkoutId: confirmed.id });
            return;
          } catch (error) {
            current();
            if (ApiError.is(error, "payment_declined")) {
              setDeclined(error.problem.declineReason);
            } else if (!ApiError.is(error, "checkout_state_conflict")) {
              throw error;
            }
            // checkout_state_conflict: the card was never confirmed there. Carry on.
          }
        }
      }
      // The code the open checkout carries is sent again as it is (free: it never spends the
      // promo-code budget, and it is never checked again here). Only the server's refusal of it
      // for this plan drops it, and the page says so; a `rate_limited` never does.
      try {
        await start(code, owner);
      } catch (error) {
        if (code && ApiError.is(error, "promotion_code_invalid")) {
          current();
          setDropped({ code, reason: error.problem.promotionReason });
          await start(null, owner);
          return;
        }
        throw error;
      }
    };
    run().catch((error: unknown) => {
      if (error instanceof Superseded || owner !== generation.current) return;
      setState(
        ApiError.is(error, "account_deletion_scheduled")
          ? { kind: "deletion" }
          : ApiError.is(error, "checkout_state_conflict")
            ? { kind: "conflict" }
            : { kind: "error", error },
      );
    });
    return () => {
      generation.current += 1;
    };
  }, [accountId, planId, start, attempt, enabled]);

  /**
   * Check a code against this plan, then attach it to the checkout. Throws a `CodeStepError`
   * naming the step that refused (the code's own refusal, or a limit), and changes nothing then.
   */
  const applyCode = useCallback(
    async (code: string) => {
      const owner = generation.current;
      let quote: Awaited<ReturnType<ReturnType<typeof api>["validatePromotion"]>>;
      try {
        quote = await api().validatePromotion({ body: { code, planId } });
      } catch (error) {
        throw new CodeStepError("check", error);
      }
      try {
        await start(quote.promotion.code, owner, quote.discountedPrice);
        setDropped(null);
      } catch (error) {
        if (error instanceof Superseded) throw error;
        throw new CodeStepError("checkout", error);
      }
    },
    [planId, start],
  );

  /** Restart the checkout without its code. Throws a `CodeStepError`; the code stays then. */
  const removeCode = useCallback(async () => {
    try {
      await start(null, generation.current);
    } catch (error) {
      if (error instanceof Superseded) throw error;
      throw new CodeStepError("checkout", error);
    }
  }, [start]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { state, declined, applied, dropped, trialEligible, applyCode, removeCode, retry };
}
