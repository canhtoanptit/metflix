// Who owns what in the release: every object of `helm get manifest`, every field manager other
// than Helm's, the fields it owns, and whether that is expected. Helm 4 applies the release
// server-side as manager "helm"; a field another manager owns and the chart also sets is a
// conflict waiting for the next upgrade that changes it (make k8s-redeploy takes such fields
// back and names them; K8S_OWNERSHIP=strict stops instead).
//
//   node deploy/kind/verify/ownership.ts          report; exits 1 on unexpected ownership

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CONTEXT, KUBECONFIG, kubectl, NAMESPACE, RELEASE } from "./lib.ts";

interface ManagedFieldsEntry {
  manager: string;
  operation: string;
  subresource?: string;
  fieldsV1?: Record<string, unknown>;
}
export interface Ownership {
  object: string;
  manager: string;
  operation: string;
  fields: string[];
  /** Why this ownership is fine, or null when it should not be there. */
  expected: string | null;
}

/** `{"f:spec":{"f:template":{...}}}` → [".spec.template..."] (leaves only). */
function flatten(node: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (key === ".") continue;
    const segment = key.startsWith("f:")
      ? `.${key.slice(2)}`
      : key.startsWith("k:")
        ? `[${Object.entries(JSON.parse(key.slice(2)) as Record<string, unknown>)
            .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
            .join(",")}]`
        : key.startsWith("v:")
          ? `[${key.slice(2)}]`
          : `.${key}`;
    const nested = child && typeof child === "object" ? (child as Record<string, unknown>) : {};
    const children = Object.keys(nested).filter((name) => name !== ".");
    if (children.length === 0) out.push(prefix + segment);
    else out.push(...flatten(nested, prefix + segment));
  }
  return out;
}

const HPA_TARGETS = () =>
  new Set(
    kubectl(["get", "hpa", "-o", "jsonpath={range .items[*]}{.spec.scaleTargetRef.name} {end}"])
      .trim()
      .split(" ")
      .filter(Boolean),
  );

function classify(
  kind: string,
  name: string,
  entry: ManagedFieldsEntry,
  fields: string[],
  scaled: Set<string>,
): string | null {
  if (entry.subresource === "status") return "status, written by its controller";
  if (
    entry.manager === "kube-controller-manager" &&
    fields.every((field) => field === ".metadata.annotations.deployment.kubernetes.io/revision")
  ) {
    return "the Deployment controller's revision annotation";
  }
  if (
    entry.subresource === "scale" &&
    entry.manager === "kube-controller-manager" &&
    scaled.has(name) &&
    fields.every((field) => field === ".spec.replicas")
  ) {
    return "replicas, set by its HorizontalPodAutoscaler (the chart omits replicas when autoscaling)";
  }
  if (
    entry.manager === "kubectl-rollout" &&
    fields.every(
      (field) => field === ".spec.template.metadata.annotations.kubectl.kubernetes.io/restartedAt",
    )
  ) {
    return "an operator's `kubectl rollout restart` (make k8s-restart): the chart never sets this annotation, so it cannot conflict";
  }
  if (
    kind === "Secret" &&
    entry.manager === "webflix-rotate-media-key" &&
    fields.every((field) => field === ".data.WEBFLIX_MEDIA_TOKEN_KEYS")
  ) {
    return "media key rotation (make k8s-rotate-media-key): the chart re-renders the live value (lookup), so both own the same value and never conflict";
  }
  return null;
}

export function releaseOwnership(): Ownership[] {
  const manifest = execFileSync(
    "helm",
    [
      "--kubeconfig",
      KUBECONFIG,
      "--kube-context",
      CONTEXT,
      "-n",
      NAMESPACE,
      "get",
      "manifest",
      RELEASE,
    ],
    { encoding: "utf8" },
  );
  const objects = manifest
    .split(/^---$/m)
    .map((doc) => ({
      kind: /^kind:\s*(\S+)/m.exec(doc)?.[1],
      name: /^metadata:\n(?:\s+.*\n)*?\s+name:\s*(\S+)/m.exec(doc)?.[1]?.replace(/^"|"$/g, ""),
    }))
    .filter((object): object is { kind: string; name: string } =>
      Boolean(object.kind && object.name && object.kind !== "Job"),
    );
  const scaled = HPA_TARGETS();
  const result: Ownership[] = [];
  for (const { kind, name } of objects) {
    let live: { metadata?: { managedFields?: ManagedFieldsEntry[] } };
    try {
      live = JSON.parse(kubectl(["get", kind, name, "-o", "json", "--show-managed-fields"]));
    } catch {
      continue; // not present (e.g. a CRD-backed object whose controller is absent)
    }
    for (const entry of live.metadata?.managedFields ?? []) {
      if (entry.manager === "helm" && entry.operation === "Apply") continue;
      const fields = flatten(entry.fieldsV1 ?? {});
      result.push({
        object: `${kind}/${name}`,
        manager: entry.manager,
        operation: `${entry.operation}${entry.subresource ? ` (${entry.subresource})` : ""}`,
        fields,
        expected: classify(kind, name, entry, fields, scaled),
      });
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ownership = releaseOwnership();
  const unexpected = ownership.filter((entry) => entry.expected === null);
  for (const entry of ownership) {
    const verdict = entry.expected ? `expected: ${entry.expected}` : "NOT EXPECTED";
    console.log(`${entry.object}  ${entry.manager} ${entry.operation}  ${verdict}`);
    for (const field of entry.fields.slice(0, 6)) console.log(`    ${field}`);
    if (entry.fields.length > 6) console.log(`    … ${entry.fields.length - 6} more`);
  }
  console.log(
    unexpected.length === 0
      ? `\nEvery field of the release is Helm's, or owned by a manager for an expected reason (${ownership.length} other entries).`
      : `\n${unexpected.length} unexpected owner(s): make k8s-redeploy gives conflicting fields back to the release.`,
  );
  process.exit(unexpected.length === 0 ? 0 : 1);
}
