/**
 * Dependencies, the job queue and failed jobs, and the privacy work waiting (erasures, data
 * exports) with a warning where it has waited past its normal time (privacy-backlog.ts says
 * which times and why). Refreshed every 30 seconds.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SystemHealth } from "@webflix/contracts";
import { AlertTriangleIcon, Button, CheckCircleIcon, RefreshIcon, XCircleIcon } from "@webflix/ui";
import { queries } from "../../api/queries.ts";
import { DateTime, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { backlogCount, formatAge, privacyBacklog } from "./privacy-backlog.ts";

const NAMES: Record<string, string> = {
  database: "Database",
  cache: "Cache",
  "recommendation-store": "Recommendation store",
};

export function HealthPage() {
  useDocumentTitle("System health");
  const health = useQuery(queries.health());
  return (
    <>
      <PageHeader
        title="System health"
        description="What the service depends on, checked now (2 seconds each), jobs that failed every attempt, and privacy work waiting to be done. Refreshes every 30 seconds."
        actions={
          <Button
            variant="outline"
            size="sm"
            icon={RefreshIcon}
            loading={health.isFetching}
            onClick={() => void health.refetch()}
          >
            Check now
          </Button>
        }
      />
      {health.isPending ? (
        <LoadingRows rows={4} label="Checking" />
      ) : health.isError ? (
        <ErrorPanel error={health.error} onRetry={() => void health.refetch()} />
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <PrivacyWork privacy={health.data.privacy} />
          <Section
            title="Dependencies"
            description={
              <>
                Checked <DateTime value={health.data.checkedAt} seconds />
              </>
            }
          >
            <ul className="flex flex-col divide-y divide-line-subtle">
              {health.data.dependencies.map((dependency) => (
                <li
                  key={dependency.name}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                >
                  <span className="flex items-center gap-2 type-body-sm text-fg">
                    {dependency.up ? (
                      <CheckCircleIcon size="sm" className="text-positive" />
                    ) : (
                      <XCircleIcon size="sm" className="text-danger" />
                    )}
                    {NAMES[dependency.name] ?? dependency.name}
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge tone={dependency.up ? "positive" : "danger"}>
                      {dependency.up ? "Up" : dependency.detail === "timeout" ? "Too slow" : "Down"}
                    </StatusBadge>
                  </span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Jobs">
            <dl className="grid grid-cols-2 gap-3">
              <div className="rounded-md bg-surface-2 p-3">
                <dt className="type-caption text-fg-subtle">Waiting in the queue</dt>
                <dd className="type-title tabular-nums text-fg">
                  {health.data.jobs.depth ?? (
                    <span className="type-body-sm text-fg-muted">Not reported</span>
                  )}
                </dd>
              </div>
              <div className="rounded-md bg-surface-2 p-3">
                <dt className="type-caption text-fg-subtle">Failed every attempt</dt>
                <dd className="type-title tabular-nums text-fg">{health.data.jobs.deadLetters}</dd>
              </div>
            </dl>
            {health.data.jobs.depth === null ? (
              <p className="mt-3 type-caption text-fg-subtle">
                This deployment's queue doesn't report its depth here (on Kubernetes it is on the
                metrics endpoint).
              </p>
            ) : null}
            {health.data.jobs.deadLetters > 0 ? (
              <Button asChild size="sm" variant="outline" className="mt-3">
                <Link to="/operations/dead-letters">See the failed jobs</Link>
              </Button>
            ) : null}
          </Section>
        </div>
      )}
    </>
  );
}

function PrivacyWork({ privacy }: { privacy: SystemHealth["privacy"] }) {
  const lines = privacyBacklog(privacy);
  const overdue = lines.filter((line) => line.warning);
  return (
    <Section
      title="Privacy work"
      description="Members' erasures and data exports not finished yet, with how long the oldest has waited."
      className="xl:col-span-2"
      actions={
        <Button asChild size="sm" variant="outline">
          <Link to="/operations/privacy">Privacy jobs</Link>
        </Button>
      }
    >
      {overdue.length > 0 ? (
        <div className="mb-4 flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
          <AlertTriangleIcon size="sm" className="mt-0.5 shrink-0 text-warning" />
          <div className="flex flex-col gap-1">
            <p className="type-label text-fg">
              {overdue.length === 1
                ? `${overdue[0]?.label ?? "Privacy work"}: overdue`
                : "Privacy work is overdue"}
            </p>
            {overdue.map((line) => (
              <p key={line.id} className="type-body-sm text-fg-muted">
                {line.advice}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      <ul className="grid gap-3 md:grid-cols-3" aria-label="Privacy work waiting">
        {lines.map((line) => (
          <li key={line.id} className="flex min-w-0 flex-col gap-1.5 rounded-md bg-surface-2 p-3">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="type-caption text-fg-subtle">{line.label}</span>
              {line.count === 0 ? (
                <StatusBadge tone="positive">None waiting</StatusBadge>
              ) : line.warning ? (
                <StatusBadge tone="warning">Overdue</StatusBadge>
              ) : (
                <StatusBadge tone="outline">On time</StatusBadge>
              )}
            </span>
            <span className="type-title tabular-nums text-fg">{backlogCount(line.count)}</span>
            <span className="type-caption text-fg-muted">
              {line.oldestAgeSec !== null && line.oldestAt ? (
                <>
                  Oldest waiting {formatAge(line.oldestAgeSec)}, since{" "}
                  <DateTime value={line.oldestAt} />
                </>
              ) : (
                "Nothing waiting"
              )}
            </span>
            <span className="type-caption text-fg-subtle">Normal wait: {line.normal}.</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
