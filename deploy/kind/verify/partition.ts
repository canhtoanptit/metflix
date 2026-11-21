// PostgreSQL disappears without closing its connections (a node failure or a network
// partition, as opposed to a pod deletion, where the server says goodbye). Every packet to and
// from the PostgreSQL pod's IP is dropped on its node (iptables in the `webflix-*` node
// container; no release object is touched), so pooled connections get no FIN, no RST, no ACK.
//
//   node deploy/kind/verify/partition.ts heal [seconds]   drop for N s (default 60), then lift
//   node deploy/kind/verify/partition.ts lost [seconds]   drop the old IP for good and replace the
//                                                         pod (new IP, as after a failover);
//                                                         observe up to N s (default 1200)
//
// Requests go through the gateway (whose /api route times out at 60 s) and, to see how long
// the API itself waits, straight to one API pod through a port-forward on 127.0.0.1:4505.
// PARTITION_LOAD (default 16) clients keep the pools busy meanwhile. Afterwards the script
// waits for every request still in flight (up to SETTLE_SEC, default 1200) to measure the
// longest wait.
import { execFileSync, spawn } from "node:child_process";
import {
  BASE_URL,
  CONTEXT,
  KUBECONFIG,
  kubectl,
  NAMESPACE,
  newAccount,
  processRestarts,
  RELEASE,
  restartedSince,
  section,
  sleep,
} from "./lib.ts";

const mode = process.argv[2] === "lost" ? "lost" : "heal";
const seconds = Number(process.argv[3] ?? (mode === "heal" ? "60" : "1200"));
const DIRECT_PORT = 4505;
const pgPod = `${RELEASE}-postgresql-0`;
const podInfo = () =>
  kubectl(["get", "pod", pgPod, "-o", "jsonpath={.spec.nodeName} {.status.podIP}"])
    .trim()
    .split(" ");
const [node = "", ip = ""] = podInfo();
if (!node.startsWith("webflix")) throw new Error(`Refusing to touch node container ${node}`);

// Pooled connections stuck on a query nobody will answer: ESTABLISHED sockets of the API and
// worker pods to PostgreSQL's Service address with unacknowledged data (/proc/net/tcp).
const serviceIp = kubectl([
  "get",
  "svc",
  `${RELEASE}-postgresql`,
  "-o",
  "jsonpath={.spec.clusterIP}",
]).trim();
const remoteHex = `${serviceIp
  .split(".")
  .map((octet) => Number(octet).toString(16).padStart(2, "0"))
  .reverse()
  .join("")
  .toUpperCase()}:1538`;
function stuckConnections(): number {
  let total = 0;
  const pods = kubectl([
    "get",
    "pods",
    "-l",
    "app.kubernetes.io/component in (api,worker)",
    "--field-selector=status.phase=Running",
    "-o",
    "jsonpath={.items[*].metadata.name}",
  ])
    .trim()
    .split(" ")
    .filter(Boolean);
  for (const name of pods) {
    try {
      const table = kubectl([
        "exec",
        name,
        "-c",
        name.includes("-worker-") ? "worker" : "api",
        "--",
        "cat",
        "/proc/net/tcp",
      ]);
      for (const line of table.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        const txQueue = Number.parseInt(fields[4]?.split(":")[0] ?? "0", 16);
        if (fields[2] === remoteHex && fields[3] === "01" && txQueue > 0) total += 1;
      }
    } catch {}
  }
  return total;
}

const COMMENT = "webflix-partition";
const rules = [
  ["-d", ip],
  ["-s", ip],
];
let dropping = false;
const iptables = (action: "-I" | "-D", match: string[]) =>
  execFileSync("docker", [
    "exec",
    node,
    "iptables",
    action,
    "FORWARD",
    ...(action === "-I" ? ["1"] : []),
    ...match,
    "-m",
    "comment",
    "--comment",
    COMMENT,
    "-j",
    "DROP",
  ]);
const lift = () => {
  if (!dropping) return;
  for (const rule of rules) iptables("-D", rule);
  dropping = false;
};

// A port-forward to one API pod (not on the PostgreSQL node when possible): the API's own wait,
// without the gateway's route timeout.
const apiPods = kubectl([
  "get",
  "pods",
  "-l",
  "app.kubernetes.io/component=api",
  "-o",
  "jsonpath={range .items[*]}{.metadata.name}={.spec.nodeName} {end}",
])
  .trim()
  .split(" ")
  .map((entry) => entry.split("="));
const direct = (apiPods.find(([, host]) => host !== node) ?? apiPods[0] ?? [""])[0] ?? "";
const forward = spawn(
  "kubectl",
  [
    "--kubeconfig",
    KUBECONFIG,
    "--context",
    CONTEXT,
    "-n",
    NAMESPACE,
    "port-forward",
    `pod/${direct}`,
    `${DIRECT_PORT}:4000`,
  ],
  { stdio: "ignore" },
);
const cleanup = () => {
  lift();
  forward.kill();
};
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}
await sleep(1500);

const viewer = await newAccount("premium");
const cookie = viewer.device.cookie;
interface Sample {
  probe: string;
  at: number;
  ms: number;
  status: number;
}
const samples: Sample[] = [];
const t0 = Date.now();
const timed = async (probe: string, run: () => Promise<Response>) => {
  const at = Date.now() - t0;
  let status = 0;
  try {
    const response = await run();
    await response.arrayBuffer();
    status = response.status;
  } catch {
    status = 0;
  }
  samples.push({ probe, at, ms: Date.now() - t0 - at, status });
};
const browse = (base: string) => () =>
  fetch(`${base}/api/v1/browse?view=home`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(900_000),
  });
