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

/**
 * What Stripe.js needs from the page's Content-Security-Policy (docs.stripe.com/security/guide,
 * "Stripe.js", read 2026-11-22; docs/STRIPE.md §15): its script, its frames (3-D Secure
 * challenges on hooks.stripe.com) and its API. Added only when Stripe is the configured
 * provider (docs/BLUEPRINT-M2.md §5.5); with the fake provider card data goes to `/_pay`, which
 * is same-origin. Link's hosts are not included: Link is not enabled.
 */
export const STRIPE_CSP_SOURCES: Readonly<Record<string, readonly string[]>> = {
  "script-src": ["https://js.stripe.com", "https://*.js.stripe.com", "https://maps.googleapis.com"],
  "frame-src": ["https://js.stripe.com", "https://*.js.stripe.com", "https://hooks.stripe.com"],
  "connect-src": ["https://api.stripe.com", "https://maps.googleapis.com"],
};

/**
 * `csp` with `sources` added per directive. A directive the policy lacks starts from
 * `default-src` (its fallback), so adding Stripe's frames never widens what else may be framed.
 */
export function addCspSources(
  csp: string,
  sources: Readonly<Record<string, readonly string[]>>,
): string {
  const directives = csp
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name = "", ...values] = part.split(/\s+/);
      return { name: name.toLowerCase(), values };
    });
  const fallback = directives.find((directive) => directive.name === "default-src")?.values ?? [];
  for (const [name, added] of Object.entries(sources)) {
    let directive = directives.find((candidate) => candidate.name === name);
    if (!directive) {
      directive = { name, values: fallback.filter((value) => value !== "'none'") };
      directives.push(directive);
    }
    for (const source of added)
      if (!directive.values.includes(source)) directive.values.push(source);
  }
  return directives.map((directive) => [directive.name, ...directive.values].join(" ")).join("; ");
}

/** The SPA headers with the configured payment provider's sources added to the CSP. */
export function withPaymentProvider(headers: HeaderList, provider: string | undefined): HeaderList {
  if (provider !== "stripe") return headers;
  return headers.map(([name, value]): [string, string] =>
    name.toLowerCase() === "content-security-policy"
      ? [name, addCspSources(value, STRIPE_CSP_SOURCES)]
      : [name, value],
  );
}
