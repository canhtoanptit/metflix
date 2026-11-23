/**
 * One member: who they are and how they stand (sign-in, membership, profiles, devices, invoices,
 * privacy), and the actions support and billing can take. Opening it is audited
 * (`member.viewed`); the privacy view is a separate audited read, loaded only when asked for.
 *
 * Controls appear only where they can work: "extend the trial" only during a trial, "remove
 * PIN" only on a locked profile, "refund" only while money is left on an invoice, nothing the
 * server protects on the shared demo account. A billing action that would apply but needs a
 * role the staff member lacks is shown, unavailable, with the role it needs (UX review 2.16):
 * they learn it exists and whom to ask, and nothing is sent.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Invoice, MemberDetail } from "@webflix/contracts";
import { ApiError } from "@webflix/contracts";
import {
  Badge,
  Button,
  ChevronLeftIcon,
  EyeIcon,
  InfoIcon,
  KeyIcon,
  LockIcon,
  LogOutIcon,
  RefreshIcon,
  ShieldIcon,
  UnlockIcon,
} from "@webflix/ui";
import { type ReactNode, useId, useRef, useState } from "react";
import { useStaff } from "../../access/staff.tsx";
import { qk, queries } from "../../api/queries.ts";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import {
  DateTime,
  Identifier,
  KeyValueList,
  Money,
  PageHeader,
  Section,
  StatusBadge,
  YesNo,
} from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingPage, LoadingRows } from "../../components/states.tsx";
import { formatDate, formatDateRange, plural } from "../../lib/format.ts";
import { useDocumentTitle } from "../../lib/hooks.ts";
import {
  ENTITLEMENT,
  INVOICE,
  MEMBERSHIP,
  PRIVACY_REQUEST,
  planName,
  SUSPENDED_REASON,
} from "../../lib/status.ts";
import {
  CancelDeletionDialog,
  CancelMembershipDialog,
  CONSENT_PURPOSES_LABEL,
  ComplimentaryDialog,
  ConsentDialog,
  ExtendTrialDialog,
  PasswordResetDialog,
  RefundDialog,
  RemovePinDialog,
  SignOutEverywhereDialog,
  withdrawablePurposes,
} from "./actions.tsx";

const route = getRouteApi("/members/$accountId");

const ENTITLED = new Set(["trialing", "active", "past_due"]);
const PROVIDERS: Record<string, string> = { stripe: "Stripe", fake: "Test provider" };
const ISSUERS: Record<string, string> = { google: "Google", apple: "Apple", keycloak: "Keycloak" };
const CONSENT_SOURCES: Record<string, string> = {
  banner: "the member, when asked",
  settings: "the member, in Account › Privacy",
  gpc: "Global Privacy Control",
  support: "support, at the member's request",
};

/**
 * An action the staff member's roles don't cover: shown, unavailable (focusable, so it is read
 * out with the reason `describedBy` points at), and never sent.
 */
function LockedAction({ label, describedBy }: { label: string; describedBy: string }) {
  return (
    <Button
      size="sm"
      variant="outline"
      icon={LockIcon}
      aria-disabled="true"
      aria-describedby={describedBy}
      onClick={(event) => event.preventDefault()}
    >
      {label}
    </Button>
  );
}

export function MemberPage() {
  useDocumentTitle("Member");
  const { accountId } = route.useParams();
  const member = useQuery(queries.member(accountId));

  if (member.isPending) return <LoadingPage label="Loading the member" />;
  if (member.isError) {
    const missing = ApiError.is(member.error, "not_found");
    return (
      <>
        <BackToSearch />
        <ErrorPanel
          layout="page"
          error={member.error}
          title={missing ? "No member with this account ID" : undefined}
          onRetry={() => void member.refetch()}
        />
      </>
    );
  }
  return (
    <MemberView
      member={member.data}
      refreshing={member.isFetching}
      onRefresh={() => void member.refetch()}
    />
  );
}