let probing = true;
const inFlight = new Set<Promise<void>>();
const track = (request: Promise<void>) => {
  inFlight.add(request);
  void request.finally(() => inFlight.delete(request));
  return request;
};
const load = Array.from({ length: Number(process.env.PARTITION_LOAD ?? "16") }, async () => {
  while (probing) await track(timed("load", browse(BASE_URL)));
});
// One request per probe per second, whether or not the previous ones came back.
const ticker = (async () => {
  while (probing) {
    for (const [name, run] of [
      ["gateway", browse(BASE_URL)],
      ["direct", browse(`http://127.0.0.1:${DIRECT_PORT}`)],
      ["plans", () => fetch(`${BASE_URL}/api/v1/plans`)],
    ] as const) {
      void track(timed(name, run));
    }
    await sleep(1000);
  }
})();

const restartsBefore = processRestarts();
section(
  `PostgreSQL ${ip} on ${node}: ${mode === "heal" ? `partitioned for ${seconds} s` : "lost, replaced by a new pod"}`,
);
await sleep(5000);
const cutAt = Date.now() - t0;
for (const rule of rules) iptables("-I", rule);
dropping = true;
const stuck: { at: number; count: number }[] = [];
let polling = true;
const poller = (async () => {
  await sleep(3000);
  while (polling) {
    stuck.push({ at: Date.now() - t0, count: stuckConnections() });
    await sleep(5000);
  }
})();
let healAt = 0;
if (mode === "heal") {
  await sleep(seconds * 1000);
  lift();
  healAt = Date.now() - t0;
} else {
  await sleep(5000);
  kubectl(["delete", "pod", pgPod, "--wait=false"]);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(1000);
    const [, newIp = ""] = podInfo();
    if (newIp && newIp !== ip) {
      try {
        kubectl(["wait", "--for=condition=Ready", `pod/${pgPod}`, "--timeout=5s"]);
        healAt = Date.now() - t0;
        console.log(`  new pod Ready at ${newIp} after ${((healAt - cutAt) / 1000).toFixed(1)} s`);
        break;
      } catch {}
    }
  }
}
// Recovered: 10 s of gateway and direct browse requests all 200, started after healAt.
const deadline = Date.now() + (mode === "heal" ? 300_000 : seconds * 1000);
let recoveredAt = 0;
while (Date.now() < deadline) {
  const recent = samples.filter(
    (s) => s.probe !== "plans" && s.at > healAt && s.at > Date.now() - t0 - 12_000,
  );
  if (recent.length >= 16 && recent.every((s) => s.status === 200)) {
    recoveredAt = Math.min(...recent.map((s) => s.at));
    break;
  }
  await sleep(1000);
}
probing = false;
await ticker;
const stoppedAt = Date.now() - t0;
// Everything still in flight is stuck on a connection the partition took: wait for it.
const settleBy = Date.now() + Number(process.env.SETTLE_SEC ?? "1200") * 1000;
while ((inFlight.size > 0 || (stuck.at(-1)?.count ?? 0) > 0) && Date.now() < settleBy)
  await sleep(1000);
polling = false;
await poller;
const hanging = inFlight.size;
const settledAt = Date.now() - t0;
await Promise.race([Promise.all(load), sleep(1000)]);
lift();
forward.kill();

const fmt = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
console.log(
  `  cut at ${fmt(cutAt)}; ${mode === "heal" ? "lifted" : "replacement Ready"} at ${fmt(healAt)}`,
);
for (const probe of ["gateway", "direct", "plans", "load"]) {
  const during = samples.filter(
    (s) => s.probe === probe && s.at >= cutAt && (recoveredAt === 0 || s.at < recoveredAt),
  );
  const byStatus = new Map<number, number[]>();
  for (const s of during) byStatus.set(s.status, [...(byStatus.get(s.status) ?? []), s.ms]);
  const summary = [...byStatus]
    .map(
      ([status, list]) =>
        `${list.length} × ${status || "no answer"} (max ${fmt(Math.max(...list))})`,
    )
    .join(", ");
  console.log(`  ${probe.padEnd(8)} from the cut to recovery: ${summary || "nothing"}`);
}
console.log(
  recoveredAt
    ? `  recovered (10 s of 200s) from ${fmt(recoveredAt)}: ${fmt(recoveredAt - healAt)} after the ${mode === "heal" ? "partition was lifted" : "replacement was Ready"}`
    : `  NOT recovered ${fmt(Date.now() - t0 - healAt)} after the ${mode === "heal" ? "partition was lifted" : "replacement was Ready"}`,
);
const longest = [...samples].sort((a, b) => b.ms - a.ms).slice(0, 5);
console.log(
  `  longest waits: ${longest.map((s) => `${s.probe} ${fmt(s.ms)} → ${s.status || "no answer"} (sent at ${fmt(s.at)})`).join("; ")}`,
);
console.log(
  `  stopped sending at ${fmt(stoppedAt)}; ${hanging ? `${hanging} request(s) still unanswered at ${fmt(settledAt)}` : `every request answered by ${fmt(settledAt)}`}`,
);
const peak = Math.max(0, ...stuck.map((sample) => sample.count));
const lastStuck = [...stuck].reverse().find((sample) => sample.count > 0);
const cleared = lastStuck
  ? stuck.find((sample) => sample.at > lastStuck.at && sample.count === 0)
  : undefined;
console.log(
  `  pooled connections stuck on an unanswered query: at most ${peak}${lastStuck ? `, last seen ${fmt(lastStuck.at - cutAt)} after the cut${cleared ? `, gone by ${fmt(cleared.at - cutAt)}` : " (still there)"}` : ""}`,
);
const restarted = restartedSince(restartsBefore);
console.log(`  API or worker restarts: ${restarted.length ? restarted.join(", ") : "none"}`);
process.exit(0);
