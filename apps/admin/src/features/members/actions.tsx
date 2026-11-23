/**
 * The support and billing actions on a member, each a dialog that says what it will do, asks
 * why, and ends in one of the designed outcomes (components/ActionDialog.tsx). The four billing
 * actions carry an idempotency key minted when the dialog opens.
 */
import { useQueryClient } from "@tanstack/react-query";
import type {
  ConsentPurpose,
  ConsentState,
  Invoice,
  MemberDetail,
  MembershipState,
  PrivacyRequest,
  Refund,
} from "@webflix/contracts";
import { Checkbox, Field, InfoIcon, Input, RadioGroup, RadioItem } from "@webflix/ui";
import { type ReactNode, useId, useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk } from "../../api/queries.ts";
import { ActionDialog, SHOWN_IN_FIELD } from "../../components/ActionDialog.tsx";
import { DateTime, Money } from "../../components/primitives.tsx";
import {
  formatDate,
  formatMoney,
  fractionDigits,
  minorToMajorText,
  parseMajorAmount,
} from "../../lib/format.ts";
import { MEMBERSHIP } from "../../lib/status.ts";

interface DialogState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const memberAudit = (accountId: string) => ({ targetType: "member", targetId: accountId });

function useRefreshMember(accountId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: qk.member(accountId), exact: true });
  };
}

function Legend({ id, children }: { id: string; children: ReactNode }) {
  return (
    <legend id={id} className="mb-2 type-label text-fg">
      {children}
    </legend>
  );
}

// --- Support ----------------------------------------------------------------------------------

export function SignOutEverywhereDialog({
  member,
  ...dialog
}: DialogState & { member: MemberDetail }) {
  const refresh = useRefreshMember(member.account.id);
  const devices = member.activeDevices;
  return (
    <ActionDialog
      {...dialog}
      scope={`sign-out:${member.account.id}`}
      title="Sign out everywhere"
      description={`Ends every session on every device${devices > 0 ? ` (${devices} signed in now)` : ""} and stops any stream at once. The member signs in again with their password or sign-in provider.`}
      confirmLabel="Sign out everywhere"
      tone="danger"
      audit={memberAudit(member.account.id)}
      run={({ reason, signal, headers }) =>
        staffApi().signOutMemberEverywhere(
          { params: { accountId: member.account.id }, body: { reason } },
          { signal, headers },
        )
      }
      onSuccess={refresh}
      success={() =>
        "The member is signed out on every device. Their next request asks them to sign in."
      }
    />
  );
}

export function PasswordResetDialog({ member, ...dialog }: DialogState & { member: MemberDetail }) {
  return (
    <ActionDialog
      {...dialog}
      scope={`password-reset:${member.account.id}`}
      title="Send a password reset"
      description={`Emails the member a link to choose a new password, valid for 30 minutes.${member.account.hasPassword ? " Their current password keeps working until they use it." : " The account has no password yet: the link lets them set one."}`}
      confirmLabel="Send the email"
      audit={memberAudit(member.account.id)}
      run={({ reason, signal, headers }) =>
        staffApi().sendMemberPasswordReset(
          { params: { accountId: member.account.id }, body: { reason } },
          { signal, headers },
        )
      }
      success={() =>
        "The reset email is on its way to the member's address. Ask them to check spam if it hasn't arrived in a few minutes."
      }
    />
  );
}

export function RemovePinDialog({
  member,
  profile,
  ...dialog
}: DialogState & { member: MemberDetail; profile: MemberDetail["profiles"][number] }) {
  const refresh = useRefreshMember(member.account.id);
  return (
    <ActionDialog
      {...dialog}
      scope={`remove-pin:${member.account.id}:${profile.id}`}
      title={`Remove the PIN from “${profile.name}”`}
      description="Anyone using the account can then open this profile without a PIN. The member can set a new PIN from their account."
      confirmLabel="Remove PIN"
      tone="danger"
      audit={memberAudit(member.account.id)}
      run={({ reason, signal, headers }) =>
        staffApi().removeProfilePin(
          { params: { accountId: member.account.id, profileId: profile.id }, body: { reason } },
          { signal, headers },
        )
      }
      onSuccess={refresh}
      success={() => `“${profile.name}” has no PIN now.`}
    />
  );
}

