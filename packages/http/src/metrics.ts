/**
 * A small, portable Prometheus registry (text exposition format 0.0.4). Enough for request
 * counters and latency histograms; runtime-specific gauges (process memory, event loop lag)
 * are added by the Node entrypoint through `gauge(..., collect)`.
 *
 * Registering the same name twice returns the existing metric, so several apps can share one
 * registry without coordination.
 */

export type Labels = Readonly<Record<string, string>>;

export interface Counter {
  inc(labels?: Labels, value?: number): void;
}

export interface Histogram {
  observe(labels: Labels, value: number): void;
}

export interface Gauge {
  set(value: number, labels?: Labels): void;
}

export interface GaugeSample {
  labels?: Labels;
  value: number;
}

export interface MetricsRegistry {
  counter(name: string, help: string, labelNames?: readonly string[]): Counter;
  histogram(
    name: string,
    help: string,
    labelNames?: readonly string[],
    buckets?: readonly number[],
  ): Histogram;
  /** A gauge set explicitly, or computed at scrape time by `collect`. */
  gauge(name: string, help: string, collect?: () => number | readonly GaugeSample[]): Gauge;
  /** The whole registry in Prometheus text format. */
  render(): string;
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Latency buckets in seconds, from fast cache hits to slow cold starts. */
export const DEFAULT_LATENCY_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function escapeHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function labelKey(labelNames: readonly string[], labels: Labels | undefined): string {
  return JSON.stringify(labelNames.map((name) => labels?.[name] ?? ""));
}

function formatLabels(pairs: readonly (readonly [string, string])[]): string {
  if (pairs.length === 0) return "";
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

interface Metric {
  render(): string[];
}

export function createMetricsRegistry(): MetricsRegistry {
  const metrics = new Map<string, { type: string; metric: Metric & object }>();

  const register = <M extends Metric>(name: string, type: string, create: () => M): M => {
    if (!NAME_PATTERN.test(name)) throw new TypeError(`Invalid metric name ${name}`);
    const existing = metrics.get(name);
    if (existing) {
      if (existing.type !== type)
        throw new TypeError(`Metric ${name} is already a ${existing.type}`);
      return existing.metric as M;
    }
    const metric = create();
    metrics.set(name, { type, metric });
    return metric;
  };

  const header = (name: string, help: string, type: string) => [
    `# HELP ${name} ${escapeHelp(help)}`,
    `# TYPE ${name} ${type}`,
  ];

  return {
    counter(name, help, labelNames = []) {
      return register(name, "counter", () => {
        const values = new Map<string, { labels: string[]; value: number }>();
        return {
          inc(labels?: Labels, value = 1) {
            const key = labelKey(labelNames, labels);
            const entry = values.get(key) ?? {
              labels: labelNames.map((label) => labels?.[label] ?? ""),
              value: 0,
            };
            entry.value += value;
            values.set(key, entry);
          },
          render() {
            return [
              ...header(name, help, "counter"),
              ...[...values.values()].map(
                (entry) =>
                  `${name}${formatLabels(labelNames.map((label, index) => [label, entry.labels[index] ?? ""]))} ${formatNumber(entry.value)}`,
              ),
            ];
          },
        };
      });
    },

    histogram(name, help, labelNames = [], buckets = DEFAULT_LATENCY_BUCKETS) {
      const bounds = [...buckets].sort((a, b) => a - b);
      return register(name, "histogram", () => {
        const series = new Map<
          string,
          { labels: string[]; counts: number[]; sum: number; count: number }
        >();
        return {
          observe(labels: Labels, value: number) {
            const key = labelKey(labelNames, labels);
            let entry = series.get(key);
            if (!entry) {
              entry = {
                labels: labelNames.map((label) => labels[label] ?? ""),
                counts: bounds.map(() => 0),
                sum: 0,
                count: 0,
              };
              series.set(key, entry);
            }
            bounds.forEach((bound, index) => {
              if (value <= bound && entry) entry.counts[index] = (entry.counts[index] ?? 0) + 1;
            });
            entry.sum += value;
            entry.count += 1;
          },
          render() {
            const lines = header(name, help, "histogram");
            for (const entry of series.values()) {
              const base = labelNames.map(
                (label, index) => [label, entry.labels[index] ?? ""] as const,
              );
              bounds.forEach((bound, index) => {
                lines.push(
                  `${name}_bucket${formatLabels([...base, ["le", formatNumber(bound)]])} ${entry.counts[index] ?? 0}`,
                );
              });
              lines.push(`${name}_bucket${formatLabels([...base, ["le", "+Inf"]])} ${entry.count}`);
              lines.push(`${name}_sum${formatLabels(base)} ${formatNumber(entry.sum)}`);
              lines.push(`${name}_count${formatLabels(base)} ${entry.count}`);
            }
            return lines;
          },
        };
      });
    },

    gauge(name, help, collect) {
      return register(name, "gauge", () => {
        const values = new Map<string, { labels: Labels; value: number }>();
        return {
          set(value: number, labels: Labels = {}) {
            values.set(JSON.stringify(Object.entries(labels).sort()), { labels, value });
          },
          render() {
            const lines = header(name, help, "gauge");
            const collected = collect?.();
            const samples: GaugeSample[] =
              collected === undefined
                ? [...values.values()]
                : typeof collected === "number"
                  ? [{ value: collected }]
                  : [...collected];
            for (const sample of samples) {
              lines.push(
                `${name}${formatLabels(Object.entries(sample.labels ?? {}))} ${formatNumber(sample.value)}`,
              );
            }
            return lines;
          },
        };
      });
    },

    render() {
      return `${[...metrics.values()].flatMap(({ metric }) => metric.render()).join("\n")}\n`;
    },
  };
}
