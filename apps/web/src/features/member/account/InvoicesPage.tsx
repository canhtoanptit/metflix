import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Invoice } from "@webflix/contracts";
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  ErrorState,
  ExternalLinkIcon,
  HistoryIcon,
  Skeleton,
} from "@webflix/ui";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { formatSignedMoney } from "../billing/copy.ts";
import { describeReduction } from "../billing/outcome.ts";
import { formatDateRange, formatMoney, formatShortDate } from "../shared/format.ts";
import { AccountHeading } from "./AccountLayout.tsx";

/** Billing history: every invoice and receipt, newest first, as the provider issued them. */
export function AccountInvoicesPage() {
  return (
    <>
      <AccountHeading
        title="Billing history"
        description="Every payment, credit and refund on your membership, newest first."
      />
      <InvoiceList />
      <div>
        <Button variant="outline" size="lg" asChild>
          <Link to="/account/membership">Back to membership</Link>
        </Button>
      </div>
    </>
  );
}

/** Invoices, paged (`limit` shows only the first few, for the membership page). */
export function InvoiceList({ limit }: { limit?: number }) {
  const invoices = useInfiniteQuery(queries.invoices());
  if (invoices.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-16 w-full" radius="card" />
        <Skeleton className="h-16 w-full" radius="card" />
      </div>
    );
  }
  if (invoices.isError) {
    return (
      <ErrorState
        layout="inline"
        title="We couldn't load your billing history"
        description={describeError(invoices.error).description}
        action={
          <Button variant="accent" onClick={() => void invoices.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const all = invoices.data.pages.flatMap((page) => page.items);
  const shown = limit === undefined ? all : all.slice(0, limit);
  if (shown.length === 0) {
    return (
      <EmptyState
        icon={HistoryIcon}
        headingLevel={3}
        title="No payments yet"
        description="Invoices and receipts appear here once your membership is billed."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-surface-1">
        {shown.map((invoice) => (
          <InvoiceRow key={invoice.id} invoice={invoice} />
        ))}
      </ul>
      {limit === undefined && invoices.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            loading={invoices.isFetchingNextPage}
            onClick={() => void invoices.fetchNextPage()}
          >
            Show older invoices
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * What kind of entry it is, in the member's terms (UX review 2.3, 3.9): a payment, a credit to
 * the account (a downgrade's unused time: nothing was paid), or a free trial's $0 invoice.
 */
function kindOf(invoice: Invoice): "payment" | "credit" | "trial" {
  if (invoice.total.amountMinor < 0) return "credit";
  const nothingTakenOff =
    !(invoice.creditApplied?.amountMinor ?? 0) && !(invoice.discount?.amountMinor ?? 0);
  return invoice.total.amountMinor === 0 &&
    invoice.amountPaid.amountMinor === 0 &&
    invoice.status === "paid" &&
    nothingTakenOff
    ? "trial"
    : "payment";
}

function statusOf(invoice: Invoice): { label: string; tone: BadgeTone } | null {
  const kind = kindOf(invoice);
  if (kind === "trial") return null;
  if (kind === "credit") return { label: "Credit", tone: "positive" };
  if (invoice.amountRefunded.amountMinor > 0) {
    return invoice.amountRefunded.amountMinor >= invoice.amountPaid.amountMinor
      ? { label: "Refunded", tone: "outline" }
      : { label: "Partly refunded", tone: "outline" };
  }
  switch (invoice.status) {
    case "paid":
      return { label: "Paid", tone: "positive" };
    case "open":
      return { label: "Due", tone: "danger" };
    case "uncollectible":
      return { label: "Unpaid", tone: "danger" };
    case "void":
      return { label: "Void", tone: "outline" };
    case "draft":
      return { label: "Upcoming", tone: "neutral" };
  }
}

function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const status = statusOf(invoice);
  const kind = kindOf(invoice);
  const date = invoice.paidAt ?? invoice.createdAt;
  // Why a payment is below its price: "$7.99 less your $4.98 credit".
  const reduction =
    kind === "payment" ? describeReduction(invoice.creditApplied, invoice.discount) : null;
  const before = reduction
    ? formatMoney({
        amountMinor:
          invoice.total.amountMinor +
          (invoice.creditApplied?.amountMinor ?? 0) +
          (invoice.discount?.amountMinor ?? 0),
        currency: invoice.total.currency,
      })
    : null;
  const period =
    invoice.periodStart && invoice.periodEnd && invoice.periodStart !== invoice.periodEnd
      ? formatDateRange(invoice.periodStart, invoice.periodEnd)
      : null;
  const link = invoice.hostedUrl ?? invoice.pdfUrl;
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3.5 sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <p className="type-label text-fg">
          {kind === "trial" ? "Free trial" : (invoice.description ?? "Webflix membership")}
        </p>
        <span className="shrink-0 type-label text-fg tabular-nums">
          {kind === "credit"
            ? `${formatMoney({ amountMinor: -invoice.total.amountMinor, currency: invoice.total.currency })} credit`
            : formatSignedMoney(invoice.total)}
        </span>
      </div>
      {reduction && before ? (
        <p className="type-body-sm text-fg-muted">
          {before} less {reduction}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 type-body-sm text-fg-muted">
        {status ? (
          <Badge tone={status.tone} size="sm">
            {status.label}
          </Badge>
        ) : null}
        <span>
          {kind === "trial"
            ? "Started "
            : kind === "credit"
              ? "Credited "
              : invoice.status === "paid"
                ? "Paid "
                : "Issued "}
          {formatShortDate(date)}
        </span>
        {period ? <span>For {period}</span> : null}
        {invoice.number ? (
          <span className="whitespace-nowrap text-fg-subtle">No. {invoice.number}</span>
        ) : null}
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex items-center gap-1 rounded-xs text-fg-muted underline underline-offset-2 hover:text-fg"
          >
            Receipt
            <ExternalLinkIcon size="xs" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
      {invoice.status === "open" && invoice.amountDue.amountMinor > 0 ? (
        <p className="type-body-sm text-danger">{formatMoney(invoice.amountDue)} still due</p>
      ) : null}
      {invoice.amountRefunded.amountMinor > 0 ? (
        <p className="type-body-sm text-fg-muted">{formatMoney(invoice.amountRefunded)} refunded</p>
      ) : null}
    </li>
  );
}