/**
 * Staff record a withdrawal only (privacy review M4): turning a purpose on is the member's own
 * answer, in Account › Privacy, where it outranks Global Privacy Control and the opt-in prompt.
 * Offered for the purposes in force now; the server refuses a grant
 * (`consent_grant_member_only`) whatever the console sends.
 */
export function ConsentDialog({
  accountId,
  consent,
  ...dialog
}: DialogState & { accountId: string; consent: ConsentState }) {
  const queryClient = useQueryClient();
  const withdrawable = withdrawablePurposes(consent);
  const [purpose, setPurpose] = useState<ConsentPurpose>(withdrawable[0] ?? "analytics");
  const purposeId = useId();
  return (
    <ActionDialog
      {...dialog}
      scope={`consent:${accountId}`}
      title="Record a consent withdrawal"
      description="When the member asks you to stop using their activity for a purpose, record it here. It takes effect at once and is marked as recorded by support."
      confirmLabel={`Withdraw ${CONSENT_PURPOSES_LABEL[purpose].toLowerCase()}`}
      tone="danger"
      audit={memberAudit(accountId)}
      run={({ reason, signal, headers }) =>
        staffApi().setMemberConsent(
          { params: { accountId }, body: { purpose, granted: false, reason } },
          { signal, headers },
        )
      }
      onSuccess={(state) =>
        queryClient.setQueryData(
          qk.memberPrivacy(accountId),
          (current: { consent: ConsentState; requests: PrivacyRequest[] } | undefined) =>
            current ? { ...current, consent: state } : current,
        )
      }
      success={(state) =>
        state.purposes[purpose].granted
          ? `${CONSENT_PURPOSES_LABEL[purpose]} is still on: another answer outranks the withdrawal. Look at the member's privacy details.`
          : `${CONSENT_PURPOSES_LABEL[purpose]} is off, recorded as asked through support. Webflix stops using the member's activity for it.`
      }
    >
      {withdrawable.length > 1 ? (
        <fieldset>
          <Legend id={purposeId}>Purpose to withdraw</Legend>
          <RadioGroup
            aria-labelledby={purposeId}
            value={purpose}
            onValueChange={(value) => setPurpose(value as ConsentPurpose)}
            className="flex flex-col gap-2"
          >
            {withdrawable.map((value) => (
              <RadioItem
                key={value}
                value={value}
                label={CONSENT_PURPOSES_LABEL[value]}
                description={CONSENT_PURPOSE_USE[value]}
              />
            ))}
          </RadioGroup>
        </fieldset>
      ) : (
        <div className="flex flex-col gap-0.5 type-body-sm">
          <p className="font-semibold text-fg">{CONSENT_PURPOSES_LABEL[purpose]}</p>
          <p className="text-fg-muted">{CONSENT_PURPOSE_USE[purpose]}</p>
        </div>
      )}
      <p className="flex items-start gap-1.5 rounded-md bg-surface-3 p-3 type-caption text-fg-muted">
        <InfoIcon size="xs" className="mt-0.5 shrink-0" />
        {MEMBER_TURNS_ON}
      </p>
    </ActionDialog>
  );
}

export const CONSENT_PURPOSES_LABEL: Record<ConsentPurpose, string> = {
  analytics: "Analytics",
  personalisation: "Personalisation",
};

const CONSENT_PURPOSE_USE: Record<ConsentPurpose, string> = {
  analytics: "Their activity counts in Webflix's measurements.",
  personalisation: "Their activity shapes their recommendations.",
};

/** Why staff can't turn a purpose on: said wherever consent is recorded. */
export const MEMBER_TURNS_ON =
  "Only the member can turn a purpose on, in Account › Privacy: it is their own choice, and it outranks Global Privacy Control and the ask-first prompt. Staff can record a withdrawal only.";

/** The purposes in force now, which staff may record as withdrawn. */
export function withdrawablePurposes(consent: ConsentState): ConsentPurpose[] {
  return (["analytics", "personalisation"] as const).filter(
    (purpose) => consent.purposes[purpose].granted,
  );
}

