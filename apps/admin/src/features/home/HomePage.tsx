/**
 * Where a staff member lands: the areas their roles open, and for admins what needs following
 * up (actions that ended with an unknown outcome, failed jobs, a dependency down).
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AuditLogEntry } from "@webflix/contracts";
import { ArrowRightIcon, CheckCircleIcon, cx } from "@webflix/ui";
import { AREAS, ROLE_LABELS } from "../../access/roles.ts";
import { useStaff } from "../../access/staff.tsx";
import { queries } from "../../api/queries.ts";
import { DateTime, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { AUDIT_OUTCOME } from "../../lib/status.ts";
import { auditFilterFor } from "../operations/audit-filter.ts";

const AREA_LINKS = {
  members: "/members",
  plans: "/plans",
  content: "/content/billboards",
  experiments: "/experiments",
  operations: "/operations/health",
} as const;

export function HomePage() {
  useDocumentTitle("Overview");
  const staff = useStaff();
  const areas = AREAS.filter((area) => staff.has(area.role));
  const name = staff.identity.name ?? staff.identity.email ?? "staff member";
  return (
    <>
      <PageHeader
        title="Overview"
        description={`Signed in as ${name}, with ${staff.roles.length === 1 ? "the role" : "the roles"} ${staff.roles.map((role) => ROLE_LABELS[role]).join(", ")}.`}
      />
      <div className="flex flex-col gap-6">
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Your areas">
          {areas.map((area) => (
            <li key={area.id}>
              <Link
                to={AREA_LINKS[area.id]}
                className="focus-ring group flex h-full flex-col gap-1 rounded-lg border border-line-subtle bg-surface-1 p-4 transition-colors duration-fast hover:border-line hover:bg-surface-2"
              >
                <span className="flex items-center justify-between gap-2 type-label text-fg">
                  {area.label}
                  <ArrowRightIcon
                    size="sm"
                    className="text-fg-subtle transition-transform duration-fast group-hover:translate-x-0.5"
                  />
                </span>
                <span className="type-body-sm text-fg-muted">{area.description}</span>
              </Link>
            </li>
          ))}
        </ul>
        {staff.has("admin") ? <NeedsAttention /> : <YourFollowUps />}
      </div>
    </>
  );
}

/** Without the admin role: your own actions that ended without a clear outcome, or still run. */
function YourFollowUps() {
  const unknown = useQuery(queries.ownAudit({ outcome: "unknown", limit: 5 }));
  const pending = useQuery(queries.ownAudit({ outcome: "pending", limit: 5 }));
  const entries: AuditLogEntry[] = [...(unknown.data?.items ?? []), ...(pending.data?.items ?? [])];
  const error = unknown.error ?? pending.error;
  return (
    <Section
      title="Your actions to follow up"
      description="Actions of yours that ended without saying whether they happened, or haven't ended yet."
    >
      {unknown.isPending || pending.isPending ? (
        <LoadingRows rows={2} label="Loading your actions" />
      ) : error ? (
        <ErrorPanel
          error={error}
          onRetry={() => {
            void unknown.refetch();
            void pending.refetch();
          }}
        />
      ) : entries.length === 0 ? (
        <p className="flex items-center gap-2 type-body-sm text-fg-muted">
          <CheckCircleIcon size="sm" className="text-positive" />
          Nothing to follow up: every action of yours has settled.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex flex-wrap items-center gap-2 type-body-sm text-fg">
                <StatusBadge tone={AUDIT_OUTCOME[entry.outcome].tone}>
                  {AUDIT_OUTCOME[entry.outcome].label}
                </StatusBadge>
                <code className="font-mono text-xs text-fg-muted">{entry.action}</code>
                <DateTime value={entry.createdAt} />
              </span>
              <Link
                to="/activity"
                search={entry.requestId ? { requestId: entry.requestId } : {}}
                className="focus-ring rounded-xs type-body-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline"
              >
                Open in your actions
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function NeedsAttention() {
  const unknown = useQuery(queries.audit({ outcome: "unknown", limit: 5 }));
  const pending = useQuery(queries.audit({ outcome: "pending", limit: 5 }));
  const health = useQuery(queries.health());
  const down = health.data?.dependencies.filter((dependency) => !dependency.up) ?? [];
  const deadLetters = health.data?.jobs.deadLetters ?? 0;
  const entries: AuditLogEntry[] = [...(unknown.data?.items ?? []), ...(pending.data?.items ?? [])];
  const loading = unknown.isPending || pending.isPending || health.isPending;
  const error = unknown.error ?? pending.error ?? health.error;

  return (
    <Section
      title="Needs attention"
      description="Actions without a settled outcome, failed jobs and dependencies that are down."
    >
      {loading ? (
        <LoadingRows rows={3} label="Loading what needs attention" />
      ) : error ? (
        <ErrorPanel
          error={error}
          onRetry={() => {
            void unknown.refetch();
            void pending.refetch();
            void health.refetch();
          }}
        />
      ) : entries.length === 0 && down.length === 0 && deadLetters === 0 ? (
        <p className="flex items-center gap-2 type-body-sm text-fg-muted">
          <CheckCircleIcon size="sm" className="text-positive" />
          Nothing to follow up: every action settled, no failed jobs, every dependency up.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle">
          {down.map((dependency) => (
            <li
              key={dependency.name}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <span className="type-body-sm text-fg">
                {dependency.name} is down{dependency.detail ? ` (${dependency.detail})` : ""}
              </span>
              <Link
                to="/operations/health"
                className="focus-ring rounded-xs type-body-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline"
              >
                System health
              </Link>
            </li>
          ))}
          {deadLetters > 0 ? (
            <li className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="type-body-sm text-fg">
                {deadLetters === 1 ? "1 job" : `${deadLetters} jobs`} failed every attempt
              </span>
              <Link
                to="/operations/dead-letters"
                className="focus-ring rounded-xs type-body-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline"
              >
                Failed jobs
              </Link>
            </li>
          ) : null}
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className={cx("flex flex-wrap items-center gap-2 type-body-sm text-fg")}>
                <StatusBadge tone={AUDIT_OUTCOME[entry.outcome].tone}>
                  {AUDIT_OUTCOME[entry.outcome].label}
                </StatusBadge>
                <code className="font-mono text-xs text-fg-muted">{entry.action}</code>
                <span className="text-fg-muted">by {entry.actor.name ?? entry.actor.id}</span>
                <DateTime value={entry.createdAt} />
              </span>
              <Link
                to="/operations/audit"
                search={
                  entry.requestId ? { requestId: entry.requestId } : auditFilterFor(entry.target)
                }
                className="focus-ring rounded-xs type-body-sm text-fg-muted underline-offset-4 hover:text-fg hover:underline"
              >
                Open in the audit log
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
