/**
 * The audit log: what staff did, to whom, how much, why and how it ended, newest first, in
 * words ("Refunded $4.00", "Member · jane@example.test"). Changes are listed by default; the
 * records of staff viewing member data are left out unless asked for (`show`). Filters live in
 * the URL (identifiers only), so an action can link straight to its entry (`?requestId=`: the
 * `X-Request-Id` the console sent it with, opened and highlighted). Each entry opens to show its
 * action code, what was asked and what changed.
 *
 * Reading the log is itself audited (`audit.read`), so it never refetches on its own (focus,
 * reconnect): each look is one entry.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  AUDIT_OUTCOMES,
  type AuditLogEntry,
  type AuditOutcome,
  type AuditQuery,
} from "@webflix/contracts";
import {
  Button,
  ChevronDownIcon,
  ChevronRightIcon,
  Field,
  FilterIcon,
  Input,
  RefreshIcon,
  Select,
  SelectItem,
} from "@webflix/ui";
import { useEffect, useState } from "react";
import { useStaff } from "../../access/staff.tsx";
import { queries } from "../../api/queries.ts";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import {
  DateTime,
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
import { auditHeadline, auditTarget, TARGET_TYPES } from "./audit-words.ts";

const SHOW_LABELS: Record<AuditShow, string> = {
  actions: "Actions",
  all: "Actions and views",
  views: "Views only",
};

const auditRoute = getRouteApi("/operations/audit");
const PAGE_SIZE = 50;
const ANY = "any";

export function AuditPage() {
  useDocumentTitle("Audit log");
  const staff = useStaff();
  const search = auditRoute.useSearch();
  const navigate = useNavigate({ from: "/operations/audit" });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const show = auditShow(search);
  const kind = auditKind(show);
  const filterKey = JSON.stringify([
    search.targetType,
    search.targetId,
    search.actorId,
    search.outcome,
    search.requestId,
    show,
  ]);
  // A new filter starts from the first page.
  useEffect(() => setCursors([null]), [filterKey]);
  const cursor = cursors.at(-1) ?? null;
  const query: AuditQuery = {
    limit: PAGE_SIZE,
    ...(search.targetType ? { targetType: search.targetType } : {}),
    ...(search.targetId ? { targetId: search.targetId } : {}),
    ...(search.actorId ? { actorId: search.actorId } : {}),
    ...(search.outcome ? { outcome: search.outcome } : {}),
    ...(search.requestId ? { requestId: search.requestId } : {}),
    ...(kind ? { kind } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const page = useQuery({ ...queries.audit(query), placeholderData: keepPreviousData });
  const highlighted = search.requestId
    ? page.data?.items.find((entry) => entry.requestId === search.requestId)
    : undefined;

  // Open the entry a link pointed at.
  useEffect(() => {
    if (highlighted) setExpanded((current) => new Set(current).add(highlighted.id));
  }, [highlighted]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const linkMembers = staff.has("support");
  const columns: Column<AuditLogEntry>[] = [
    {
      id: "when",
      header: "When",
      cell: (entry) => (
        <button
          type="button"
          aria-expanded={expanded.has(entry.id)}
          onClick={() => toggle(entry.id)}
          className="focus-ring-inset -mx-1 inline-flex items-center gap-1 rounded-xs px-1 text-start text-fg hover:text-fg-muted"
        >
          {expanded.has(entry.id) ? <ChevronDownIcon size="xs" /> : <ChevronRightIcon size="xs" />}
          <span className="sr-only">Details of {auditHeadline(entry)}, </span>
          <Stamp value={entry.createdAt} />
        </button>
      ),
    },
    {
      id: "what",
      header: "What",
      cell: (entry) => (
        <span className="flex flex-col gap-1">
          <EntryWhat entry={entry} linkMembers={linkMembers} />
          {/* On phones the outcome rides under the action instead of in its own column. */}
          <span className="flex flex-col items-start gap-0.5 sm:hidden">
            <StatusBadge tone={AUDIT_OUTCOME[entry.outcome].tone}>
              {AUDIT_OUTCOME[entry.outcome].label}
            </StatusBadge>
            <EntryError entry={entry} />
          </span>
        </span>
      ),
    },
    {
      id: "actor",
      header: "Who",
      hideBelow: "md",
      cell: (entry) => (
        <span className="flex flex-col">
          <span className="text-fg">{entry.actor.name ?? entry.actor.id}</span>
          <span className="type-caption text-fg-subtle">{entry.actor.type}</span>
        </span>
      ),
    },
    {
      id: "reason",
      header: "Why",
      hideBelow: "lg",
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
      hideBelow: "sm",
      cell: (entry) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge tone={AUDIT_OUTCOME[entry.outcome].tone}>
            {AUDIT_OUTCOME[entry.outcome].label}
          </StatusBadge>
          <EntryError entry={entry} />
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        description="What staff did, to whom and why, newest first. Views of member data are recorded too, and listed when you ask for them. Unknown means an action ended without saying whether it happened: check the target before trying again."
      />
      <Filters
        key={filterKey}
        initial={search}
        mySubject={staff.identity.subject}
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
        {page.isPending ? (
          <LoadingRows rows={8} label="Loading the audit log" />
        ) : page.isError ? (
          <ErrorPanel error={page.error} onRetry={() => void page.refetch()} />
        ) : (
          <DataTable
            caption="Audit entries, newest first"
            columns={columns}
            rows={page.data.items}
            rowKey={(entry) => entry.id}
            highlight={(entry) => entry.id === highlighted?.id}
            expanded={(entry) => (expanded.has(entry.id) ? <EntryDetail entry={entry} /> : null)}
            empty={
              <Empty
                title="No entries"
                description={
                  show === "actions"
                    ? "No action matches these filters. Views of member data are left out: show them to look there too."
                    : "Nothing matches these filters."
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

interface FilterValues {
  targetType?: string;
  targetId?: string;
  actorId?: string;
  outcome?: AuditOutcome;
  requestId?: string;
  show?: AuditShow;
}

function Filters({
  initial,
  mySubject,
  onApply,
}: {
  initial: FilterValues;
  mySubject: string;
  onApply: (next: FilterValues) => void;
}) {
  const [targetType, setTargetType] = useState(initial.targetType ?? ANY);
  const [targetId, setTargetId] = useState(initial.targetId ?? "");
  const [actorId, setActorId] = useState(initial.actorId ?? "");
  const [outcome, setOutcome] = useState<string>(initial.outcome ?? ANY);
  const [requestId, setRequestId] = useState(initial.requestId ?? "");
  const [show, setShow] = useState<AuditShow>(auditShow(initial));
  const values = (): FilterValues => {
    const request = /^[A-Za-z0-9._-]{1,64}$/.test(requestId.trim()) ? requestId.trim() : null;
    return {
      ...(targetType !== ANY ? { targetType } : {}),
      ...(targetId.trim() ? { targetId: targetId.trim() } : {}),
      ...(actorId.trim() ? { actorId: actorId.trim() } : {}),
      ...(outcome !== ANY ? { outcome: outcome as AuditOutcome } : {}),
      ...(request ? { requestId: request } : {}),
      // Said in the URL only when it isn't what the URL would mean without it.
      ...(show !== auditShow(request ? { requestId: request } : {}) ? { show } : {}),
    };
  };
  return (
    <form
      aria-label="Filter the audit log"
      className="grid gap-3 rounded-lg border border-line-subtle bg-surface-1 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(values());
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
      <Field label="Target">
        <Select variant="compact" value={targetType} onValueChange={setTargetType}>
          <SelectItem value={ANY}>Any target</SelectItem>
          {Object.entries(TARGET_TYPES).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </Select>
      </Field>
      <Field label="Target ID">
        <Input
          size="sm"
          value={targetId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Account ID, key…"
          onChange={(event) => setTargetId(event.target.value)}
        />
      </Field>
      <Field label="Staff member">
        <Input
          size="sm"
          value={actorId}
          autoComplete="off"
          spellCheck={false}
          placeholder="Subject ID"
          onChange={(event) => setActorId(event.target.value)}
        />
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
      <div className="flex flex-wrap items-end gap-2">
        <Button type="submit" size="sm" variant="accent" icon={FilterIcon} className="h-9">
          Apply
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9"
          onClick={() => {
            setActorId(mySubject);
            onApply({ ...values(), actorId: mySubject });
          }}
        >
          Mine
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9"
          onClick={() => {
            setTargetType(ANY);
            setTargetId("");
            setActorId("");
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

function EntryDetail({ entry }: { entry: AuditLogEntry }) {
  const target = auditTarget(entry);
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
        <dt className="type-caption text-fg-subtle">What</dt>
        <dd className="type-body-sm text-fg">
          {auditHeadline(entry)}{" "}
          <code className="font-mono text-xs text-fg-subtle">{entry.action}</code>
        </dd>
        <dt className="type-caption text-fg-subtle">Why</dt>
        <dd className="type-body-sm break-words text-fg">
          {entry.reason ??
            (entry.kind === "read"
              ? "No reason (a view)"
              : target.erased
                ? "Not kept: the member was erased"
                : "None given")}
        </dd>
        <dt className="type-caption text-fg-subtle">Who</dt>
        <dd className="type-body-sm text-fg">
          {entry.actor.name ?? "Unnamed"}{" "}
          <span className="text-fg-subtle">({entry.actor.type})</span>{" "}
          <Identifier value={entry.actor.id} label="staff subject" />
        </dd>
        <dt className="type-caption text-fg-subtle">Target</dt>
        <dd className="flex flex-wrap items-center gap-x-2 type-body-sm break-words text-fg">
          {target.kind}
          {target.label ? `: ${target.label}` : ""}
          {target.erased ? null : <Identifier value={entry.target.id} label="target ID" />}
        </dd>
        <dt className="type-caption text-fg-subtle">Settled</dt>
        <dd className="type-body-sm text-fg">
          <DateTime
            value={entry.completedAt}
            seconds
            fallback={entry.outcome === "pending" ? "Not yet" : "At once"}
          />
        </dd>
        {entry.requestId ? (
          <>
            <dt className="type-caption text-fg-subtle">Request</dt>
            <dd>
              <Identifier value={entry.requestId} label="request ID" />
            </dd>
          </>
        ) : null}
        <dt className="type-caption text-fg-subtle">Entry</dt>
        <dd>
          <Identifier value={entry.id} label="audit entry ID" />
        </dd>
      </dl>
      <div className="grid gap-3 lg:grid-cols-2">
        <JsonBlock label="Before (what was asked, and the state)" value={entry.before} />
        <JsonBlock label="After (the result, or the error)" value={entry.after} />
      </div>
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="type-caption text-fg-subtle">{label}</span>
      <pre className="max-h-64 overflow-auto rounded-md bg-surface-3 p-2 font-mono text-xs text-fg-muted">
        {value === null ? "—" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