export function CancelDeletionDialog({
  accountId,
  request,
  ...dialog
}: DialogState & { accountId: string; request: PrivacyRequest }) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      {...dialog}
      scope={`cancel-deletion:${accountId}`}
      title="Cancel the account deletion"
      description={
        <>
          The account is due to be erased on{" "}
          {request.scheduledFor ? <DateTime value={request.scheduledFor} /> : "a date not set yet"}.
          Cancelling keeps the account exactly as it is
          {request.email === "suppressed"
            ? ". Their address bounced or complained before, so no email can tell them: let them know another way."
            : ", and the member gets an email saying so."}{" "}
          They can ask again later.
        </>
      }
      confirmLabel="Cancel deletion"
      dismissLabel="Back"
      audit={memberAudit(accountId)}
      run={({ reason, signal, headers }) =>
        staffApi().cancelMemberDeletion(
          { params: { accountId }, body: { reason } },
          { signal, headers },
        )
      }
      onSuccess={() =>
        void queryClient.invalidateQueries({ queryKey: qk.memberPrivacy(accountId), exact: true })
      }
      success={() =>
        request.email === "suppressed"
          ? "The deletion is cancelled: the account stays. No email goes to the member (their address bounced or complained before): tell them another way."
          : "The deletion is cancelled: the account stays, and an email tells the member so."
      }
    />
  );
}

// --- Billing ----------------------------------------------------------------------------------

const PROVIDER_SLOW =
  "Waiting for the payment provider. This can take up to a minute: keep this open. Sending it again can't charge or refund twice.";

function refundable(invoice: Invoice): number {
  return Math.max(0, invoice.amountPaid.amountMinor - invoice.amountRefunded.amountMinor);
}

export function RefundDialog({
  member,
  invoice,
  ...dialog
}: DialogState & { member: MemberDetail; invoice: Invoice }) {
  const refresh = useRefreshMember(member.account.id);
  const remaining = refundable(invoice);
  const currency = invoice.amountPaid.currency;
  const [mode, setMode] = useState<"full" | "part">("full");
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const modeId = useId();
  const parsed = mode === "part" ? parseMajorAmount(amount, currency) : remaining;

  function validate(): string | null {
    if (mode === "full") return null;
    const minor = parseMajorAmount(amount, currency);
    const max = minorToMajorText(remaining, currency);
    const message =
      minor === null
        ? `Enter an amount like ${max}${fractionDigits(currency) > 0 ? "" : " (whole units)"}.`
        : minor <= 0
          ? "Enter an amount above zero."
          : minor > remaining
            ? `At most ${formatMoney({ amountMinor: remaining, currency })} is left to refund.`
            : null;
    setAmountError(message);
    return message ? SHOWN_IN_FIELD : null;
  }

  const label =
    parsed !== null && parsed > 0
      ? `Refund ${formatMoney({ amountMinor: parsed, currency })}`
      : "Refund";

  return (
    <ActionDialog<Refund>
      {...dialog}
      scope={`refund:${member.account.id}:${invoice.id}`}
      title={`Refund invoice ${invoice.number ?? invoice.id}`}
      description={
        <>
          Paid <Money amount={invoice.amountPaid} />
          {invoice.amountRefunded.amountMinor > 0 ? (
            <>
              , already refunded <Money amount={invoice.amountRefunded} />
            </>
          ) : null}
          . The money goes back to the card it came from; the invoice stays paid.
        </>
      }
      confirmLabel={label}
      tone="danger"
      idempotent
      slowNotice={PROVIDER_SLOW}
      audit={memberAudit(member.account.id)}
      validate={validate}
      run={({ reason, idempotencyKey, signal, headers }) =>
        staffApi().refundInvoice(
          {
            params: { accountId: member.account.id },
            body: {
              invoiceId: invoice.id,
              ...(mode === "part" && parsed !== null
                ? { amount: { amountMinor: parsed, currency } }
                : {}),
              reason,
              idempotencyKey,
            },
          },
          { signal, headers },
        )
      }
      onSuccess={refresh}
      success={(refund) =>
        refund.status === "succeeded"
          ? `Refunded ${formatMoney(refund.amount)} of invoice ${invoice.number ?? invoice.id}.`
          : refund.status === "pending"
            ? `The refund of ${formatMoney(refund.amount)} is accepted and the provider is still processing it. The invoice shows it once the provider confirms.`
            : `The provider refused the refund of ${formatMoney(refund.amount)}. Nothing was refunded.`
      }
    >
      <fieldset>
        <Legend id={modeId}>Amount</Legend>
        <RadioGroup
          aria-labelledby={modeId}
          value={mode}
          onValueChange={(value) => {
            setMode(value as "full" | "part");
            setAmountError(null);
          }}
          className="flex flex-col gap-2"
        >
          <RadioItem
            value="full"
            label={`Everything left: ${formatMoney({ amountMinor: remaining, currency })}`}
          />
          <RadioItem value="part" label="Part of it" />
        </RadioGroup>
      </fieldset>
      {mode === "part" ? (
        <Field
          label={`Amount to refund (${currency})`}
          error={amountError ?? undefined}
          hint={`Up to ${formatMoney({ amountMinor: remaining, currency })}.`}
        >
          <Input
            size="sm"
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            placeholder={minorToMajorText(Math.floor(remaining / 2), currency)}
            onChange={(event) => {
              setAmount(event.target.value);
              if (amountError) setAmountError(null);
            }}
          />
        </Field>
      ) : null}
    </ActionDialog>
  );
}

