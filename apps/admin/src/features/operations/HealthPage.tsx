/** Dependencies, the job queue and failed jobs, refreshed every 30 seconds. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, CheckCircleIcon, RefreshIcon, XCircleIcon } from "@webflix/ui";
import { queries } from "../../api/queries.ts";
import { DateTime, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";

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
        description="What the service depends on, checked now (2 seconds each), and jobs that failed every attempt. Refreshes every 30 seconds."
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
