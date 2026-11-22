/** Experiment definitions, with where each stands for members right now. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EXPERIMENT_BUCKETS, type ExperimentDefinition } from "@webflix/contracts";
import { Button, PlusIcon, SegmentedControl } from "@webflix/ui";
import { useState } from "react";
import { queries } from "../../api/queries.ts";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import { DateTime, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { formatRelative } from "../../lib/format.ts";
import { useDocumentTitle, useNow } from "../../lib/hooks.ts";
import { EXPERIMENT } from "../../lib/status.ts";
import { experimentPhase } from "./phase.ts";

const FILTERS = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];

export const METRIC_LABELS: Record<string, string> = {
  qualified_plays: "Qualified plays",
  watch_hours: "Watch hours",
  any_play: "Any play",
  active_days: "Active days",
  retained: "Retained",
};

export function allocationShare(definition: ExperimentDefinition): string {
  const share =
    ((definition.allocation.end - definition.allocation.start) / EXPERIMENT_BUCKETS) * 100;
  const enrolled = (share * definition.targeting.percentage) / 100;
  return `${Number(enrolled.toFixed(2))}%`;
}

export function ExperimentsPage() {
  useDocumentTitle("Experiments");
  const experiments = useQuery(queries.experiments());
  const [filter, setFilter] = useState<Filter>("active");
  const pendingChange = experiments.data?.items.some(
    (item) => item.statusChangeAt !== null && Date.parse(item.statusChangeAt) > Date.now(),
  );
  const now = useNow(1_000, pendingChange ?? false);
  const rows = (experiments.data?.items ?? []).filter((item) =>
    filter === "all"
      ? true
      : filter === "active"
        ? ["draft", "running", "paused"].includes(item.status)
        : item.status === filter,
  );

  const columns: Column<ExperimentDefinition>[] = [
    {
      id: "name",
      header: "Experiment",
      sortValue: (row) => row.name.toLowerCase(),
      cell: (row) => (
        <span className="flex flex-col">
          <Link
            to="/experiments/$key"
            params={{ key: row.key }}
            className="focus-ring rounded-xs font-semibold text-fg underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
          <code className="font-mono text-xs text-fg-subtle">{row.key}</code>
        </span>
      ),
    },
    {
      id: "status",
      header: "Now",
      sortValue: (row) => row.status,
      cell: (row) => {
        const phase = experimentPhase(row, now);
        return (
          <span className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusBadge tone={phase.tone}>{phase.label}</StatusBadge>
              {phase.label !== EXPERIMENT[row.status].label ? (
                <span className="type-caption text-fg-subtle">{EXPERIMENT[row.status].label}</span>
              ) : null}
            </span>
            {phase.changesAt && (phase.tone === "warning" || phase.label === "Scheduled") ? (
              <span className="type-caption tabular-nums text-fg-muted">
                {phase.changeLabel} <DateTime value={phase.changesAt} seconds /> (
                {formatRelative(phase.changesAt, now)})
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "share",
      header: "Enrolled",
      align: "end",
      hideBelow: "md",
      sortValue: (row) => (row.allocation.end - row.allocation.start) * row.targeting.percentage,
      cell: (row) => <span className="tabular-nums">{allocationShare(row)}</span>,
    },
    {
      id: "layer",
      header: "Layer",
      hideBelow: "lg",
      sortValue: (row) => row.layer,
      cell: (row) => <code className="font-mono text-xs text-fg-muted">{row.layer}</code>,
    },
    {
      id: "metric",
      header: "Primary metric",
      hideBelow: "lg",
      cell: (row) => METRIC_LABELS[row.primaryMetric] ?? row.primaryMetric,
    },
    {
      id: "updated",
      header: "Changed",
      hideBelow: "md",
      sortValue: (row) => row.updatedAt,
      cell: (row) => <DateTime value={row.updatedAt} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Experiments"
        description="Status changes take effect for every member at one moment, up to a minute after you make them; each experiment shows when."
        actions={
          <Button asChild variant="accent" size="sm" icon={PlusIcon}>
            <Link to="/experiments/new">New experiment</Link>
          </Button>
        }
      />
      <Section
        title="Experiments"
        actions={
          <SegmentedControl
            aria-label="Show"
            value={filter}
            onValueChange={setFilter}
            options={FILTERS}
          />
        }
      >
        {experiments.isPending ? (
          <LoadingRows rows={4} label="Loading experiments" />
        ) : experiments.isError ? (
          <ErrorPanel error={experiments.error} onRetry={() => void experiments.refetch()} />
        ) : (
          <DataTable
            caption="Experiments"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.key}
            initialSort={{ column: "updated", direction: "desc" }}
            pageSize={25}
            empty={
              <Empty
                title={filter === "active" ? "No active experiments" : "Nothing here"}
                description={
                  filter === "active"
                    ? "Define one to start testing a change on part of the member base."
                    : "Try another filter."
                }
              />
            }
          />
        )}
      </Section>
    </>
  );
}
