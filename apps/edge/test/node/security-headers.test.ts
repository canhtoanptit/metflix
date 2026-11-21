/**
 * The SPA is served with one security policy in both deployment modes. The Kubernetes side is
 * rendered by Helm itself (`helm template`, the real chart), the Cloudflare side is the
 * `_headers` file the asset staging writes; they must be identical, with and without TLS.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headersFile } from "../../scripts/lib/assets.ts";
import { type HeaderList, renderChartHeaders } from "../../scripts/lib/security-headers.ts";

const CHART = join(import.meta.dirname, "..", "..", "..", "..", "deploy", "helm", "webflix");

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `add_header Name "value" always;` lines of the rendered nginx include. */
function renderKubernetes(tls: boolean): HeaderList {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "webflix",
      CHART,
      "--show-only",
      "templates/web/configmap.yaml",
      "--set",
      `gateway.tls.enabled=${tls}`,
      // The chart's switch for throwaway renders (no cluster to keep generated secrets in).
      "--set",
      "secrets.generateWithoutCluster=true",
    ],
    { encoding: "utf8" },
  );
  return [...rendered.matchAll(/add_header\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s+always;/g)].map(
    (match): [string, string] => [match[1] ?? "", (match[2] ?? "").replaceAll('\\"', '"')],
  );
}

/** The `/*` block of a `_headers` file. */
function renderCloudflare(file: string): HeaderList {
  const block = file.split("\n/*\n")[1]?.split("\n\n")[0] ?? "";
  return block
    .split("\n")
    .map((line) => /^\s+([^:]+):\s(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match): [string, string] => [match[1] ?? "", match[2] ?? ""]);
}

const sorted = (list: HeaderList) =>
  [...list].map(([name, value]) => [name.toLowerCase(), value]).sort();

describe("SPA security headers: Kubernetes (Helm) and Cloudflare (_headers) agree", () => {
  it.runIf(helmAvailable())("over https (production, TLS on the gateway)", async () => {
    const kubernetes = renderKubernetes(true);
    expect(kubernetes.map(([name]) => name)).toContain("Strict-Transport-Security");
    expect(sorted(renderCloudflare(await headersFile("production")))).toEqual(sorted(kubernetes));
  });

  it.runIf(helmAvailable())("over plain http (local)", async () => {
    const kubernetes = renderKubernetes(false);
    expect(kubernetes.map(([name]) => name)).toContain("Content-Security-Policy");
    expect(kubernetes.map(([name]) => name)).not.toContain("Strict-Transport-Security");
    expect(sorted(renderCloudflare(await headersFile("local")))).toEqual(sorted(kubernetes));
  });

  it("refuses chart constructs it cannot evaluate instead of dropping a header", () => {
    const values = "web:\n  contentSecurityPolicy: default-src 'self'\n";
    expect(() =>
      renderChartHeaders(values, "add_header X-New {{ .Values.web.other | quote }} always;", {
        https: false,
      }),
    ).toThrow(/cannot evaluate/);
    expect(() =>
      renderChartHeaders(values, '{{- if .Values.web.extra }}\nadd_header A "b" always;', {
        https: false,
      }),
    ).toThrow(/unsupported template construct/);
    expect(() => renderChartHeaders("web: {}\n", "", { https: false })).toThrow(/missing/);
  });
});
