import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { ApiError, type PaymentMethodSetup } from "@webflix/contracts";
import { Button, CreditCardIcon, ErrorState, Skeleton, Spinner } from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { forgetSetup, rememberedSetup, rememberSetup } from "../billing/checkoutMemory.ts";
import { type DeclineReason, describeDecline } from "../billing/copy.ts";
import { NoProviderNotice } from "../billing/NoProviderNotice.tsx";
import { leaveFor } from "../billing/navigation.ts";
import { fakeFormHref, ProviderStep, useBillingConfig } from "../billing/ProviderStep.tsx";
import { patiently, usePoll } from "../billing/polling.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatLongDate } from "../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { AccountHeading, AccountSection } from "./AccountLayout.tsx";
import {
  describeCard,
  describeExpiry,
  isLegacyMembership,
  membershipOfDetails,
  useAccountDetails,
} from "./membership.ts";

const route = getRouteApi("/account/account/membership/payment");

type Step =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "form"; setup: PaymentMethodSetup & { clientSecret: string } }
  | { kind: "checking"; setupId: string }
  | { kind: "done"; recovered: boolean }
  | { kind: "failed"; reason: DeclineReason | null }
  /** Back from the provider's page without a card confirmed (the member chose to return). */
  | { kind: "not-added" }
  | { kind: "error"; error: unknown };

function returnPathFor(setupId: string): string {
  return `/account/membership/payment?setup=${encodeURIComponent(setupId)}`;
}

/**
 * Replace the card (docs/BLUEPRINT-M2.md §5.4): the provider's setup flow confirms the new card
 * in its own form, and the provider makes it the default. For a payment that failed, the server
 * then asks the provider to pay what is due, which ends the grace period or the hold. Webflix's
 * page never sees the card; it waits for the server to report the change.
 */
