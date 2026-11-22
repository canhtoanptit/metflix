/**
 * Your actions: the signed-in staff member's own audit entries (`GET /audit/mine`, any role),
 * newest first, so anyone can follow an action whose outcome was unclear to its entry. What was
 * asked and what changed stay with the audit log (admin role); here an entry shows what, on
 * what, why, how it ended, and the error code when it failed.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  AUDIT_OUTCOMES,
  type AuditLogEntry,
  type AuditOutcome,
  type OwnAuditQuery,
} from "@webflix/contracts";
import { Button, Field, FilterIcon, Input, Select, SelectItem } from "@webflix/ui";
import { useEffect, useState } from "react";
import { useStaff } from "../../access/staff.tsx";
import { queries } from "../../api/queries.ts";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import {
  DateTime,
  Identifier,
  PageHeader,
  Section,
  StatusBadge,
} from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { AUDIT_OUTCOME } from "../../lib/status.ts";

const route = getRouteApi("/activity");
const ANY = "any";
const PAGE_SIZE = 50;

export function MyActionsPage() {
  useDocumentTitle("Your actions");
  const staff = useStaff();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/activity" });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const filterKey = `${search.outcome ?? ""}|${search.requestId ?? ""}`;
  useEffect(() => setCursors([null]), [filterKey]);
  const cursor = cursors.at(-1) ?? null;
  const query: OwnAuditQuery = {
    limit: PAGE_SIZE,
    ...(search.outcome ? { outcome: search.outcome } : {}),
    ...(search.requestId ? { requestId: search.requestId } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const page = useQuery({ ...queries.ownAudit(query), placeholderData: keepPreviousData });

  const columns: Column<AuditLogEntry>[] = [
    {
      id: "when",
      header: "When",
      cell: (entry) => (
        <span className="whitespace-nowrap">
          <DateTime value={entry.createdAt} seconds />
        </span>
      ),
    },
    {
      id: "action",
      header: "Action",
      cell: (entry) => (
        <span className="flex flex-col gap-0.5">
          <code className="font-mono text-xs text-fg">{entry.action}</code>
          <span className="type-caption text-fg-subtle">
            {entry.target.type === "member" && staff.has("support") ? (
              <Link
                to="/members/$accountId"
                params={{ accountId: entry.target.id }}
                className="focus-ring rounded-xs underline-offset-4 hover:text-fg hover:underline"
              >
                Member {entry.target.id.slice(0, 13)}…
              </Link>
            ) : entry.target.type === "member_search" ? (
              "Member search"
            ) : (
              `${entry.target.type} ${entry.target.id}`
            )}
          </span>
          {/* The request id is what an unclear change is followed by; reads carry no reason. */}
          {entry.requestId && entry.reason !== null ? (
            <span className="type-caption text-fg-subtle">
              Request <Identifier value={entry.requestId} label="request ID" truncate />
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "reason",
      header: "Why",
      hideBelow: "md",
      className: "max-w-80",
      cell: (entry) =>
        entry.reason ? (
          <span className="line-clamp-2 break-words text-fg-muted">{entry.reason}</span>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: "outcome",
      header: "Outcome",
      cell: (entry) => {
        const error =
          entry.after && typeof entry.after === "object" && !Array.isArray(entry.after)
            ? (entry.after as { error?: unknown }).error
            : undefined;
        return (
          <span className="flex flex-col items-start gap-1">
            <StatusBadge tone={AUDIT_OUTCOME[entry.outcome].tone}>
              {AUDIT_OUTCOME[entry.outcome].label}
            </StatusBadge>
            {typeof error === "string" ? (
              <code className="font-mono text-xs text-fg-subtle">{error}</code>
            ) : null}
          </span>
        );
      },
    },
  ];

  const unknownHere = page.data?.items.some((entry) => entry.outcome === "unknown") ?? false;
  return (
    <>
      <PageHeader
        title="Your actions"
        description="Everything you did in the console, newest first. Unknown means it ended without saying whether it happened: check the member (or whatever it acted on) before doing it again."
      />
      <OwnFilters
        key={filterKey}
        initial={search}
        onApply={(next) => void navigate({ search: next })}
      />
      <Section title="Entries" className="mt-4">
        {search.requestId && page.data && page.data.items.length === 0 ? (
          <p role="status" className="mb-3 type-body-sm text-fg-muted">
            No entry for request <code className="font-mono text-xs">{search.requestId}</code>.
            Member, billing and system actions are written before they run, so one of those never
            started; an editorial or experiment change is written when it ends, so look again in a
            moment.
          </p>
        ) : null}
        {unknownHere ? (
          <p className="mb-3 type-body-sm text-fg-muted">
            {staff.has("admin")
              ? "The audit log shows what each unknown action asked for and what it left."
              : "What an unknown action asked for and left is in the audit log, which needs the Admin role: give an admin the request ID."}
          </p>
        ) : null}
        {page.isPending ? (
          <LoadingRows rows={6} label="Loading your actions" />
        ) : page.isError ? (
          <ErrorPanel error={page.error} onRetry={() => void page.refetch()} />
        ) : (
          <DataTable
            caption="Your actions, newest first"
            columns={columns}
            rows={page.data.items}
            rowKey={(entry) => entry.id}
            highlight={(entry) => Boolean(search.requestId) && entry.requestId === search.requestId}
            empty={<Empty title="Nothing here" description="No action of yours matches." />}
            pager={
              cursors.length > 1 || page.data.nextCursor
                ? {
                    label: `Page ${cursors.length}`,
                    hasPrevious: cursors.length > 1,
                    hasNext: page.data.nextCursor !== null,
                    loading: page.isFetching,
                    onPrevious: () => setCursors((current) => current.slice(0, -1)),
                    onNext: () => {
                      const next = page.data.nextCursor;
                      if (next) setCursors((current) => [...current, next]);
                    },
                  }
                : undefined
            }
          />
        )}
      </Section>
    </>
  );
}

function OwnFilters({
  initial,
  onApply,
}: {
  initial: { outcome?: AuditOutcome; requestId?: string };
  onApply: (next: { outcome?: AuditOutcome; requestId?: string }) => void;
}) {
  const [outcome, setOutcome] = useState<string>(initial.outcome ?? ANY);
  const [requestId, setRequestId] = useState(initial.requestId ?? "");
  return (
    <form
      aria-label="Filter your actions"
      className="grid gap-3 rounded-lg border border-line-subtle bg-surface-1 p-4 sm:grid-cols-[1fr_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          ...(outcome !== ANY ? { outcome: outcome as AuditOutcome } : {}),
          ...(/^[A-Za-z0-9._-]{1,64}$/.test(requestId.trim())
            ? { requestId: requestId.trim() }
            : {}),
        });
      }}
    >
      <Field label="Outcome">
        <Select variant="compact" value={outcome} onValueChange={setOutcome}>
          <SelectItem value={ANY}>Any outcome</SelectItem>
          {AUDIT_OUTCOMES.map((value) => (
            <SelectItem key={value} value={value}>
              {AUDIT_OUTCOME[value].label}
            </SelectItem>
          ))}
        </Select>
      </Field>
      <Field label="Request ID">
        <Input
          size="sm"
          value={requestId}
          autoComplete="off"
          spellCheck={false}
          placeholder="From an action"
          onChange={(event) => setRequestId(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Button type="submit" size="sm" variant="accent" icon={FilterIcon} className="h-9">
          Apply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9"
          onClick={() => {
            setOutcome(ANY);
            setRequestId("");
            onApply({});
          }}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}
