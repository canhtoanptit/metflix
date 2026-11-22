import type { Scenario } from "./context.ts";
import { cancelAndRefund } from "./scenarios/cancel-refund.ts";
import { catalogue } from "./scenarios/catalogue.ts";
import { type DeliveryControls, deliveryAnomalies } from "./scenarios/delivery.ts";
import { renewalRecovers, retriesExhausted } from "./scenarios/dunning.ts";
import { idempotency } from "./scenarios/idempotency.ts";
import { planChange } from "./scenarios/plan-change.ts";
import { promotionCodes } from "./scenarios/promo.ts";
import { threeDSecure } from "./scenarios/three-d-secure.ts";
import { trialConverts } from "./scenarios/trial.ts";
import { trialOnce } from "./scenarios/trial-once.ts";

export interface ScenarioDefinition {
  name: string;
  title: string;
  /** first: before everything (the catalogue); main: concurrently; last: alone, at the end. */
  phase: "first" | "main" | "last";
  run: (s: Scenario, controls: DeliveryControls) => Promise<void>;
}

export const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    name: "catalogue",
    title: "Catalogue sync by lookup key, two currencies",
    phase: "first",
    run: catalogue,
  },
  {
    name: "trial-converts",
    title: "Trial with the card collected up front converts to paid",
    phase: "main",
    run: trialConverts,
  },
  {
    name: "renewal-recovers",
    title: "Renewal declines, Stripe retries, card replaced, invoice paid",
    phase: "main",
    run: renewalRecovers,
  },
  {
    name: "retries-exhausted",
    title: "Renewal left unpaid until Stripe stops retrying",
    phase: "main",
    run: retriesExhausted,
  },
  {
    name: "three-d-secure",
    title: "3-D Secure on first payment and on an off-session renewal",
    phase: "main",
    run: threeDSecure,
  },
  {
    name: "plan-change",
    title: "Upgrade and downgrade against their proration previews",
    phase: "main",
    run: planChange,
  },
  {
    name: "cancel-refund",
    title: "Cancel at period end, resume, cancel now, refunds, cancelled trial",
    phase: "main",
    run: cancelAndRefund,
  },
  {
    name: "promotion-codes",
    title: "Promotion code redemption limit and expiry",
    phase: "main",
    run: promotionCodes,
  },
  {
    name: "trial-once",
    title: "One trial per customer and per card fingerprint",
    phase: "main",
    run: trialOnce,
  },
  {
    name: "idempotency",
    title: "Idempotency keys: replay, conflict, failure, concurrency",
    phase: "main",
    run: idempotency,
  },
  {
    name: "delivery-anomalies",
    title: "Webhook duplicates, reordering, failure and outage",
    phase: "last",
    run: deliveryAnomalies,
  },
];
