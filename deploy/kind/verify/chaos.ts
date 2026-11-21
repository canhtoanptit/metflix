// Failure injection: take the Valkey or PostgreSQL pod down while probing the product through
// the gateway every 250 ms, and print the timeline of what users saw until full recovery.
// State that must survive (stream leases in Valkey's AOF, accounts in PostgreSQL) is checked.
// Meanwhile CHAOS_LOAD (default 16) clients keep every API pod busy with database- and
// Valkey-backed requests: a store going away mid-query must fail requests, never the process.
//
//   node deploy/kind/verify/chaos.ts valkey|postgresql [delete|crash]   (make k8s-chaos)
//     delete  kubectl delete pod: graceful stop, StatefulSet recreates it (new pod IP)
//     crash   SIGKILL the container on its node (crictl): no shutdown at all, restarted in place
import { execFileSync } from "node:child_process";
import {
  BASE_URL,
  check,
  finish,
  kubectl,
  login,
  newAccount,
  playableMovie,
  processRestarts,
  RELEASE,
  restartedSince,
  section,
  sleep,
} from "./lib.ts";

const target = process.argv[2] === "postgresql" ? "postgresql" : "valkey";
const mode = process.argv[3] === "crash" ? "crash" : "delete";
const pod = `${RELEASE}-${target}-0`;

const holder = await newAccount("basic");
const titleId = await playableMovie(holder.device);
const lease = await holder.device.request("POST", "/api/v1/playback/sessions", {
  body: { titleId },
});
check(lease.status === 201, "a Basic account holds its one stream slot");
const playbackId = (lease.json as { id: string }).id;
const second = await login("second", holder.email, holder.password, holder.profileId);

const restartsBefore = processRestarts();
const loadCodes = new Map<number, number>();
let unavailableWithoutRetryAfter = 0;
let loading = true;
const load = Array.from({ length: Number(process.env.CHAOS_LOAD ?? "16") }, async () => {
  while (loading) {
    try {
      const reply = await holder.device.request("GET", "/api/v1/browse?view=home");
      loadCodes.set(reply.status, (loadCodes.get(reply.status) ?? 0) + 1);
      if (reply.status === 503 && !reply.headers.get("Retry-After"))
        unavailableWithoutRetryAfter += 1;
    } catch {
      loadCodes.set(0, (loadCodes.get(0) ?? 0) + 1);
    }
  }
});

type Probe = { name: string; run: () => Promise<number> };
const status = async (promise: Promise<{ status: number }>) => (await promise).status;
const probes: Probe[] = [
  { name: "web", run: async () => (await fetch(`${BASE_URL}/`)).status },
  { name: "plans", run: async () => (await fetch(`${BASE_URL}/api/v1/plans`)).status },
  {
    name: "browse",
    run: () => status(holder.device.request("GET", "/api/v1/browse?view=home")),
  },
  {
    name: "heartbeat",
    run: () =>
      status(
        holder.device.request("POST", `/api/v1/playback/sessions/${playbackId}/heartbeat`, {
          body: { positionSec: 40, durationSec: 150, state: "playing" },
        }),
      ),
  },
];

interface Sample {
  at: number;
  results: Record<string, number>;
}
const samples: Sample[] = [];
let probing = true;
const t0 = Date.now();
const prober = (async () => {
  while (probing) {
    const startedAt = Date.now() - t0;
    const results: Record<string, number> = {};
    await Promise.all(
      probes.map(async (probe) => {
        try {
          results[probe.name] = await probe.run();
        } catch {
          results[probe.name] = 0;
        }
      }),
    );
    // Stamped when the round started: a hanging request counts from when the user waited.
    samples.push({ at: startedAt, results });
    await sleep(250);
  }
})();