function membershipLine(state: MembershipState): string {
  const status = MEMBERSHIP[state.status].label;
  if (state.status === "trialing" && state.trialEndsAt) {
    return `${status}, until ${formatDate(state.trialEndsAt)}${state.cancelAtPeriodEnd ? " (then it ends)" : ""}.`;
  }
  if (state.cancelAtPeriodEnd && state.currentPeriodEnd) {
    return `${status}, ending on ${formatDate(state.currentPeriodEnd)}.`;
  }
  if (state.currentPeriodEnd && state.status !== "canceled") {
    return `${status}, renews on ${formatDate(state.currentPeriodEnd)}.`;
  }
  return `${status}.`;
}

export function CancelMembershipDialog({
  member,
  ...dialog
}: DialogState & { member: MemberDetail }) {
  const refresh = useRefreshMember(member.account.id);
  const state = member.membership;
  const periodEnd = state.status === "trialing" ? state.trialEndsAt : state.currentPeriodEnd;
  const canAtPeriodEnd = !state.cancelAtPeriodEnd && periodEnd !== null;
  const [when, setWhen] = useState<"now" | "period_end">(canAtPeriodEnd ? "period_end" : "now");
  const [refundUnused, setRefundUnused] = useState(false);
  const whenId = useId();
  return (
    <ActionDialog<MembershipState>
      {...dialog}
      scope={`cancel:${member.account.id}`}
      title="Cancel the membership"
      description={`Now: ${membershipLine(state)}`}
      confirmLabel={when === "now" ? "Cancel now" : "Cancel at period end"}
      dismissLabel="Back"
      tone="danger"
      idempotent
      multiStep={when === "now" && refundUnused}
      slowNotice={PROVIDER_SLOW}
      audit={memberAudit(member.account.id)}
      run={({ reason, idempotencyKey, signal, headers }) =>
        staffApi().cancelMemberSubscription(
          {
            params: { accountId: member.account.id },
            body: {
              when,
              ...(when === "now" ? { refundUnused } : {}),
              reason,
              idempotencyKey,
            },
          },
          { signal, headers },
        )
      }
      onSuccess={refresh}
      success={(next) => (
        <>
          <p>{membershipLine(next)}</p>
          {when === "now" && refundUnused ? (
            <p className="mt-2 text-fg-muted">
              The refund of the unused time is on the member's latest invoice when the provider made
              it; check the invoices below.
            </p>
          ) : null}
        </>
      )}
    >
      <fieldset>
        <Legend id={whenId}>When</Legend>
        <RadioGroup
          aria-labelledby={whenId}
          value={when}
          onValueChange={(value) => setWhen(value as "now" | "period_end")}
          className="flex flex-col gap-2"
        >
          {canAtPeriodEnd && periodEnd ? (
            <RadioItem
              value="period_end"
              label={`At the end of the period, on ${formatDate(periodEnd)}`}
              description="The member keeps watching until then; nothing is refunded."
            />
          ) : null}
          <RadioItem value="now" label="Now" description="Playback stops at once." />
        </RadioGroup>
      </fieldset>
      {when === "now" ? (
        <Checkbox
          checked={refundUnused}
          onCheckedChange={setRefundUnused}
          label="Refund the unused time"
          description="Refunds the part of the current period not yet used, from the latest invoice. Two steps at the provider: if the second fails, the cancellation still stands."
        />
      ) : null}
    </ActionDialog>
  );
}

