/**
 * Your actions: the signed-in staff member's own audit entries (`GET /audit/mine`, any role),
 * newest first, in words, so anyone can follow an action to its entry (from its dialog, by
 * request ID). What was asked and what changed stay with the audit log (admin role): here an
 * entry shows what, on whom or what (a member's address only for roles that may see members),
 * why, how it ended, and the error when it failed. Views of member data are left out unless
 * asked for.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  AUDIT_OUTCOMES,
  type AuditLogEntry,
  type AuditOutcome,
  type OwnAuditQuery,
} from "@webflix/contracts";
import { Button, Field, FilterIcon, Input, RefreshIcon, Select, SelectItem } from "@webflix/ui";
import { useEffect, useState } from "react";
import { useStaff } from "../../access/staff.tsx";
import { queries } from "../../api/queries.ts";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import {
  Identifier,
  PageHeader,
  Section,
  Stamp,
  StatusBadge,
} from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { AUDIT_OUTCOME } from "../../lib/status.ts";
import { EntryError, EntryWhat } from "./AuditEntryParts.tsx";
import { AUDIT_SHOW, type AuditShow, auditKind, auditShow } from "./audit-filter.ts";

const SHOW_LABELS: Record<AuditShow, string> = {
  actions: "Actions",
  all: "Actions and views",
  views: "Views only",
};

const route = getRouteApi("/activity");
const ANY = "any";
const PAGE_SIZE = 50;

export function MyActionsPage() {
  useDocumentTitle("Your actions");
  const staff = useStaff();
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/activity" });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const show = auditShow(search);
  const kind = auditKind(show);
  const filterKey = `${search.outcome ?? ""}|${search.requestId ?? ""}|${show}`;
  useEffect(() => setCursors([null]), [filterKey]);
  const cursor = cursors.at(-1) ?? null;
  const query: OwnAuditQuery = {
    limit: PAGE_SIZE,
    ...(search.outcome ? { outcome: search.outcome } : {}),
    ...(search.requestId ? { requestId: search.requestId } : {}),
    ...(kind ? { kind } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const page = useQuery({ ...queries.ownAudit(query), placeholderData: keepPreviousData });

  const columns: Column<AuditLogEntry>[] = [
    {
      id: "when",
      header: "When",
      cell: (entry) => <Stamp value={entry.createdAt} />,
    },
    {
      id: "what",
      header: "What",
      cell: (entry) => (
        <span className="flex flex-col gap-1">
          <EntryWhat entry={entry} linkMembers={staff.has("support")} />
          {/* The request id is what an unclear change is followed by; views carry none worth it. */}
          {entry.requestId && entry.kind === "action" ? (
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
      cell: (entry) => (
        <span className="flex flex-col items-start gap-1">
          <StatusBadge tone={AUDIT_OUTCOME[entry.outcome].tone}>
            {AUDIT_OUTCOME[entry.outcome].label}
          </StatusBadge>
          <EntryError entry={entry} />
        </span>
      ),
    },
  ];

  const unknownHere = page.data?.items.some((entry) => entry.outcome === "unknown") ?? false;
  return (
    <>
      <PageHeader
        title="Your actions"
        description="What you did in the console, newest first. Your views of member data are recorded too, and listed when you ask for them. Unknown means an action ended without saying whether it happened: check the member (or whatever it acted on) before doing it again."
      />
      <OwnFilters
        key={filterKey}
        initial={search}
        onApply={(next) => void navigate({ search: next })}
      />
      <Section
        title="Entries"
        className="mt-4"
        actions={
          <Button
            variant="outline"
            size="sm"
            icon={RefreshIcon}
            loading={page.isFetching}
            onClick={() => void page.refetch()}
          >
            Refresh
          </Button>
        }
      >
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
            empty={
              <Empty
                title="Nothing here"
                description={
                  show === "actions"
                    ? "No action of yours matches. Your views of member data are left out: show them to look there too."
                    : "Nothing of yours matches."
                }
              />
            }
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

interface OwnFilterValues {
  outcome?: AuditOutcome;
  requestId?: string;
  show?: AuditShow;
}

function OwnFilters({
  initial,
  onApply,
}: {
  initial: OwnFilterValues;
  onApply: (next: OwnFilterValues) => void;
}) {
  const [outcome, setOutcome] = useState<string>(initial.outcome ?? ANY);
  const [requestId, setRequestId] = useState(initial.requestId ?? "");
  const [show, setShow] = useState<AuditShow>(auditShow(initial));
  return (
    <form
      aria-label="Filter your actions"
      className="grid gap-3 rounded-lg border border-line-subtle bg-surface-1 p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        const request = /^[A-Za-z0-9._-]{1,64}$/.test(requestId.trim()) ? requestId.trim() : null;
        onApply({
          ...(outcome !== ANY ? { outcome: outcome as AuditOutcome } : {}),
          ...(request ? { requestId: request } : {}),
          ...(show !== auditShow(request ? { requestId: request } : {}) ? { show } : {}),
        });
      }}
    >
      <Field label="Show">
        <Select
          variant="compact"
          value={show}
          onValueChange={(value) => setShow(value as AuditShow)}
        >
          {AUDIT_SHOW.map((value) => (
            <SelectItem key={value} value={value}>
              {SHOW_LABELS[value]}
            </SelectItem>
          ))}
        </Select>
      </Field>
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
            setShow("actions");
            onApply({});
          }}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}