section(
  mode === "crash"
    ? `Crashing ${pod}: SIGKILL to its container, no shutdown`
    : `Deleting ${pod}: graceful stop, recreated by its StatefulSet`,
);
await sleep(3000);
const killedAt = Date.now() - t0;
if (mode === "crash") {
  const node = kubectl(["get", "pod", pod, "-o", "jsonpath={.spec.nodeName}"]).trim();
  if (!node.startsWith("webflix")) throw new Error(`Refusing to touch node container ${node}`);
  const container = kubectl([
    "get",
    "pod",
    pod,
    "-o",
    `jsonpath={.status.containerStatuses[?(@.name=="${target === "valkey" ? "valkey" : "postgresql"}")].containerID}`,
  ])
    .trim()
    .replace(/^containerd:\/\//, "");
  execFileSync("docker", ["exec", node, "crictl", "stop", "--timeout", "0", container]);
} else {
  kubectl(["delete", "pod", pod, "--wait=false"]);
}
await sleep(3000);
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    kubectl(["wait", "--for=condition=Ready", `pod/${pod}`, "--timeout=5s"]);
    break;
  } catch {
    await sleep(1000);
  }
}
const readyAt = Date.now() - t0;
// Keep probing until every probe has been healthy for 5 s straight.
const healthy = (sample: Sample) =>
  Object.values(sample.results).every((code) => code > 0 && code < 400);
const recoveryDeadline = Date.now() + 90_000;
while (Date.now() < recoveryDeadline) {
  const recent = samples.slice(-20);
  if (recent.length === 20 && recent.every(healthy) && (recent[0]?.at ?? 0) > readyAt) break;
  await sleep(500);
}
probing = false;
loading = false;
await Promise.all([prober, ...load]);

// Timeline: one line per change of outcome.
console.log(
  `  t=0 probing; killed at ${(killedAt / 1000).toFixed(1)} s; pod Ready again at ${(readyAt / 1000).toFixed(1)} s`,
);
let previous = "";
for (const sample of samples) {
  const line = probes.map((probe) => `${probe.name} ${sample.results[probe.name]}`).join("  ");
  if (line !== previous) console.log(`    ${(sample.at / 1000).toFixed(1).padStart(6)} s  ${line}`);
  previous = line;
}
const afterKill = samples.filter((sample) => sample.at >= killedAt);
const failing = afterKill.filter((sample) => !healthy(sample));
const firstFailure = failing[0]?.at ?? killedAt;
const lastFailure = failing.at(-1)?.at ?? killedAt;
const recoveredAt = afterKill.find((sample) => sample.at > lastFailure && healthy(sample))?.at;
console.log(
  failing.length === 0
    ? "  no request failed"
    : `  degraded from ${((firstFailure - killedAt) / 1000).toFixed(1)} s to ${(((recoveredAt ?? lastFailure) - killedAt) / 1000).toFixed(1)} s after the kill (${failing.length} probe rounds with a failure)`,
);
const statuses = new Map<string, Set<number>>();
for (const sample of failing) {
  for (const [name, code] of Object.entries(sample.results)) {
    if (code === 0 || code >= 400) statuses.set(name, (statuses.get(name) ?? new Set()).add(code));
  }
}
for (const [name, codes] of statuses)
  console.log(`    ${name}: failures answered ${[...codes].join(", ")}`);
check(
  afterKill.slice(-10).every(healthy),
  "every probe healthy again (recovered without intervention)",
);
check(
  (statuses.get("web")?.size ?? 0) === 0,
  "the web app never failed (it depends on neither data store)",
);
console.log(
  `  background load: ${[...loadCodes].map(([code, count]) => `${count} × ${code}`).join(", ")}`,
);
const loadFailures = [...loadCodes].filter(([code]) => code !== 200 && code !== 503);
check(
  loadFailures.length === 0 && unavailableWithoutRetryAfter === 0,
  `the background load only ever failed with 503 + Retry-After${loadFailures.length || unavailableWithoutRetryAfter ? ` (other: ${loadFailures.map(([code, count]) => `${count} × ${code}`).join(", ")}; 503 without Retry-After: ${unavailableWithoutRetryAfter})` : ""}`,
);
const restarted = restartedSince(restartsBefore);
check(
  restarted.length === 0,
  `no API or worker process restarted${restarted.length ? ` (restarted: ${restarted.join(", ")})` : ""}`,
);

section("State after recovery");
const refused = await second.request("POST", "/api/v1/playback/sessions", { body: { titleId } });
check(
  refused.status === 409,
  target === "valkey"
    ? "the stream lease survived the Valkey restart (AOF): a second screen is still refused"
    : "stream limits still enforced",
  refused.status,
);
const relogin = await login("relogin", holder.email, holder.password, holder.profileId);
check(relogin.cookie !== "", "the account signs in again (data persisted)");
finish();