function DaysField({
  label,
  value,
  onChange,
  max,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  error: string | null;
  hint: ReactNode;
}) {
  return (
    <Field label={label} error={error ?? undefined} hint={hint}>
      <Input
        size="sm"
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="max-w-32"
      />
    </Field>
  );
}

function parseDays(text: string, max: number): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return days >= 1 && days <= max ? days : null;
}

const DAY_MS = 86_400_000;

export function ExtendTrialDialog({ member, ...dialog }: DialogState & { member: MemberDetail }) {
  const refresh = useRefreshMember(member.account.id);
  const [days, setDays] = useState("7");
  const [error, setError] = useState<string | null>(null);
  const parsed = parseDays(days, 30);
  const endsAt = member.membership.trialEndsAt;
  const newEnd =
    endsAt && parsed ? new Date(new Date(endsAt).getTime() + parsed * DAY_MS).toISOString() : null;
  return (
    <ActionDialog<MembershipState>
      {...dialog}
      scope={`extend-trial:${member.account.id}`}
      title="Extend the trial"
      description={
        endsAt ? (
          <>
            The trial ends on <DateTime value={endsAt} />. Nothing is charged until it ends.
          </>
        ) : undefined
      }
      confirmLabel={parsed ? `Extend by ${parsed} ${parsed === 1 ? "day" : "days"}` : "Extend"}
      idempotent
      slowNotice={PROVIDER_SLOW}
      audit={memberAudit(member.account.id)}
      validate={() => {
        const message = parseDays(days, 30) ? null : "Enter a whole number of days from 1 to 30.";
        setError(message);
        return message ? SHOWN_IN_FIELD : null;
      }}
      run={({ reason, idempotencyKey, signal, headers }) =>
        staffApi().extendMemberTrial(
          {
            params: { accountId: member.account.id },
            body: { days: parseDays(days, 30) ?? 0, reason, idempotencyKey },
          },
          { signal, headers },
        )
      }
      onSuccess={refresh}
      success={(next) => membershipLine(next)}
    >
      <DaysField
        label="Days to add"
        value={days}
        onChange={(value) => {
          setDays(value);
          if (error) setError(null);
        }}
        max={30}
        error={error}
        hint={
          newEnd ? (
            <>
              New end: <DateTime value={newEnd} />
            </>
          ) : (
            "From 1 to 30 days."
          )
        }
      />
    </ActionDialog>
  );
}

export function ComplimentaryDialog({ member, ...dialog }: DialogState & { member: MemberDetail }) {
  const refresh = useRefreshMember(member.account.id);
  const [days, setDays] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const parsed = parseDays(days, 366);
  const state = member.membership;
  // The server starts the free time where the paid or trial time ends (or now).
  const from = Math.max(
    Date.now(),
    state.currentPeriodEnd ? Date.parse(state.currentPeriodEnd) : 0,
    state.trialEndsAt ? Date.parse(state.trialEndsAt) : 0,
  );
  const until = parsed ? new Date(from + parsed * DAY_MS).toISOString() : null;
  return (
    <ActionDialog<MembershipState>
      {...dialog}
      scope={`complimentary:${member.account.id}`}
      title="Give free time"
      description="Adds free days after the time already paid for (or the trial). Nothing is charged until they end."
      confirmLabel={
        parsed ? `Give ${parsed} free ${parsed === 1 ? "day" : "days"}` : "Give free time"
      }
      idempotent
      slowNotice={PROVIDER_SLOW}
      audit={memberAudit(member.account.id)}
      validate={() => {
        const message = parseDays(days, 366) ? null : "Enter a whole number of days from 1 to 366.";
        setError(message);
        return message ? SHOWN_IN_FIELD : null;
      }}
      run={({ reason, idempotencyKey, signal, headers }) =>
        staffApi().grantComplimentaryPeriod(
          {
            params: { accountId: member.account.id },
            body: { days: parseDays(days, 366) ?? 0, reason, idempotencyKey },
          },
          { signal, headers },
        )
      }
      onSuccess={refresh}
      success={(next) => membershipLine(next)}
    >
      <DaysField
        label="Free days"
        value={days}
        onChange={(value) => {
          setDays(value);
          if (error) setError(null);
        }}
        max={366}
        error={error}
        hint={
          until ? (
            <>
              Nothing charged until about <DateTime value={until} />
            </>
          ) : (
            "From 1 to 366 days."
          )
        }
      />
    </ActionDialog>
  );
}
