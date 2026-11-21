// An operator hot-patches a release object (kubectl set image), then the release is deployed
// again. Helm 4 applies server-side, so the patched field now has a second manager and the
// API server refuses an apply that changes it. Checks every K8S_OWNERSHIP mode of up.sh:
//   strict  stops before upgrading, naming the object, manager and field, and how to resolve
//   off     plain Helm: the upgrade fails, and the message still names them and the remedy
//   take    (the default) gives the field back to the release, saying so; the next deploys work
// This is the one script that changes a release object out of band, on purpose, and it ends by
// handing the field back to the release.
//
//   node deploy/kind/verify/drift.ts       (make k8s-test-drift; reuses the built images)
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { check, finish, kubectl, RELEASE, release, section } from "./lib.ts";

const deployment = `deployment/${RELEASE}-api`;
const FIELD = '.spec.template.spec.containers[name="api"].image';

function upSh(ownership: string): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(resolve(import.meta.dirname, "../up.sh"), [], {
      env: {
        ...process.env,
        K8S_OWNERSHIP: ownership,
        SKIP_BUILD: "1",
        SKIP_MEDIA: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => done({ code: code ?? 1, output }));
  });
}
const image = () =>
  kubectl([
    "get",
    deployment,
    "-o",
    'jsonpath={.spec.template.spec.containers[?(@.name=="api")].image}',
  ]).trim();
const managers = () =>
  JSON.parse(
    kubectl(["get", deployment, "-o", "json", "--show-managed-fields"]),
  ).metadata.managedFields.map((entry: { manager: string }) => entry.manager) as string[];
const status = () =>
  JSON.parse(kubectl(["get", "secret", "-l", `owner=helm,name=${RELEASE}`, "-o", "json"]));
const latest = () => {
  const items = status().items as { metadata: { labels: Record<string, string> } }[];
  const newest = items
    .map((item) => item.metadata.labels)
    .sort((a, b) => Number(b.version) - Number(a.version))[0];
  return { revision: newest?.version ?? "", state: newest?.status ?? "" };
};

/** What up.sh said about ownership, as an operator reads it. */
const show = (output: string) => {
  const lines = output.split("\n");
  const from = lines.findIndex((line) => /taking back|✗|Fields changed outside/.test(line));
  if (from < 0) return;
  for (const line of lines.slice(from, from + 8)) {
    if (
      /taking back|✗|Fields changed|kubectl-set|Resolve|or undo|Everything the release/.test(line)
    ) {
      console.log(`    | ${line.trim()}`);
    }
  }
};

const deployed = image();
const before = await release(["revision"]);
section(`Hot-patch: kubectl set image on ${deployment} (same image, another spelling)`);
const patched = `docker.io/library/${deployed}`;
kubectl(["set", "image", deployment, `api=${patched}`]);
kubectl(["rollout", "status", deployment, "--timeout=300s"]);
check(managers().includes("kubectl-set"), `${FIELD} is now also owned by "kubectl-set"`);

section("K8S_OWNERSHIP=strict: refuse before upgrading");
const strict = await upSh("strict");
show(strict.output);
check(strict.code !== 0, "up.sh stopped");
check(
  strict.output.includes("kubectl-set") && strict.output.includes(FIELD),
  "it names the manager and the field",
  strict.output.split("\n").filter((line) => line.includes("kubectl-set")),
);
check(strict.output.includes("make k8s-redeploy"), "it names the command that resolves it");
const afterStrict = latest();
check(
  afterStrict.revision === before && afterStrict.state === "deployed",
  `the release was not touched (revision ${afterStrict.revision}, ${afterStrict.state})`,
);

section("K8S_OWNERSHIP=off: plain Helm fails, the message still says what to do");
const off = await upSh("off");
show(off.output);
const afterOff = latest();
check(off.code !== 0, `the upgrade failed (revision ${afterOff.revision}: ${afterOff.state})`);
check(
  off.output.includes("kubectl-set") &&
    off.output.includes(FIELD) &&
    off.output.includes("make k8s-redeploy"),
  "the failure names the manager, the field and the command that resolves it",
  off.output.split("\n").filter((line) => line.includes("kubectl-set")),
);

section("Default (take): the release takes the field back and says so");
const take = await upSh("take");
show(take.output);
const afterTake = latest();
check(take.code === 0, `up.sh succeeded (revision ${afterTake.revision}: ${afterTake.state})`);
check(
  /taking back .*image.* from manager "kubectl-set"/.test(take.output),
  "it logged the field it took back and from which manager",
  take.output.split("\n").filter((line) => line.includes("taking back")),
);
check(image() === deployed, `the image is the release's again (${image()})`);
check(!managers().includes("kubectl-set"), '"kubectl-set" no longer owns anything');

section("The next deploy is an ordinary one");
const again = await upSh("strict");
check(
  again.code === 0 && !again.output.includes("taking back"),
  "a strict redeploy finds nothing to take back",
);
finish();