export function AccountPaymentMethodPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const details = useAccountDetails();
  const config = useBillingConfig();
  const remembered = rememberedSetup(session.account.id);
  const returnedSetup = search.setup ?? remembered?.setupId ?? null;
  const [step, setStep] = useState<Step>(() =>
    returnedSetup ? { kind: "checking", setupId: returnedSetup } : { kind: "idle" },
  );
  const outcomeRef = useRef<HTMLDivElement>(null);
  const wasUnpaid = useRef<boolean | null>(null);

  // Back from the provider's page within the app (or a link carrying a card change): check it.
  useEffect(() => {
    if (!search.setup) return;
    const setupId = search.setup;
    setStep((current) =>
      current.kind === "idle" || current.kind === "form" || current.kind === "starting"
        ? { kind: "checking", setupId }
        : current,
    );
  }, [search.setup]);

  // Whether this card change restores an unpaid membership: known when the card went to the
  // provider (the membership may already be active again by the time the member is back).
  if (wasUnpaid.current === null && remembered) wasUnpaid.current = remembered.recovering;
  if (details.data && wasUnpaid.current === null) {
    const status = membershipOfDetails(details.data).membership.status;
    wasUnpaid.current = status === "past_due" || status === "suspended";
  }

  // Waiting on a card confirmed at the provider: the server finishes the change (and pays an
  // open invoice) on its own time; "processing" and a 503 are ordinary while it does.
  const checking = step.kind === "checking" ? step.setupId : null;
  const poll = usePoll(
    `setup:${checking}`,
    () => api().getPaymentMethodSetup({ params: { id: checking ?? "" } }),
    {
      active: checking !== null,
      settled: (setup) => setup.status === "succeeded" || setup.status === "failed",
    },
  );
  useEffect(() => {
    if (!checking) return;
    if (poll.error) {
      forgetSetup();
      setStep(
        ApiError.is(poll.error, "not_found")
          ? { kind: "idle" }
          : { kind: "error", error: poll.error },
      );
      return;
    }
    const setup = poll.value;
    if (!setup) return;
    if (setup.status === "succeeded") {
      forgetSetup();
      void queryClient.invalidateQueries({ queryKey: qk.account.details() });
      void queryClient.invalidateQueries({ queryKey: qk.account.billing() });
      void queryClient.invalidateQueries({ queryKey: qk.session() });
      setStep({ kind: "done", recovered: wasUnpaid.current === true });
      void navigate({ to: "/account/membership/payment", search: {}, replace: true });
    } else if (setup.status === "failed") {
      forgetSetup();
      setStep({ kind: "failed", reason: setup.failureReason ?? null });
      void navigate({ to: "/account/membership/payment", search: {}, replace: true });
    } else if (
      setup.status === "requires_confirmation" &&
      search.payment !== "succeeded" &&
      search.redirect_status !== "succeeded"
    ) {
      // Back from the provider's page without a card confirmed: nothing changed. The form says
      // `payment=failed` for a member who chose to return as well as for a refusal, and a
      // refusal would read `failed` here: so this one was not refused.
      forgetSetup();
      setStep(search.payment === "failed" ? { kind: "not-added" } : { kind: "idle" });
      void navigate({ to: "/account/membership/payment", search: {}, replace: true });
    }
  }, [
    checking,
    poll.value,
    poll.error,
    queryClient,
    navigate,
    search.payment,
    search.redirect_status,
  ]);

  useEffect(() => {
    if (step.kind === "done" || step.kind === "failed" || step.kind === "not-added") {
      outcomeRef.current?.focus();
    }
  }, [step.kind]);

  /**
   * One click to the provider (UX review 3.14): with the provider's hosted page, "Replace card"
   * goes straight there; Stripe's form is part of this page, so it opens here instead.
   */
  const start = async (unpaidNow: boolean) => {
    setStep({ kind: "starting" });
    try {
      const setup = await patiently(() => api().setupPaymentMethod());
      if (!setup.clientSecret) throw new Error("The card change carries no client secret");
      const provider = config.data;
      if (provider?.provider === "fake") {
        rememberSetup({ accountId: session.account.id, setupId: setup.id, recovering: unpaidNow });
        leaveFor(fakeFormHref(provider.formUrl, setup.clientSecret, returnPathFor(setup.id)));
        return;
      }
      setStep({ kind: "form", setup: { ...setup, clientSecret: setup.clientSecret } });
    } catch (error) {
      setStep({ kind: "error", error });
    }
  };

  if (details.isPending || config.isPending) {
    return (
      <>
        <AccountHeading title="Payment method" />
        <Skeleton className="h-48 w-full" radius="card" />
      </>
    );
  }
  if (details.isError) {
    return (
      <>
        <AccountHeading title="Payment method" />
        <ErrorState
          title="We couldn't load your payment method"
          description={describeError(details.error).description}
          action={
            <Button variant="accent" onClick={() => void details.refetch()}>
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const view = membershipOfDetails(details.data);
  const { membership } = view;
  const card = details.data.paymentMethod;
  const canChange =
    !demo &&
    !isLegacyMembership(view) &&
    ["trialing", "active", "past_due", "suspended"].includes(membership.status);
  const unpaid = membership.status === "past_due" || membership.status === "suspended";

  return (
    <>
      <AccountHeading
        title="Payment method"
        description={
          unpaid
            ? "Add a card that works and we'll charge what's due, so your membership carries on."
            : "The card your membership is charged to."
        }
      />
      {step.kind === "done" ? (
        <FormAlert
          ref={outcomeRef}
          tone="positive"
          title={step.recovered ? "Your payment went through" : "Your card has been updated"}
          action={
            <Link
              to="/account/membership"
              className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
            >
              Back to membership
            </Link>
          }
        >
          {step.recovered
            ? "Your new card is on file and what was due has been paid. Your membership is active again."
            : "Future payments are charged to your new card."}
        </FormAlert>
      ) : step.kind === "failed" ? (
        <FormAlert
          ref={outcomeRef}
          title={step.reason ? describeDecline(step.reason).title : "Your card wasn't saved"}
        >
          {step.reason
            ? describeDecline(step.reason).body
            : "The payment provider couldn't confirm it. Try another card."}{" "}
          Your card on file hasn't changed and nothing was charged.
        </FormAlert>
      ) : step.kind === "not-added" ? (
        <FormAlert ref={outcomeRef} tone="info" title="No new card was added">
          You came back from the payment page before a card was confirmed. Your card on file hasn't
          changed.
        </FormAlert>
      ) : step.kind === "error" ? (
        <FormAlert title={describeMemberError(step.error).title}>
          {ApiError.is(step.error, "payments_not_configured")
            ? "Webflix can't take payments right now."
            : describeMemberError(step.error).description}{" "}
          Your card on file hasn't changed.
        </FormAlert>
      ) : null}
      {unpaid && step.kind !== "done" ? (
        <FormAlert
          tone="danger"
          title={
            membership.status === "past_due"
              ? "We couldn't take your last payment"
              : "Your membership is on hold"
          }
        >
          {membership.status === "past_due" && membership.graceEndsAt
            ? `You can keep watching until ${formatLongDate(membership.graceEndsAt)}. Replace your card before then and we'll charge what's due.`
            : "Watching is paused. Replace your card and we'll charge what's due to restart your membership."}
        </FormAlert>
      ) : null}

      <AccountSection title="Card on file">
        <div className="flex items-center gap-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-surface-3 text-fg-muted">
            <CreditCardIcon size="md" />
          </span>
          <div className="flex min-w-0 flex-col">
            <p className="type-label text-fg">{card ? describeCard(card) : "No card on file"}</p>
            {card ? <p className="type-body-sm text-fg-muted">{describeExpiry(card)}</p> : null}
          </div>
        </div>
      </AccountSection>

      {config.data?.provider === "none" ? (
        <NoProviderNotice title="Cards can't be changed here right now">
          Webflix can't take payments right now, so the card on file can't be replaced. Nothing has
          been charged.
        </NoProviderNotice>
      ) : !canChange ? (
        <p className="type-body-sm text-fg-muted">
          {demo
            ? "The demo account's payment method can't be changed."
            : isLegacyMembership(view)
              ? "This membership is billed by Webflix's built-in test billing, so its card can't be replaced here."
              : "There's no running membership to charge, so there's no card to replace."}
        </p>
      ) : step.kind === "checking" ? (
        <div
          className="flex items-center gap-3 rounded-xl border border-line-subtle bg-surface-1 p-5"
          role="status"
        >
          <Spinner size="md" label={null} />
          <p className="type-body text-fg-muted">
            {poll.troubled
              ? "We're having trouble reaching Webflix. Still checking your new card…"
              : unpaid
                ? "Saving your new card and paying what's due…"
                : "Saving your new card…"}
          </p>
        </div>
      ) : step.kind === "form" && config.data ? (
        <AccountSection title="New card">
          <ProviderStep
            config={config.data}
            intent={{ kind: "setup", clientSecret: step.setup.clientSecret }}
            returnPath={returnPathFor(step.setup.id)}
            submitLabel={
              config.data.provider === "stripe" ? "Save card" : "Continue to add your card"
            }
            onHandOff={() =>
              rememberSetup({
                accountId: session.account.id,
                setupId: step.setup.id,
                recovering: unpaid,
              })
            }
            onConfirmed={() => setStep({ kind: "checking", setupId: step.setup.id })}
            footnote={
              <p className="type-body-sm text-fg-subtle">
                {unpaid
                  ? "Once the card is confirmed, we charge what's due to it."
                  : "Nothing is charged now: your next payment goes to the new card."}
              </p>
            }
          />
        </AccountSection>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              variant="accent"
              size="lg"
              loading={step.kind === "starting"}
              onClick={() => void start(unpaid)}
            >
              {card ? "Replace card" : "Add a card"}
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link to="/account/membership">Back to membership</Link>
            </Button>
          </div>
          {config.data?.provider === "fake" ? (
            <p className="type-body-sm text-fg-subtle">
              You'll add the new card on our payment provider's secure page, then come straight back
              here. Webflix never sees your card number.{" "}
              {unpaid
                ? "Once the card is confirmed, we charge what's due to it."
                : "Nothing is charged now: your next payment goes to the new card."}
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}
