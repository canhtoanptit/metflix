/**
 * Plans and their prices per currency, and the catalogue at the payment provider. A changed
 * price reaches new subscriptions only once synchronised (a new provider price takes over the
 * lookup key); existing members keep theirs.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminPlan, PlanSyncResult } from "@webflix/contracts";
import { Button, EditIcon, Field, Input, PlusIcon, RefreshIcon } from "@webflix/ui";
import { useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog, SHOWN_IN_FIELD } from "../../components/ActionDialog.tsx";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import { DateTime, Money, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { ErrorPanel, LoadingRows } from "../../components/states.tsx";
import {
  formatMoney,
  fractionDigits,
  minorToMajorText,
  parseMajorAmount,
} from "../../lib/format.ts";
import { useDocumentTitle } from "../../lib/hooks.ts";

type Price = AdminPlan["prices"][number];

export function PlansPage() {
  useDocumentTitle("Plans & prices");
  const plans = useQuery(queries.plans());
  const [syncOpen, setSyncOpen] = useState(false);
  const [editing, setEditing] = useState<{ plan: AdminPlan; price: Price | null } | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const neverSynced =
    plans.data?.items.flatMap((plan) => plan.prices).filter((price) => price.syncedAt === null)
      .length ?? 0;

  return (
    <>
      <PageHeader
        title="Plans & prices"
        description="Prices per currency. A new price reaches new subscriptions once it is synchronised with the payment provider; current members keep the price they have."
        actions={
          <Button variant="accent" size="sm" icon={RefreshIcon} onClick={() => setSyncOpen(true)}>
            Sync with the provider
          </Button>
        }
      />
      {plans.isPending ? (
        <LoadingRows rows={6} label="Loading plans" />
      ) : plans.isError ? (
        <ErrorPanel error={plans.error} onRetry={() => void plans.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {neverSynced > 0 ? (
            <p
              role="status"
              className="rounded-md border border-warning/40 p-3 type-body-sm text-fg-muted"
            >
              {neverSynced === 1 ? "One price has" : `${neverSynced} prices have`} never been
              synchronised: new members can't be charged {neverSynced === 1 ? "it" : "them"} until
              you sync.
            </p>
          ) : null}
          {plans.data.items.map((plan) => (
            <PlanSection
              key={plan.id}
              plan={plan}
              onEdit={(price) => {
                setEditing({ plan, price });
                setEditOpen(true);
              }}
            />
          ))}
        </div>
      )}
      <SyncDialog open={syncOpen} onOpenChange={setSyncOpen} />
      {editing ? (
        <PriceDialog
          key={`${editing.plan.id}:${editing.price?.currency ?? "new"}`}
          plan={editing.plan}
          price={editing.price}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      ) : null}
    </>
  );
}

function PlanSection({ plan, onEdit }: { plan: AdminPlan; onEdit: (price: Price | null) => void }) {
  const columns: Column<Price>[] = [
    {
      id: "currency",
      header: "Currency",
      cell: (price) => price.currency,
      sortValue: (price) => price.currency,
    },
    {
      id: "amount",
      header: "Monthly price",
      align: "end",
      cell: (price) => (
        <Money amount={{ amountMinor: price.amountMinor, currency: price.currency }} />
      ),
      sortValue: (price) => price.amountMinor,
    },
    {
      id: "lookup",
      header: "Provider lookup key",
      hideBelow: "md",
      cell: (price) => <code className="font-mono text-xs text-fg-muted">{price.lookupKey}</code>,
    },
    {
      id: "state",
      header: "State",
      cell: (price) => (
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={price.active ? "positive" : "outline"}>
            {price.active ? "Active" : "Inactive"}
          </StatusBadge>
          {price.syncedAt === null ? <StatusBadge tone="warning">Not synced</StatusBadge> : null}
        </span>
      ),
    },
    {
      id: "synced",
      header: "Last synced",
      hideBelow: "lg",
      cell: (price) => <DateTime value={price.syncedAt} fallback="Never" />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (price) => (
        <Button
          size="sm"
          variant="ghost"
          icon={EditIcon}
          aria-label={`Change the ${plan.name} price in ${price.currency}`}
          onClick={() => onEdit(price)}
        >
          Change
        </Button>
      ),
    },
  ];
  return (
    <Section
      id={`plan-${plan.id}`}
      title={plan.name}
      description={`${plan.maxStreams} ${plan.maxStreams === 1 ? "screen" : "screens"} · up to ${plan.maxQuality} · ${plan.trialDays}-day trial`}
      actions={
        <Button size="sm" variant="outline" icon={PlusIcon} onClick={() => onEdit(null)}>
          Add a currency
        </Button>
      }
    >
      <DataTable
        caption={`${plan.name} prices`}
        columns={columns}
        rows={plan.prices}
        rowKey={(price) => price.currency}
        initialSort={{ column: "currency", direction: "asc" }}
      />
    </Section>
  );
}

function PriceDialog({
  plan,
  price,
  open,
  onOpenChange,
}: {
  plan: AdminPlan;
  price: Price | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [currency, setCurrency] = useState(price?.currency ?? "");
  const [amount, setAmount] = useState(
    price ? minorToMajorText(price.amountMinor, price.currency) : "",
  );
  const [errors, setErrors] = useState<{ currency?: string; amount?: string }>({});
  const code = currency.trim().toUpperCase();
  const validCurrency = /^[A-Z]{3}$/.test(code);
  const minor = validCurrency ? parseMajorAmount(amount, code) : null;
  const existing = plan.prices.find((candidate) => candidate.currency === code);

  function validate(): string | null {
    const next: typeof errors = {};
    if (!validCurrency) next.currency = "Use the three-letter ISO code, like USD or EUR.";
    else if (!price && existing)
      next.currency = `${plan.name} already has a ${code} price: change it instead.`;
    if (validCurrency && (minor === null || minor <= 0)) {
      next.amount = `Enter a price above zero${fractionDigits(code) > 0 ? ", like 15.99" : " in whole units"}.`;
    } else if (price && minor === price.amountMinor) {
      next.amount = "That's the current price.";
    }
    setErrors(next);
    return next.currency || next.amount ? SHOWN_IN_FIELD : null;
  }

  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      scope={`price:${plan.id}:${price?.currency ?? "new"}`}
      title={
        price ? `Change the ${plan.name} price in ${price.currency}` : `Add a ${plan.name} price`
      }
      description="New members pay it once you sync with the provider. Current members keep their price."
      confirmLabel={
        minor && validCurrency
          ? `Set ${formatMoney({ amountMinor: minor, currency: code })} a month`
          : "Set price"
      }
      audit={{ targetType: "plan_price", targetId: `${plan.id}.${code || "?"}` }}
      validate={validate}
      run={({ reason, signal, headers }) =>
        staffApi().setPlanPrice(
          {
            params: { planId: plan.id, currency: code },
            body: { amountMinor: minor ?? 0, reason },
          },
          { signal, headers },
        )
      }
      onSuccess={() => void queryClient.invalidateQueries({ queryKey: qk.plans() })}
      success={() =>
        `${plan.name} now costs ${formatMoney({ amountMinor: minor ?? 0, currency: code })} a month in ${code}. Sync with the provider so new members pay it.`
      }
    >
      {price ? null : (
        <Field label="Currency" error={errors.currency} hint="Three-letter ISO code.">
          <Input
            size="sm"
            value={currency}
            maxLength={3}
            autoComplete="off"
            className="max-w-24 uppercase"
            onChange={(event) => {
              setCurrency(event.target.value);
              setErrors((current) => ({ ...current, currency: undefined }));
            }}
          />
        </Field>
      )}
      <Field
        label={`Monthly price${validCurrency ? ` (${code})` : ""}`}
        error={errors.amount}
        hint={
          price
            ? `Now ${formatMoney({ amountMinor: price.amountMinor, currency: price.currency })}.`
            : undefined
        }
      >
        <Input
          size="sm"
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          className="max-w-40"
          onChange={(event) => {
            setAmount(event.target.value);
            setErrors((current) => ({ ...current, amount: undefined }));
          }}
        />
      </Field>
    </ActionDialog>
  );
}

function SyncDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog<PlanSyncResult>
      open={open}
      onOpenChange={onOpenChange}
      scope="plans-sync"
      title="Sync with the payment provider"
      description="Creates or updates the provider's prices to match these, by lookup key, and archives prices no longer used. Running it again changes nothing."
      confirmLabel="Sync now"
      slowNotice="Waiting for the payment provider. This can take a while for many prices: keep this open."
      audit={{ targetType: "plan_catalogue", targetId: "all" }}
      run={({ reason, signal, headers }) =>
        staffApi().syncPlans({ body: { reason } }, { signal, headers })
      }
      onSuccess={() => void queryClient.invalidateQueries({ queryKey: qk.plans() })}
      success={(result) => (
        <div className="flex flex-col gap-2">
          <p>
            Synced with {result.provider === "fake" ? "the test provider" : result.provider} at{" "}
            <DateTime value={result.syncedAt} seconds />.
          </p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ["Created", result.created],
                ["Updated", result.updated],
                ["Archived", result.archived],
                ["Unchanged", result.unchanged],
              ] as const
            ).map(([label, count]) => (
              <li key={label} className="rounded-md bg-surface-3 p-2">
                <span className="block type-caption text-fg-subtle">{label}</span>
                <span className="type-title tabular-nums">{count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    />
  );
}