function BackToSearch() {
  return (
    <Link
      to="/members"
      className="focus-ring mb-3 inline-flex items-center gap-1 rounded-xs type-body-sm text-fg-muted hover:text-fg"
    >
      <ChevronLeftIcon size="sm" />
      Members
    </Link>
  );
}

function MemberView({
  member,
  refreshing,
  onRefresh,
}: {
  member: MemberDetail;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const staff = useStaff();
  const { account } = member;
  return (
    <>
      <BackToSearch />
      <PageHeader
        title={account.email}
        eyebrow="Member"
        actions={
          <Button
            variant="outline"
            size="sm"
            icon={RefreshIcon}
            loading={refreshing}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        }
      >
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Identifier value={account.id} label="account ID" />
          <StatusBadge tone={MEMBERSHIP[member.membership.status].tone}>
            {MEMBERSHIP[member.membership.status].label}
          </StatusBadge>
          {account.isDemo ? (
            <Badge tone="info" size="sm">
              Demo account
            </Badge>
          ) : null}
        </div>
      </PageHeader>
      {account.isDemo ? (
        <p className="mb-6 flex items-start gap-2 rounded-md border border-info/40 p-3 type-body-sm text-fg-muted">
          <InfoIcon size="sm" className="mt-0.5 shrink-0 text-info" />
          This is the shared demo account. Its sign-in, sessions, profiles and membership can't be
          changed, so those actions aren't offered.
        </p>
      ) : null}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <MembershipSection member={member} />
          <InvoicesSection member={member} canRefund={staff.has("billing")} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <AccountSection member={member} />
          <ProfilesSection member={member} />
          <PrivacySection accountId={account.id} />
        </div>
      </div>
    </>
  );
}

function useDialog() {
  const [open, setOpen] = useState(false);
  return { open, onOpenChange: setOpen, show: () => setOpen(true) };
}

function MembershipSection({ member }: { member: MemberDetail }) {
  const staff = useStaff();
  const state = member.membership;
  const entitlement = member.entitlement;
  const billing = staff.has("billing");
  const lockedNote = useId();
  const cancel = useDialog();
  const extend = useDialog();
  const free = useDialog();
  const entitled = ENTITLED.has(state.status);
  // What the membership allows, whoever looks; the role decides whether it can be used.
  const cancelApplies = !member.account.isDemo && entitled && state.provider !== null;
  const extendApplies = state.status === "trialing" && state.trialEndsAt !== null;
  const giveApplies = entitled && state.provider !== null;
  const canCancel = billing && cancelApplies;
  const canExtend = billing && extendApplies;
  const canGive = billing && giveApplies;
  const anyApplies = cancelApplies || extendApplies || giveApplies;
  const items: { label: ReactNode; value: ReactNode }[] = [
    { label: "Status", value: <MembershipStatusLine member={member} /> },
    { label: "Plan", value: planName(state.planId) },
  ];
  if (state.trialEndsAt)
    items.push({ label: "Trial ends", value: <DateTime value={state.trialEndsAt} /> });
  if (state.currentPeriodEnd) {
    items.push({
      label: state.cancelAtPeriodEnd ? "Ends" : "Renews",
      value: <DateTime value={state.currentPeriodEnd} />,
    });
  }
  if (state.graceEndsAt)
    items.push({ label: "Grace ends", value: <DateTime value={state.graceEndsAt} /> });
  if (state.suspendedReason) {
    items.push({ label: "Suspended because", value: SUSPENDED_REASON[state.suspendedReason] });
  }
  items.push(
    { label: "Can watch", value: <WatchLine entitlement={entitlement} /> },
    {
      label: "Payment provider",
      value: state.provider ? (PROVIDERS[state.provider] ?? state.provider) : "—",
    },
  );
  const actions = !anyApplies ? null : billing ? (
    <>
      {canExtend ? (
        <Button size="sm" variant="outline" onClick={extend.show}>
          Extend trial
        </Button>
      ) : null}
      {canGive ? (
        <Button size="sm" variant="outline" onClick={free.show}>
          Give free time
        </Button>
      ) : null}
      {canCancel ? (
        <Button size="sm" variant="outline" onClick={cancel.show}>
          Cancel membership
        </Button>
      ) : null}
    </>
  ) : (
    <>
      {extendApplies ? <LockedAction label="Extend trial" describedBy={lockedNote} /> : null}
      {giveApplies ? <LockedAction label="Give free time" describedBy={lockedNote} /> : null}
      {cancelApplies ? <LockedAction label="Cancel membership" describedBy={lockedNote} /> : null}
    </>
  );
  return (
    <Section id="membership" title="Membership" actions={actions}>
      <KeyValueList items={items} />
      {!billing && anyApplies ? (
        <p id={lockedNote} className="mt-4 flex items-start gap-1.5 type-caption text-fg-subtle">
          <LockIcon size="xs" className="mt-0.5 shrink-0" />
          These need the Billing role. Ask a colleague who has it, or an admin.
        </p>
      ) : null}
      {billing && !entitled ? (
        <p className="mt-4 type-caption text-fg-subtle">
          Billing actions need a running membership (a trial, active or past due).
        </p>
      ) : null}
      {/* Kept mounted while open: a successful change can make the action unavailable. */}
      {canCancel || cancel.open ? (
        <CancelMembershipDialog
          member={member}
          open={cancel.open}
          onOpenChange={cancel.onOpenChange}
        />
      ) : null}
      {canExtend || extend.open ? (
        <ExtendTrialDialog member={member} open={extend.open} onOpenChange={extend.onOpenChange} />
      ) : null}
      {canGive || free.open ? (
        <ComplimentaryDialog member={member} open={free.open} onOpenChange={free.onOpenChange} />
      ) : null}
    </Section>
  );
}

/** "Yes · 2 screens at a time, up to 1080p · until Dec 30, 2026", or "No: membership ended". */
function WatchLine({ entitlement }: { entitlement: MemberDetail["entitlement"] }) {
  if (!entitlement.entitled) {
    return (
      <span>
        No<span className="text-fg-muted">: {ENTITLEMENT[entitlement.reason]}</span>
      </span>
    );
  }
  const quality = entitlement.maxVideoHeight ? `, up to ${entitlement.maxVideoHeight}p` : "";
  return (
    <span>
      Yes
      <span className="text-fg-subtle">
        {" "}
        · {plural(entitlement.maxStreams, "screen", "screens")} at a time{quality}
        {entitlement.until ? ` · until ${formatDate(entitlement.until)}` : ""}
      </span>
    </span>
  );
}

function MembershipStatusLine({ member }: { member: MemberDetail }) {
  const state = member.membership;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <StatusBadge tone={MEMBERSHIP[state.status].tone}>
        {MEMBERSHIP[state.status].label}
      </StatusBadge>
      {state.cancelAtPeriodEnd ? (
        <span className="text-fg-muted">Cancelled: ends at the period end</span>
      ) : null}
    </span>
  );
}

