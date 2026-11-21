/**
 * The SPA's security headers, from the same source the Kubernetes mode uses: the CSP in
 * `deploy/helm/webflix/values.yaml` (`web.contentSecurityPolicy`) and the `add_header` lines
 * of `deploy/helm/webflix/templates/web/configmap.yaml` (nginx). Both modes therefore serve
 * one policy; `test/node/security-headers.test.ts` renders the chart with `helm template` and
 * fails if they ever differ.
 *
 * The template is read, not re-implemented: every `add_header` line must be a literal or the
 * CSP value, and the only condition understood is the TLS block (HSTS). Anything else makes
 * this throw, so a chart change cannot silently drop a header from the Cloudflare mode.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const CHART = join(import.meta.dirname, "..", "..", "..", "..", "deploy", "helm", "webflix");
export const CHART_VALUES = join(CHART, "values.yaml");
export const CHART_WEB_HEADERS = join(CHART, "templates", "web", "configmap.yaml");

export type HeaderList = [name: string, value: string][];

/** Helm's `replace "\n" " " | trim` on the CSP value. */
function normalise(value: string): string {
  return value.replaceAll("\n", " ").trim();
}

export function renderChartHeaders(
  valuesText: string,
  templateText: string,
  options: { https: boolean },
): HeaderList {
  const values = parse(valuesText) as { web?: { contentSecurityPolicy?: unknown } };
  const csp = values.web?.contentSecurityPolicy;
  if (typeof csp !== "string" || csp.trim() === "") {
    throw new Error(`${CHART_VALUES}: web.contentSecurityPolicy is missing`);
  }
  const headers: HeaderList = [];
  let condition: "tls" | null = null;
  for (const raw of templateText.split("\n")) {
    const line = raw.trim();
    if (/^\{\{-?\s*if\s+\.Values\.gateway\.tls\.enabled\s*-?\}\}$/.test(line)) {
      condition = "tls";
      continue;
    }
    if (/^\{\{-?\s*end\s*-?\}\}$/.test(line) && condition) {
      condition = null;
      continue;
    }
    if (/^\{\{-?\s*(if|else|range|with)\b/.test(line)) {
      throw new Error(`${CHART_WEB_HEADERS}: unsupported template construct: ${line}`);
    }
    const header = /^add_header\s+(\S+)\s+(.+?)\s+always;$/.exec(line);
    if (!header) continue;
    const [, name = "", expression = ""] = header;
    let value: string;
    const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(expression);
    if (literal) value = (literal[1] ?? "").replaceAll('\\"', '"');
    else if (/^\{\{\s*\.Values\.web\.contentSecurityPolicy\b[^}]*\}\}$/.test(expression)) {
      value = normalise(csp);
    } else {
      throw new Error(`${CHART_WEB_HEADERS}: cannot evaluate the value of ${name}: ${expression}`);
    }
    if (condition === "tls" && !options.https) continue;
    headers.push([name, value]);
  }
  if (!headers.some(([name]) => name.toLowerCase() === "content-security-policy")) {
    throw new Error(`${CHART_WEB_HEADERS}: no Content-Security-Policy header found`);
  }
  return headers;
}

/** The SPA headers for one environment (`https`: production; HSTS only then). */
export async function chartSpaHeaders(options: { https: boolean }): Promise<HeaderList> {
  const [valuesText, templateText] = await Promise.all([
    readFile(CHART_VALUES, "utf8"),
    readFile(CHART_WEB_HEADERS, "utf8"),
  ]);
  return renderChartHeaders(valuesText, templateText, options);
}
