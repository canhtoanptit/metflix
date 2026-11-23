/**
 * The analysis job's report for one experiment (services/recs schemas/experiment-report:
 * `experiments[]`), read defensively: the contract types it as JSON. The decision comes first,
 * from the sequential test the job uses (valid at any look), then the sample-ratio check, then
 * each metric with intervals. Anything unexpected falls back to the raw report.
 */
import type { ExperimentResults, JsonValue } from "@webflix/contracts";
import { AlertTriangleIcon, CheckCircleIcon, InfoIcon } from "@webflix/ui";
import type { ReactNode } from "react";
import { DateTime, StatusBadge } from "../../components/primitives.tsx";
import { METRIC_LABELS } from "./ExperimentsPage.tsx";

type Json = { [key: string]: JsonValue };

const isObject = (value: JsonValue | undefined): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: JsonValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: JsonValue | undefined): string | null =>
  typeof value === "string" ? value : null;
const interval = (value: JsonValue | undefined): [number | null, number | null] | null =>
  Array.isArray(value) && value.length === 2 ? [num(value[0]), num(value[1])] : null;

function fixed(value: number | null, digits = 3): string {
  return value === null ? "—" : value.toFixed(digits);
}

function percent(value: number | null): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function range(
  value: [number | null, number | null] | null,
  format: (n: number | null) => string,
): string {
  return value ? `${format(value[0])} to ${format(value[1])}` : "—";
}

const DECISIONS: Record<
  string,
  { label: string; tone: "positive" | "outline" | "danger" | "warning"; icon: ReactNode }
> = {
  significant: {
    label: "Significant",
    tone: "positive",
    icon: <CheckCircleIcon size="sm" className="text-positive" />,
  },
  "not-significant": {
    label: "Not significant",
    tone: "outline",
    icon: <InfoIcon size="sm" className="text-fg-muted" />,
  },
  "invalid-sample-ratio-mismatch": {
    label: "Invalid: sample ratio mismatch",
    tone: "danger",
    icon: <AlertTriangleIcon size="sm" className="text-danger" />,
  },
  "no-units": {
    label: "No units yet",
    tone: "warning",
    icon: <InfoIcon size="sm" className="text-warning" />,
  },
};

export function ResultsView({ results }: { results: ExperimentResults }) {
  const report = results.report;
  if (report === null) {
    return (
      <p className="type-body-sm text-fg-muted">
        No analysis yet. The analysis job publishes results after it runs (daily); an experiment
        needs exposures before there is anything to analyze.
      </p>
    );
  }
  if (!isObject(report)) return <RawReport report={report} />;
  const decision = isObject(report.decision) ? report.decision : null;
  const srm = isObject(report.srm) ? report.srm : null;
  const units = isObject(report.units) ? report.units : null;
  const metrics = isObject(report.metrics) ? report.metrics : null;
  const control = str(report.control);
  const status = str(decision?.status);
  const known = status ? DECISIONS[status] : undefined;
  return (
    <div className="flex flex-col gap-5">
      {decision ? (
        <div className="flex flex-col gap-1 rounded-md bg-surface-2 p-3">
          <span className="flex flex-wrap items-center gap-2">
            {known?.icon}
            <StatusBadge tone={known?.tone ?? "outline"}>
              {known?.label ?? status ?? "Unknown"}
            </StatusBadge>
            {str(decision.metric) ? (
              <span className="type-body-sm text-fg-muted">
                on {METRIC_LABELS[str(decision.metric) ?? ""] ?? str(decision.metric)}
              </span>
            ) : null}
          </span>
          {Array.isArray(decision.significantVariants) &&
          decision.significantVariants.length > 0 ? (
            <span className="type-body-sm text-fg">
              Differs from {control ?? "control"}:{" "}
              {decision.significantVariants.filter((v) => typeof v === "string").join(", ")}
            </span>
          ) : null}
          {str(decision.basis) ? (
            <span className="type-caption text-fg-subtle">{str(decision.basis)}</span>
          ) : null}
          {str(report.analysisEnd) ? (
            <span className="type-caption text-fg-subtle">
              Data up to <DateTime value={str(report.analysisEnd)} />
            </span>
          ) : null}
        </div>
      ) : null}
      {units ? (
        <div className="flex flex-col gap-1">
          <h3 className="type-caption text-fg-muted">Units per variant</h3>
          <p className="type-body-sm text-fg">
            {Object.entries(units)
              .map(
                ([variant, count]) => `${variant}: ${num(count)?.toLocaleString("en-US") ?? "—"}`,
              )
              .join(" · ")}
          </p>
          {srm ? (
            <p
              className={
                srm.flagged === true ? "type-body-sm text-danger" : "type-caption text-fg-subtle"
              }
            >
              Sample ratio check: p = {fixed(num(srm.pValue), 4)} (flagged below{" "}
              {num(srm.threshold) ?? "—"})
              {srm.flagged === true
                ? ". The split doesn't match the design: don't trust these results."
                : "."}
            </p>
          ) : null}
        </div>
      ) : null}
      {metrics
        ? Object.entries(metrics).map(([name, metric]) =>
            isObject(metric) ? (
              <MetricTable key={name} name={name} metric={metric} control={control} />
            ) : null,
          )
        : null}
      <RawReport report={report} collapsed />
    </div>
  );
}

