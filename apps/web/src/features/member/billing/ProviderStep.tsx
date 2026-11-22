import { useQuery } from "@tanstack/react-query";
import type { BillingConfig } from "@webflix/contracts";
import { ArrowRightIcon, Button, LockIcon, Skeleton } from "@webflix/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { queries } from "../../../app/query/queries.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { type DeclineCopy, describeDecline } from "./copy.ts";
import { leaveFor } from "./navigation.ts";
import {
  declineReasonOf,
  loadStripe,
  type StripeElements,
  type StripeJs,
  stripeAppearance,
} from "./stripe.ts";

/** Which payment provider this deployment uses (`GET /billing/config`). */
export function useBillingConfig() {
  return useQuery(queries.billingConfig());
}

/** A provider that can take payment (`none` cannot). */
export type PaymentProviderConfig = Exclude<BillingConfig, { provider: "none" }>;

/** What the provider's form confirms: the card (a setup) or a first payment. */
export interface ProviderIntent {
  kind: "setup" | "payment";
  clientSecret: string;
}

/**
 * The fake provider's hosted form for a client secret, sending the browser back to `returnPath`
 * (same origin) with `payment=succeeded` once confirmed.
 */
export function fakeFormHref(formUrl: string, clientSecret: string, returnPath: string): string {
  const url = new URL(formUrl, window.location.origin);
  url.searchParams.set("secret", clientSecret);
  url.searchParams.set("return", returnPath);
  return url.origin === window.location.origin ? `${url.pathname}${url.search}` : url.href;
}

export interface ProviderStepProps {
  config: PaymentProviderConfig;
  intent: ProviderIntent;
  /** Same-origin path the provider returns to (a redirect, or a 3-D Secure page). */
  returnPath: string;
  submitLabel: string;
  /** About to hand the card to the provider; the step stays busy until it returns. */
  onHandOff?: () => void;
  /** Confirmed in place (Stripe, no redirect needed): carry on as a return would. */
  onConfirmed: () => void;
  /** Small print under the button. */
  footnote?: ReactNode;
}

/**
 * The provider's own form, the only part of checkout that differs between providers. Card
 * details are typed into the provider's page (the fake provider's hosted form under `/_pay`) or
 * its iframe (Stripe's Payment Element), and never into Webflix's: this component holds no card
 * field and sends nothing to the API.
 */
export function ProviderStep(props: ProviderStepProps) {
  return props.config.provider === "stripe" ? (
    <StripeStep {...props} publishableKey={props.config.publishableKey} />
  ) : (
    <HostedFormStep {...props} formUrl={props.config.formUrl} />
  );
}

/** The provider's hosted page: the member goes there, then comes straight back. */
function HostedFormStep({
  intent,
  returnPath,
  submitLabel,
  onHandOff,
  footnote,
  formUrl,
}: ProviderStepProps & { formUrl: string }) {
  const [leaving, setLeaving] = useState(false);
  // Coming back with the Back button restores this page from the cache: not busy any more.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3 rounded-lg border border-line-subtle bg-surface-1 px-4 py-3.5">
        <LockIcon size="md" className="mt-0.5 text-fg-muted" />
        <p className="type-body-sm text-fg-muted">
          {intent.kind === "setup"
            ? "You'll add your card on our payment provider's secure page, then come straight back here."
            : "You'll confirm the payment on our payment provider's secure page, then come straight back here."}{" "}
          Webflix never sees your card number.
        </p>
      </div>
      <Button
        variant="accent"
        size="lg"
        fullWidth
        iconAfter={ArrowRightIcon}
        loading={leaving}
        onClick={() => {
          if (leaving) return;
          setLeaving(true);
          onHandOff?.();
          leaveFor(fakeFormHref(formUrl, intent.clientSecret, returnPath));
        }}
      >
        {submitLabel}
      </Button>
      {footnote}
    </div>
  );
}

/**
 * Stripe's Payment Element in the page; 3-D Secure opens in Stripe's own frame, and a payment
 * method that must leave the page returns to `returnPath`.
 */
function StripeStep({
  intent,
  returnPath,
  submitLabel,
  onHandOff,
  onConfirmed,
  footnote,
  publishableKey,
}: ProviderStepProps & { publishableKey: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [stripe, setStripe] = useState<StripeJs | null>(null);
  const [elements, setElements] = useState<StripeElements | null>(null);
  const [ready, setReady] = useState(false);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState<DeclineCopy | null>(null);
  // A first payment confirms the card already saved (no element); the element only appears if
  // Stripe asks for a payment method after all.
  const [needsElement, setNeedsElement] = useState(intent.kind === "setup");

  useEffect(() => {
    let cancelled = false;
    loadStripe(publishableKey).then(
      (loaded) => !cancelled && setStripe(loaded),
      () => !cancelled && setFailedToLoad(true),
    );
    return () => {
      cancelled = true;
    };
  }, [publishableKey]);

  useEffect(() => {
    if (!stripe || !host.current || !needsElement) return;
    const created = stripe.elements({
      clientSecret: intent.clientSecret,
      appearance: stripeAppearance(),
    });
    const element = created.create("payment", { layout: "tabs" });
    element.on("ready", () => setReady(true));
    element.on("loaderror", () => setFailedToLoad(true));
    element.mount(host.current);
    setElements(created);
    return () => {
      element.destroy();
      setElements(null);
      setReady(false);
    };
  }, [stripe, intent.clientSecret, needsElement]);

  const returnUrl = new URL(returnPath, window.location.origin).href;

  const confirm = async () => {
    if (!stripe || busy) return;
    setBusy(true);
    setDeclined(null);
    onHandOff?.();
    const result =
      intent.kind === "setup" && elements
        ? await stripe.confirmSetup({
            elements,
            confirmParams: { return_url: returnUrl },
            redirect: "if_required",
          })
        : await stripe.confirmPayment({
            ...(elements ? { elements } : { clientSecret: intent.clientSecret }),
            confirmParams: { return_url: returnUrl },
            redirect: "if_required",
          });
    setBusy(false);
    if (!result.error) {
      onConfirmed();
      return;
    }
    if (result.error.type === "validation_error") return; // shown by the element itself
    if (!elements && result.error.code === "payment_intent_unexpected_state") {
      setNeedsElement(true);
      return;
    }
    setDeclined(describeDecline(declineReasonOf(result.error)));
  };

  if (failedToLoad) {
    return (
      <FormAlert title="The payment form didn't load">
        Check your connection, then reload this page. Nothing has been charged.
      </FormAlert>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {declined ? (
        <FormAlert title={declined.title}>{declined.body} Nothing was charged.</FormAlert>
      ) : null}
      {needsElement ? (
        <div className="relative min-h-56">
          {ready ? null : <Skeleton className="absolute inset-0" radius="card" />}
          <div ref={host} className={ready ? undefined : "opacity-0"} />
        </div>
      ) : null}
      <Button
        variant="accent"
        size="lg"
        fullWidth
        loading={busy}
        disabled={!stripe || (needsElement && !ready)}
        onClick={() => void confirm()}
      >
        {submitLabel}
      </Button>
      {footnote}
    </div>
  );
}
