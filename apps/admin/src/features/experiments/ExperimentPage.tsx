/**
 * One experiment: where it stands for members (with the moment a status change takes effect,
 * counted down), its pre-registered design, the status actions it allows, and the analysis
 * job's latest results.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ApiError, EXPERIMENT_BUCKETS, type ExperimentDefinition } from "@webflix/contracts";
import { Button, ChevronLeftIcon, ClockIcon, cx, EditIcon } from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import {
  DateTime,
  KeyValueList,
  PageHeader,
  Section,
  StatusBadge,
} from "../../components/primitives.tsx";
import { ErrorPanel, LoadingPage } from "../../components/states.tsx";
import { formatRelative } from "../../lib/format.ts";
import { useDocumentTitle, useNow } from "../../lib/hooks.ts";
import { EXPERIMENT, planName } from "../../lib/status.ts";
import { allocationShare, METRIC_LABELS } from "./ExperimentsPage.tsx";
import { actionLabel, experimentPhase, TRANSITIONS } from "./phase.ts";
import { ResultsView } from "./ResultsView.tsx";

const route = getRouteApi("/experiments/$key");
type Status = ExperimentDefinition["status"];

export function ExperimentPage() {
  const { key } = route.useParams();
  useDocumentTitle("Experiment");
  const experiment = useQuery(queries.experiment(key));
  if (experiment.isPending) return <LoadingPage label="Loading the experiment" />;
  if (experiment.isError) {
    return (
      <>
        <BackLink />
        <ErrorPanel
          layout="page"
          error={experiment.error}
          title={
            ApiError.is(experiment.error, "not_found") ? "No experiment with this key" : undefined
          }
          onRetry={() => void experiment.refetch()}
        />
      </>
    );
  }
  return <ExperimentView definition={experiment.data} />;
}

function BackLink() {
  return (
    <Link
      to="/experiments"
      className="focus-ring mb-3 inline-flex items-center gap-1 rounded-xs type-body-sm text-fg-muted hover:text-fg"
    >
      <ChevronLeftIcon size="sm" />
      Experiments
    </Link>
  );
}

function ExperimentView({ definition }: { definition: ExperimentDefinition }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const counting =
    definition.statusChangeAt !== null &&
    Date.parse(definition.statusChangeAt) > Date.now() - 1_000;
  const now = useNow(1_000, true);
  const phase = experimentPhase(definition, now);
  const transitions = TRANSITIONS[definition.status];
  const editable =
    definition.status === "draft" ||
    definition.status === "running" ||
    definition.status === "paused";

  // When a scheduled change comes into effect, read the definition again to confirm it.
  const wasCounting = useRef(counting);
  useEffect(() => {
    if (wasCounting.current && !counting) {
      void queryClient.invalidateQueries({ queryKey: qk.experiment(definition.key) });
      void queryClient.invalidateQueries({ queryKey: qk.experiments(), exact: true });
    }
    wasCounting.current = counting;
  }, [counting, queryClient, definition.key]);

  return (
    <>
      <BackLink />
      <PageHeader
        title={definition.name}
        eyebrow={<code className="font-mono">{definition.key}</code>}
        actions={
          <>
            {editable ? (
              <Button asChild size="sm" variant="outline" icon={EditIcon}>
                <Link to="/experiments/$key/edit" params={{ key: definition.key }}>
                  {definition.status === "draft" ? "Edit design" : "Change end"}
                </Link>
              </Button>
            ) : null}
            {transitions.map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === "running" ? "accent" : to === "archived" ? "ghost" : "outline"}
                onClick={() => {
                  setTarget(to);
                  setOpen(true);
                }}
              >
                {actionLabel(definition.status, to)}
              </Button>
            ))}
          </>
        }
      />
      <div
        role="status"
        className={cx(
          "mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-4",
          phase.tone === "warning" ? "border-warning/40" : "border-line-subtle bg-surface-1",
        )}
      >
        <StatusBadge tone={phase.tone}>{phase.label}</StatusBadge>
        {phase.changesAt && phase.tone === "warning" ? (
          <span className="flex items-center gap-1.5 type-body-sm text-fg">
            <ClockIcon size="sm" className="text-warning" />
            {phase.changeLabel} <DateTime value={phase.changesAt} seconds />
            <span className="tabular-nums text-fg-muted">
              ({formatRelative(phase.changesAt, now)})
            </span>
          </span>
        ) : phase.changesAt && phase.label === "Scheduled" ? (
          <span className="type-body-sm text-fg">
            {phase.changeLabel} <DateTime value={phase.changesAt} seconds />{" "}
            <span className="tabular-nums text-fg-muted">
              ({formatRelative(phase.changesAt, now)})
            </span>
          </span>
        ) : phase.label === "Live" && definition.startsAt ? (
          <span className="type-body-sm text-fg">
            Since <DateTime value={definition.startsAt} />
            {definition.endsAt ? (
              <>
                , until <DateTime value={definition.endsAt} />
              </>
            ) : null}
          </span>
        ) : null}
        {phase.detail ? (
          <span className="w-full type-caption text-fg-muted">{phase.detail}</span>
        ) : null}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <DesignSection definition={definition} />
        <ResultsSection experimentKey={definition.key} />
      </div>
      {target ? (
        <StatusDialog
          key={target}
          definition={definition}
          to={target}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function DesignSection({ definition }: { definition: ExperimentDefinition }) {
  const { targeting, allocation } = definition;
  const totalWeight = definition.variants.reduce((sum, variant) => sum + variant.weight, 0);
  return (
    <Section
      title="Design"
      description={
        definition.status === "draft"
          ? "Can change until it starts."
          : "Fixed since it started (pre-registered)."
      }
    >
      <KeyValueList
        items={[
          ...(definition.description
            ? [{ label: "Description", value: definition.description }]
            : []),
          {
            label: "Variants",
            value: (
              <ul className="flex flex-col gap-0.5">
                {definition.variants.map((variant) => (
                  <li key={variant.name}>
                    <code className="font-mono text-sm">{variant.name}</code>{" "}
                    <span className="text-fg-subtle">
                      {Math.round((variant.weight / totalWeight) * 100)}%
                      {variant.name === definition.control ? " · control" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ),
          },
          {
            label: "Who",
            value: `${definition.unit === "profile" ? "Profiles" : "Devices (before sign-in)"}; ${allocationShare(definition)} of all units (${(((allocation.end - allocation.start) / EXPERIMENT_BUCKETS) * 100).toFixed(2)}% of layer ${definition.layer}, ${targeting.percentage}% of those)`,
          },
          {
            label: "Targeting",
            value: [
              targeting.audience === "all"
                ? "All members"
                : targeting.audience === "new"
                  ? "New members"
                  : "Existing members",
              targeting.plans.length > 0
                ? `plans ${targeting.plans.map(planName).join(", ")}`
                : "every plan",
              targeting.countries.length > 0
                ? `in ${targeting.countries.join(", ")}`
                : "every country",
            ].join(" · "),
          },
          {
            label: "Primary metric",
            value: METRIC_LABELS[definition.primaryMetric] ?? definition.primaryMetric,
          },
          ...(definition.secondaryMetrics.length > 0
            ? [
                {
                  label: "Secondary",
                  value: definition.secondaryMetrics
                    .map((metric) => METRIC_LABELS[metric] ?? metric)
                    .join(", "),
                },
              ]
            : []),
          {
            label: "Sized for",
            value: `a ${(definition.minimumDetectableEffect * 100).toFixed(1)}% relative effect, α ${definition.alpha}${definition.power ? `, power ${definition.power}` : ""}`,
          },
          {
            label: "Starts",
            value: <DateTime value={definition.startsAt} fallback="When started" />,
          },
          { label: "Ends", value: <DateTime value={definition.endsAt} fallback="No end set" /> },
          {
            label: "Registered",
            value: <DateTime value={definition.registeredAt} fallback="Not yet (a draft)" />,
          },
        ]}
      />
    </Section>
  );
}

function ResultsSection({ experimentKey }: { experimentKey: string }) {
  const results = useQuery(queries.experimentResults(experimentKey));
  return (
    <Section
      title="Results"
      description={
        results.data?.computedAt ? (
          <>
            Analysed <DateTime value={results.data.computedAt} />
          </>
        ) : (
          "From the analysis job's latest run."
        )
      }
    >
      {results.isPending ? (
        <p className="type-body-sm text-fg-subtle">Loading results…</p>
      ) : results.isError ? (
        <ErrorPanel error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <ResultsView results={results.data} />
      )}
    </Section>
  );
}

function StatusDialog({
  definition,
  to,
  open,
  onOpenChange,
}: {
  definition: ExperimentDefinition;
  to: Status;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const label = actionLabel(definition.status, to);
  const descriptions: Record<Status, string> = {
    running:
      definition.status === "draft"
        ? "Starting registers the design: it can't change afterwards, except its end. Members start being assigned at one moment for every server, up to a minute after you confirm; the next screen says exactly when."
        : "Members are assigned again from one moment for every server, up to a minute after you confirm.",
    paused:
      "Nobody new is assigned from one moment for every server, up to a minute after you confirm. Members already assigned keep their variant while it's paused.",
    completed:
      "Ends the experiment for good: nobody is assigned from one moment for every server, up to a minute after you confirm. It can't be restarted.",
    archived: "Moves it out of the active list. Nothing changes for members.",
    draft: "",
  };
  return (
    <ActionDialog<ExperimentDefinition>
      open={open}
      onOpenChange={onOpenChange}
      scope={`experiment-status:${definition.key}:${to}`}
      title={`${label} “${definition.name}”`}
      description={descriptions[to]}
      confirmLabel={label}
      tone={to === "completed" ? "danger" : "accent"}
      audit={{ targetType: "experiment", targetId: definition.key }}
      run={({ reason, signal, headers }) =>
        staffApi().setExperimentStatus(
          { params: { key: definition.key }, body: { status: to, reason } },
          { signal, headers },
        )
      }
      onSuccess={(next) => {
        queryClient.setQueryData(qk.experiment(definition.key), next);
        void queryClient.invalidateQueries({ queryKey: qk.experiments(), exact: true });
      }}
      success={(next) =>
        next.statusChangeAt ? (
          <>
            Now {EXPERIMENT[next.status].label.toLowerCase()}. It takes effect for every member at{" "}
            <DateTime value={next.statusChangeAt} seconds /> (
            {formatRelative(next.statusChangeAt, Date.now())}); until then they're assigned as
            before.
          </>
        ) : (
          `Now ${EXPERIMENT[next.status].label.toLowerCase()}, in effect for every member.`
        )
      }
    />
  );
}