function MetricTable({
  name,
  metric,
  control,
}: {
  name: string;
  metric: Json;
  control: string | null;
}) {
  const variants = isObject(metric.variants) ? metric.variants : {};
  const comparisons = Array.isArray(metric.comparisons) ? metric.comparisons.filter(isObject) : [];
  const byVariant = new Map(comparisons.map((comparison) => [str(comparison.variant), comparison]));
  return (
    <div className="flex flex-col gap-2">
      <h3 className="type-label text-fg">
        {METRIC_LABELS[name] ?? name}
        {metric.primary === true ? (
          <span className="type-caption text-fg-subtle"> · primary</span>
        ) : null}
      </h3>
      <section
        aria-label={`${METRIC_LABELS[name] ?? name} by variant`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls sideways must be reachable by keyboard (WCAG 2.1.1).
        tabIndex={0}
        className="focus-ring relative overflow-x-auto rounded-md border border-line-subtle"
      >
        <table className="w-full type-body-sm">
          <thead className="bg-surface-2">
            <tr>
              {[
                "Variant",
                "Units",
                "Mean (95% CI)",
                `vs ${control ?? "control"} (95% CI)`,
                "Lift (95% CI)",
                "Sequential test",
              ].map((header) => (
                <th
                  key={header}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 text-start type-caption text-fg-muted"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(variants).map(([variant, summary]) => {
              const values = isObject(summary) ? summary : {};
              const comparison = byVariant.get(variant);
              const sequential =
                comparison && isObject(comparison.sequential) ? comparison.sequential : null;
              return (
                <tr key={variant} className="border-t border-line-subtle">
                  <th
                    scope="row"
                    className="px-3 py-2 text-start font-mono text-xs font-normal text-fg"
                  >
                    {variant}
                  </th>
                  <td className="px-3 py-2 tabular-nums">
                    {num(values.units)?.toLocaleString("en-US") ?? "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {fixed(num(values.mean))}{" "}
                    <span className="text-fg-subtle">
                      ({range(interval(values.ci95), (n) => fixed(n))})
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {comparison ? (
                      <>
                        {fixed(num(comparison.difference))}{" "}
                        <span className="text-fg-subtle">
                          ({range(interval(comparison.ci95), (n) => fixed(n))})
                        </span>
                      </>
                    ) : (
                      <span className="text-fg-subtle">control</span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                    {comparison ? (
                      <>
                        {percent(num(comparison.relativeLift))}{" "}
                        <span className="text-fg-subtle">
                          ({range(interval(comparison.relativeLiftCi95), percent)})
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {sequential ? (
                      <span className="flex items-center gap-2">
                        <StatusBadge
                          tone={sequential.significant === true ? "positive" : "outline"}
                        >
                          {sequential.significant === true ? "Significant" : "Not yet"}
                        </StatusBadge>
                        <span className="tabular-nums text-fg-subtle">
                          p = {fixed(num(sequential.alwaysValidP), 4)}
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function RawReport({ report, collapsed = false }: { report: JsonValue; collapsed?: boolean }) {
  return (
    <details open={!collapsed} className="group">
      <summary className="focus-ring cursor-pointer rounded-xs type-caption text-fg-muted hover:text-fg">
        The full report (JSON)
      </summary>
      <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-fg-muted">
        {JSON.stringify(report, null, 2)}
      </pre>
    </details>
  );
}
