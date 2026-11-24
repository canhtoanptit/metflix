/**
 * The SPA is served with one security policy in both deployment modes. The Kubernetes side is
 * rendered by Helm itself (`helm template`, the real chart), the Cloudflare side is the
 * `_headers` file the asset staging writes; they must be identical, with and without TLS.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configuredPaymentProvider, headersFile } from "../../scripts/lib/assets.ts";
import {
  addCspSources,
  type HeaderList,
  renderChartHeaders,
  STRIPE_CSP_SOURCES,
  withPaymentProvider,
} from "../../scripts/lib/security-headers.ts";
import { consoleContentSecurityPolicy } from "../../src/console-policy.ts";

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

/** The staff console's policy as the chart renders it (templates/web/admin.yaml). */
function renderKubernetesConsolePolicy(sets: string[]): string {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "webflix",
      CHART,
      "--show-only",
      "templates/web/admin.yaml",
      "--set",
      "secrets.generateWithoutCluster=true",
      ...sets.flatMap((set) => ["--set", set]),
    ],
    { encoding: "utf8" },
  );
  const match = /add_header Content-Security-Policy "((?:[^"\\]|\\.)*)" always;/.exec(rendered);
  return (match?.[1] ?? "").replaceAll('\\"', '"');
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
    // Production runs Stripe: the chart's policy plus exactly Stripe.js's sources.
    expect(configuredPaymentProvider("production")).toBe("stripe");
    expect(sorted(renderCloudflare(await headersFile("production")))).toEqual(
      sorted(withPaymentProvider(kubernetes, "stripe")),
    );
    expect(sorted(renderCloudflare(await headersFile("production", "fake")))).toEqual(
      sorted(kubernetes),
    );
  });

  it.runIf(helmAvailable())("over plain http (local)", async () => {
    const kubernetes = renderKubernetes(false);
    expect(kubernetes.map(([name]) => name)).toContain("Content-Security-Policy");
    expect(kubernetes.map(([name]) => name)).not.toContain("Strict-Transport-Security");
    expect(sorted(renderCloudflare(await headersFile("local")))).toEqual(sorted(kubernetes));
  });

  it("allows Stripe's origins only when Stripe is the provider", async () => {
    const csp = (file: string) =>
      renderCloudflare(file).find(([name]) => name === "Content-Security-Policy")?.[1] ?? "";
    expect(configuredPaymentProvider("local")).toBe("fake");
    expect(csp(await headersFile("local"))).not.toMatch(/stripe/);
    expect(csp(await headersFile("production", "memory"))).not.toMatch(/stripe/);
    const stripe = csp(await headersFile("production"));
    for (const [directive, sources] of Object.entries(STRIPE_CSP_SOURCES)) {
      const values = new RegExp(`(?:^|; )${directive} ([^;]*)`).exec(stripe)?.[1]?.split(" ");
      for (const source of sources) expect(values, `${directive} ${source}`).toContain(source);
    }
    // Only Stripe's sources were added: nothing else became framable or scriptable.
    expect(stripe).toMatch(/(?:^|; )frame-src 'self' https:\/\/js\.stripe\.com/);
    expect(stripe).toMatch(/(?:^|; )script-src 'self' https:\/\/js\.stripe\.com /);
  });

  it("gives the staff console its own policy: this origin and its staff issuer, nothing else", async () => {
    const block = (file: string, rule: string) =>
      file
        .split(`\n${rule}\n`)[1]
        ?.split("\n\n")[0]
        ?.split("\n")
        .map((line) => line.trim()) ?? [];
    // After the member app's `/*` rule, which a detach can only undo when it comes first.
    const local = await headersFile("local");
    expect(local.indexOf("\n/admin/*\n")).toBeGreaterThan(local.indexOf("\n/*\n"));
    const console_ = block(local, "/admin/*");
    expect(console_[0]).toBe("! Content-Security-Policy");
    expect(console_[1]).toContain("connect-src 'self';");
    // Production runs Stripe for the member app; none of it reaches the console.
    const production = block(
      await headersFile("production", "stripe", "https://sso.example.com/realms/webflix"),
      "/admin/*",
    );
    expect(production[1]).toContain("connect-src 'self' https://sso.example.com;");
    expect(production.join(" ")).not.toMatch(/stripe|googleapis|https:;|https: /);
  });

  it.runIf(helmAvailable())(
    "gives the staff console the same policy on Kubernetes as on Cloudflare, whatever its issuer",
    () => {
      // Outside production: the development issuer, a path on this origin.
      expect(renderKubernetesConsolePolicy(["config.environment=development"])).toBe(
        consoleContentSecurityPolicy("/dev-idp/staff"),
      );
      // Production without a staff issuer: the console signs nobody in and connects nowhere else.
      expect(renderKubernetesConsolePolicy([])).toBe(consoleContentSecurityPolicy(null));
      // A staff issuer on another origin: that origin, nothing more.
      const sso = "https://sso.example.com/realms/webflix";
      expect(renderKubernetesConsolePolicy([`config.staff.issuer=${sso}`])).toBe(
        consoleContentSecurityPolicy(sso),
      );
      // The chart's own Keycloak.
      expect(renderKubernetesConsolePolicy(["keycloak.enabled=true"])).toBe(
        consoleContentSecurityPolicy("https://webflix-keycloak:8443/realms/webflix"),
      );
    },
  );

  it("starts a missing directive from default-src and never duplicates a source", () => {
    expect(
      addCspSources("default-src 'self'; img-src 'self' data:", {
        "frame-src": ["https://a.example"],
        "img-src": ["data:", "https://b.example"],
      }),
    ).toBe(
      "default-src 'self'; img-src 'self' data: https://b.example; frame-src 'self' https://a.example",
    );
    expect(addCspSources("default-src 'none'", { "frame-src": ["https://a.example"] })).toBe(
      "default-src 'none'; frame-src https://a.example",
    );
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
