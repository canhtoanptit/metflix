/** Human-readable rendering of results; the JSON summary is the `RunReport` itself. */
import {
  AREAS,
  type CheckDefinition,
  type CheckResult,
  type Outcome,
  type RunReport,
} from "./types.ts";

export interface Style {
  color: boolean;
}

const LABELS: Record<Outcome, string> = {
  pass: "PASS ",
  fail: "FAIL ",
  skip: "SKIP ",
  xfail: "XFAIL",
  xpass: "XPASS",
};

const COLORS: Record<Outcome, string> = {
  pass: "32",
  fail: "31",
  skip: "33",
  xfail: "35",
  xpass: "36",
};

function paint(style: Style, code: string, text: string): string {
  return style.color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function seconds(ms: number): string {
  return ms >= 10_000
    ? `${(ms / 1000).toFixed(0)} s`
    : ms >= 1000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${ms} ms`;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** One line per finished check (progress output), plus details for failures. */
export function formatResult(result: CheckResult, style: Style, verbose = false): string {
  const label = paint(style, COLORS[result.outcome], LABELS[result.outcome]);
  const head = `${label} ${result.id.padEnd(46)} ${seconds(result.durationMs).padStart(7)}  ${result.title}`;
  const lines = [head];
  if (result.finding && (result.outcome === "xfail" || result.outcome === "xpass")) {
    lines.push(
      `        finding:  ${result.finding.id} (${result.finding.owner}) ${result.finding.summary}${result.outcome === "xpass" ? " (fixed? remove the knownFinding mark)" : ""}`,
    );
  }
  if (result.reason) lines.push(`        reason:   ${result.reason}`);
  if (result.failure) {
    const failure = result.failure;
    lines.push(`        error:    ${failure.message}`);
    if (failure.expected !== undefined)
      lines.push(indent(`expected: ${failure.expected}`, "        "));
    if (failure.observed !== undefined)
      lines.push(indent(`observed: ${failure.observed}`, "        "));
    for (const detail of failure.details) lines.push(`        - ${detail}`);
    if (failure.request) {
      const request = failure.request;
      const status =
        request.status === 0 ? (request.error ?? "no response") : String(request.status);
      lines.push(
        `        request:  ${request.method} ${request.url} → ${status} (${request.agent}, x-request-id ${request.serverRequestId ?? request.requestId})`,
      );
      if (request.requestBody) lines.push(`        sent:     ${request.requestBody.slice(0, 300)}`);
      if (request.responseBody) {
        lines.push(
          `        received: ${request.responseBody.replaceAll("\n", "\\n").slice(0, 400)}`,
        );
      }
    }
  }
  if ((verbose || result.outcome !== "pass") && result.notes.length > 0) {
    for (const note of result.notes) lines.push(`        note:     ${note}`);
  } else if (result.notes.length > 0) {
    for (const note of result.notes.slice(0, 3)) lines.push(`        · ${note}`);
  }
  return lines.join("\n");
}

export function formatHeader(
  report: Pick<RunReport, "baseUrl" | "runId">,
  startedAt: Date,
): string {
  return `Webflix conformance suite → ${report.baseUrl}  (run ${report.runId}, ${startedAt.toISOString()})`;
}

export function formatSummary(report: RunReport, style: Style): string {
  const lines: string[] = [""];
  if (Object.keys(report.target).length > 0) {
    lines.push("Target");
    for (const [key, value] of Object.entries(report.target))
      lines.push(`  ${key.padEnd(14)} ${value}`);
    lines.push("");
  }
  lines.push("By area");
  for (const area of AREAS) {
    const results = report.results.filter((result) => result.area === area);
    if (results.length === 0) continue;
    const tally = (["pass", "fail", "skip", "xfail", "xpass"] as const)
      .map(
        (outcome) =>
          [outcome, results.filter((result) => result.outcome === outcome).length] as const,
      )
      .filter(([, count]) => count > 0)
      .map(([outcome, count]) => `${count} ${outcome}`)
      .join(", ");
    lines.push(`  ${area.padEnd(12)} ${tally}`);
  }
  const failed = report.results.filter((result) => result.outcome === "fail");
  if (failed.length > 0) {
    lines.push("", paint(style, COLORS.fail, "Failed"));
    for (const result of failed) lines.push(`  ${result.id}: ${result.failure?.message ?? ""}`);
  }
  const skipped = report.results.filter((result) => result.outcome === "skip");
  if (skipped.length > 0) {
    lines.push("", paint(style, COLORS.skip, "Skipped (not passed)"));
    for (const result of skipped) lines.push(`  ${result.id}: ${result.reason ?? ""}`);
  }
  const xfailed = report.results.filter((result) => result.outcome === "xfail");
  if (xfailed.length > 0) {
    lines.push("", paint(style, COLORS.xfail, "Known findings (failing as expected, not passed)"));
    for (const result of xfailed) {
      lines.push(
        `  ${result.id}: ${result.finding ? `${result.finding.id} (${result.finding.owner}): ` : ""}${result.failure?.message ?? ""}`,
      );
    }
  }
  const xpassed = report.results.filter((result) => result.outcome === "xpass");
  if (xpassed.length > 0) {
    lines.push(
      "",
      "Expected to fail but passed (remove from --expect-fail, or the check's knownFinding mark):",
    );
    for (const result of xpassed) {
      lines.push(`  ${result.id}${result.finding ? ` (${result.finding.id})` : ""}`);
    }
  }
  const { counts } = report;
  lines.push(
    "",
    `${counts.total} checks: ${paint(style, COLORS.pass, `${counts.pass} passed`)}, ${paint(style, counts.fail > 0 ? COLORS.fail : "0", `${counts.fail} failed`)}, ${paint(style, counts.skip > 0 ? COLORS.skip : "0", `${counts.skip} skipped`)}${counts.xfail > 0 ? `, ${counts.xfail} expected failures` : ""}${counts.xpass > 0 ? `, ${counts.xpass} unexpectedly passed` : ""} in ${seconds(report.durationMs)}`,
    report.ok
      ? paint(style, COLORS.pass, "RESULT: OK")
      : paint(style, COLORS.fail, "RESULT: FAILED"),
  );
  return lines.join("\n");
}

export function formatCatalogue(checks: readonly CheckDefinition[]): string {
  const lines: string[] = [];
  for (const area of AREAS) {
    const inArea = checks.filter((definition) => definition.area === area);
    if (inArea.length === 0) continue;
    lines.push(`${area} (${inArea.length})`);
    for (const definition of inArea) {
      const tags =
        definition.tags && definition.tags.length > 0 ? `  [${definition.tags.join(", ")}]` : "";
      const needs =
        definition.needs && definition.needs.length > 0
          ? `  needs: ${definition.needs.map((requirement) => requirement.id).join(", ")}`
          : "";
      const finding = definition.knownFinding ? `  finding: ${definition.knownFinding.id}` : "";
      lines.push(`  ${definition.id.padEnd(46)} ${definition.title}${tags}${needs}${finding}`);
    }
  }
  lines.push("", `${checks.length} checks`);
  return lines.join("\n");
}