function InvoicesSection({ member, canRefund }: { member: MemberDetail; canRefund: boolean }) {
  const [refunding, setRefunding] = useState<Invoice | null>(null);
  const [open, setOpen] = useState(false);
  const lockedNote = useId();
  const columns: Column<Invoice>[] = [
    {
      id: "invoice",
      header: "Invoice",
      cell: (invoice) => (
        <span className="flex flex-col">
          <span className="text-fg">{invoice.number ?? "Not numbered"}</span>
          <span className="type-caption text-fg-subtle">
            {invoice.periodStart && invoice.periodEnd
              ? formatDateRange(invoice.periodStart, invoice.periodEnd)
              : (invoice.description ?? formatDate(invoice.createdAt))}
          </span>
        </span>
      ),
      sortValue: (invoice) => invoice.createdAt,
    },
    {
      id: "status",
      header: "Status",
      cell: (invoice) => (
        <StatusBadge tone={INVOICE[invoice.status].tone}>
          {INVOICE[invoice.status].label}
        </StatusBadge>
      ),
      hideBelow: "sm",
    },
    {
      id: "paid",
      header: "Paid",
      align: "end",
      cell: (invoice) => <Money amount={invoice.amountPaid} />,
      sortValue: (invoice) => invoice.amountPaid.amountMinor,
    },
    {
      id: "refunded",
      header: "Refunded",
      align: "end",
      hideBelow: "sm",
      cell: (invoice) =>
        invoice.amountRefunded.amountMinor > 0 ? (
          <Money amount={invoice.amountRefunded} />
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
  ];
  const refundable = (invoice: Invoice) =>
    invoice.amountPaid.amountMinor - invoice.amountRefunded.amountMinor > 0;
  const anyRefundable = member.recentInvoices.some(refundable);
  if (canRefund || anyRefundable) {
    columns.push({
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (invoice) =>
        !refundable(invoice) ? null : canRefund ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Refund invoice ${invoice.number ?? invoice.id}`}
            onClick={() => {
              setRefunding(invoice);
              setOpen(true);
            }}
          >
            Refund
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            icon={LockIcon}
            aria-disabled="true"
            aria-label={`Refund invoice ${invoice.number ?? invoice.id}`}
            aria-describedby={lockedNote}
            onClick={(event) => event.preventDefault()}
          >
            Refund
          </Button>
        ),
    });
  }
  return (
    <Section
      id="invoices"
      title="Invoices"
      description="The ten most recent. Invoice documents stay with the member."
    >
      <DataTable
        caption="Recent invoices"
        columns={columns}
        rows={member.recentInvoices}
        rowKey={(invoice) => invoice.id}
        initialSort={{ column: "invoice", direction: "desc" }}
        empty={<Empty title="No invoices" description="The member hasn't been billed yet." />}
      />
      {!canRefund && anyRefundable ? (
        <p id={lockedNote} className="mt-3 flex items-start gap-1.5 type-caption text-fg-subtle">
          <LockIcon size="xs" className="mt-0.5 shrink-0" />
          Refunds need the Billing role. Ask a colleague who has it, or an admin.
        </p>
      ) : null}
      {refunding ? (
        <RefundDialog
          key={refunding.id}
          member={member}
          invoice={refunding}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </Section>
  );
}

function AccountSection({ member }: { member: MemberDetail }) {
  const { account } = member;
  const signOut = useDialog();
  const reset = useDialog();
  const protectedAccount = account.isDemo;
  return (
    <Section
      id="account"
      title="Sign-in and devices"
      actions={
        protectedAccount ? null : (
          <>
            <Button size="sm" variant="outline" icon={KeyIcon} onClick={reset.show}>
              Send password reset
            </Button>
            <Button size="sm" variant="outline" icon={LogOutIcon} onClick={signOut.show}>
              Sign out everywhere
            </Button>
          </>
        )
      }
    >
      <KeyValueList
        items={[
          {
            label: "Email",
            value: (
              <span className="flex flex-wrap items-center gap-2">
                {account.email}
                <StatusBadge tone={account.emailVerified ? "positive" : "warning"}>
                  {account.emailVerified ? "Verified" : "Not verified"}
                </StatusBadge>
              </span>
            ),
          },
          {
            label: "Password",
            value: (
              <YesNo value={account.hasPassword} yes="Set" no="None (signs in with a provider)" />
            ),
          },
          {
            label: "Sign-in providers",
            value:
              member.identities.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {member.identities.map((identity) => (
                    <li key={identity.provider}>
                      {ISSUERS[identity.provider] ?? identity.provider}
                      <span className="text-fg-subtle">
                        {identity.emailAtLink ? ` · ${identity.emailAtLink}` : ""} · linked{" "}
                        {formatDate(identity.linkedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-fg-subtle">None linked</span>
              ),
          },
          {
            label: "Signed-in devices",
            value: `${member.activeDevices}`,
          },
          { label: "Member since", value: <DateTime value={account.createdAt} /> },
        ]}
      />
      {protectedAccount ? null : (
        <>
          <SignOutEverywhereDialog
            member={member}
            open={signOut.open}
            onOpenChange={signOut.onOpenChange}
          />
          <PasswordResetDialog
            member={member}
            open={reset.open}
            onOpenChange={reset.onOpenChange}
          />
        </>
      )}
    </Section>
  );
}

function ProfilesSection({ member }: { member: MemberDetail }) {
  const [target, setTarget] = useState<MemberDetail["profiles"][number] | null>(null);
  const [open, setOpen] = useState(false);
  const canRemovePin = !member.account.isDemo;
  return (
    <Section id="profiles" title="Profiles" description={`${member.profiles.length} of 5`}>
      {member.profiles.length === 0 ? (
        <Empty title="No profiles yet" description="The member hasn't created a profile." />
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle">
          {member.profiles.map((profile) => (
            <li
              key={profile.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2.5"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2 type-body-sm">
                <span className="font-semibold text-fg">{profile.name}</span>
                {profile.isKids ? (
                  <Badge tone="info" size="sm">
                    Kids
                  </Badge>
                ) : null}
                <span className="text-fg-subtle">
                  Up to {profile.maturityCeiling === "ALL" ? "all ages" : profile.maturityCeiling}
                </span>
                {profile.locked ? (
                  <span className="inline-flex items-center gap-1 text-fg-muted">
                    <LockIcon size="xs" /> PIN
                  </span>
                ) : null}
              </span>
              {profile.locked && canRemovePin ? (
                <Button
                  size="sm"
                  variant="outline"
                  icon={UnlockIcon}
                  aria-label={`Remove PIN from ${profile.name}`}
                  onClick={() => {
                    setTarget(profile);
                    setOpen(true);
                  }}
                >
                  Remove PIN
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {target ? (
        <RemovePinDialog
          key={target.id}
          member={member}
          profile={target}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </Section>
  );
}

function PrivacySection({ accountId }: { accountId: string }) {
  const [shown, setShown] = useState(false);
  const queryClient = useQueryClient();
  const privacy = useQuery({ ...queries.memberPrivacy(accountId), enabled: shown });
  const consent = useDialog();
  // Each opening starts from the consent as it stands then (a fresh form).
  const [consentForm, setConsentForm] = useState(0);
  const cancel = useDialog();
  const scheduled = privacy.data?.requests.find(
    (request) => request.kind === "deletion" && request.status === "scheduled",
  );
  const erasing = privacy.data?.requests.find(
    (request) => request.kind === "deletion" && request.status === "processing",
  );
  const withdrawable = privacy.data ? withdrawablePurposes(privacy.data.consent) : [];
  // The dialogs outlive what they act on, to show their outcome.
  const lastScheduled = useRef(scheduled);
  if (scheduled) lastScheduled.current = scheduled;
  const lastConsent = useRef(privacy.data?.consent);
  if (privacy.data) lastConsent.current = privacy.data.consent;
  return (
    <Section
      id="privacy"
      title="Privacy"
      description="Consent and data requests. Opening this is recorded in the audit log."
      actions={
        shown && privacy.data ? (
          <>
            {withdrawable.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setConsentForm((count) => count + 1);
                  consent.show();
                }}
              >
                Record a withdrawal
              </Button>
            ) : null}
            {scheduled ? (
              <Button size="sm" variant="outline" onClick={cancel.show}>
                Cancel deletion
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {!shown ? (
        <Button size="sm" variant="outline" icon={EyeIcon} onClick={() => setShown(true)}>
          Show privacy details
        </Button>
      ) : privacy.isPending ? (
        <LoadingRows rows={3} label="Loading privacy details" />
      ) : privacy.isError ? (
        <ErrorPanel
          error={privacy.error}
          onRetry={() =>
            void queryClient.invalidateQueries({ queryKey: qk.memberPrivacy(accountId) })
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {erasing ? (
            <div className="flex gap-2 rounded-md border border-info/40 p-3">
              <InfoIcon size="sm" className="mt-0.5 shrink-0 text-info" />
              <div className="flex flex-col gap-0.5 type-body-sm">
                <p className="type-label text-fg">This account is being deleted</p>
                <p className="text-fg-muted">
                  Erasure started
                  {erasing.scheduledFor ? (
                    <>
                      {" "}
                      <DateTime value={erasing.scheduledFor} />
                    </>
                  ) : null}
                  . The account is locked (signed out everywhere, no sign-in) and can no longer be
                  kept; Webflix retries until the erasure finishes. If it stays like this for long,
                  System health shows it as overdue.
                </p>
              </div>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <KeyValueList
              items={[
                {
                  label: "Consent mode",
                  value: (
                    <span>
                      {privacy.data.consent.mode === "opt-in"
                        ? "Ask first (opt-in)"
                        : privacy.data.consent.mode === "opt-out"
                          ? "Until withdrawn (opt-out)"
                          : "Nothing collected (off)"}
                      {privacy.data.consent.gpc ? (
                        <span className="text-fg-subtle"> · Global Privacy Control seen</span>
                      ) : null}
                    </span>
                  ),
                },
                ...(["analytics", "personalisation"] as const).map((purpose) => {
                  const state = privacy.data.consent.purposes[purpose];
                  return {
                    label: CONSENT_PURPOSES_LABEL[purpose],
                    value: (
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <StatusBadge tone={state.granted ? "positive" : "outline"}>
                          {state.granted ? "On" : "Off"}
                        </StatusBadge>
                        <span className="text-fg-subtle">
                          {state.source
                            ? `by ${CONSENT_SOURCES[state.source] ?? state.source}`
                            : "the default"}
                          {state.updatedAt ? `, ${formatDate(state.updatedAt)}` : ""}
                        </span>
                      </span>
                    ),
                  };
                }),
              ]}
            />
            <p className="flex items-start gap-1.5 type-caption text-fg-subtle">
              <InfoIcon size="xs" className="mt-0.5 shrink-0" />
              {withdrawable.length === 0
                ? "Both purposes are off, so there is nothing to withdraw. Only the member can turn one on, in Account › Privacy."
                : "Staff can record a withdrawal when the member asks. Only the member can turn a purpose on, in Account › Privacy."}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="type-caption text-fg-muted">Data requests</h3>
            {privacy.data.requests.length === 0 ? (
              <p className="type-body-sm text-fg-subtle">No export or deletion requests.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line-subtle">
                {privacy.data.requests.map((request) => (
                  <li
                    key={request.id}
                    className="flex flex-wrap items-center gap-2 py-2 type-body-sm"
                  >
                    <span className="font-semibold text-fg">
                      {request.kind === "export" ? "Data export" : "Account deletion"}
                    </span>
                    <StatusBadge tone={PRIVACY_REQUEST[request.status].tone}>
                      {request.kind === "deletion" && request.status === "processing"
                        ? "Being erased"
                        : PRIVACY_REQUEST[request.status].label}
                    </StatusBadge>
                    <span className="text-fg-subtle">
                      asked <DateTime value={request.requestedAt} />
                      {request.kind === "deletion" &&
                      request.scheduledFor &&
                      request.status === "scheduled" ? (
                        <>
                          {" "}
                          · erased on <DateTime value={request.scheduledFor} />
                        </>
                      ) : null}
                      {request.completedAt ? (
                        <>
                          {" "}
                          · done <DateTime value={request.completedAt} />
                        </>
                      ) : null}
                      {request.email === "suppressed" ? " · no email (address bounced before)" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="flex items-start gap-1.5 type-caption text-fg-subtle">
              <ShieldIcon size="xs" className="mt-0.5 shrink-0" />
              Export downloads and the member's activity are never shown to staff.
            </p>
          </div>
          {lastConsent.current && (withdrawable.length > 0 || consent.open) ? (
            <ConsentDialog
              key={consentForm}
              accountId={accountId}
              consent={lastConsent.current}
              open={consent.open}
              onOpenChange={consent.onOpenChange}
            />
          ) : null}
          {lastScheduled.current && (scheduled || cancel.open) ? (
            <CancelDeletionDialog
              accountId={accountId}
              request={lastScheduled.current}
              open={cancel.open}
              onOpenChange={cancel.onOpenChange}
            />
          ) : null}
        </div>
      )}
    </Section>
  );
}
