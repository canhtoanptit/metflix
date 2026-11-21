// Zero-downtime rollouts: a steady mix of requests (app shell, hashed assets, public and
// authenticated API, signed media Range requests, heartbeats) runs through the gateway while
// the API and the web app roll out twice through the release (an upgrade, then its rollback);
// every request must succeed.
//
//   node deploy/kind/verify/rollout.ts [api,web] [concurrency]     (make k8s-verify)
import { BASE_URL, check, finish, newAccount, playableMovie, release, section } from "./lib.ts";

const targets = (process.argv[2] ?? "api,web").split(",");
const concurrency = Number(process.argv[3] ?? "16");

const account = await newAccount("premium");
const device = account.device;
const titleId = await playableMovie(device);
const start = (await device.request("POST", "/api/v1/playback/sessions", { body: { titleId } }))
  .json as { id: string; manifestUrl: string };
const masterUrl = new URL(start.manifestUrl, BASE_URL);
const master = await (await fetch(masterUrl)).text();
const variantUrl = new URL(
  master.split("\n").find((l) => l && !l.startsWith("#")) ?? "",
  masterUrl,
);
const variant = await (await fetch(variantUrl)).text();
const segmentUrl = new URL(
  variant.split("\n").find((l) => l && !l.startsWith("#")) ?? "",
  variantUrl,
);
const shell = await (await fetch(`${BASE_URL}/`)).text();
const asset = /src="(\/assets\/[^"]+\.js)"/.exec(shell)?.[1] ?? "/assets/missing.js";

type Probe = { name: string; run: () => Promise<Response> };
const auth = { headers: { Cookie: device.cookie } };
const probes: Probe[] = [
  { name: "web /", run: () => fetch(`${BASE_URL}/`) },
  { name: "web asset", run: () => fetch(`${BASE_URL}${asset}`) },
  { name: "api plans", run: () => fetch(`${BASE_URL}/api/v1/plans`) },
  { name: "api browse", run: () => fetch(`${BASE_URL}/api/v1/browse?view=home`, auth) },
  { name: "api title", run: () => fetch(`${BASE_URL}/api/v1/titles/${titleId}`, auth) },
  { name: "media playlist", run: () => fetch(variantUrl) },
  {
    name: "media range",
    run: () => fetch(segmentUrl, { headers: { Range: "bytes=0-4095" } }),
  },
  {
    name: "heartbeat",
    run: () =>
      fetch(`${BASE_URL}/api/v1/playback/sessions/${start.id}/heartbeat`, {
        method: "POST",
        headers: { ...auth.headers, "Content-Type": "application/json", "X-Webflix-Client": "web" },
        body: JSON.stringify({ positionSec: 40, durationSec: 150, state: "playing" }),
      }),
  },
];

const stats = { total: 0, failed: 0, byProbe: new Map<string, { ok: number; failed: number }>() };
const failures: string[] = [];
const latencies: number[] = [];
let running = true;

async function loop(worker: number) {
  let index = worker;
  while (running) {
    const probe = probes[index % probes.length] as Probe;
    index += 1;
    const began = performance.now();
    let outcome: string;
    try {
      const response = await probe.run();
      await response.arrayBuffer();
      outcome = response.status < 400 ? "ok" : `HTTP ${response.status}`;
    } catch (error) {
      outcome =
        error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    }
    latencies.push(performance.now() - began);
    stats.total += 1;
    const entry = stats.byProbe.get(probe.name) ?? { ok: 0, failed: 0 };
    if (outcome === "ok") entry.ok += 1;
    else {
      entry.failed += 1;
      stats.failed += 1;
      failures.push(`${new Date().toISOString()} ${probe.name}: ${outcome}`);
    }
    stats.byProbe.set(probe.name, entry);
  }
}

section(`Steady load (${concurrency} concurrent clients) while rolling out: ${targets.join(", ")}`);
const workers = Array.from({ length: concurrency }, (_, worker) => loop(worker));
const began = Date.now();
await new Promise((resolve) => setTimeout(resolve, 5000));
const baseline = stats.total;
// Through the release, as a deploy would: a pod annotation changes the templates (a new
// ReplicaSet each), then the rollback restores them (a second rollout, measured too).
const before = await release(["revision"]);
const stamp = String(Date.now());
const changed = await release([
  "reapply",
  ...targets.flatMap((target) => [
    "--set-string",
    `${target}.podAnnotations.webflix-rollout=${stamp}`,
  ]),
]);
console.log(`  revision ${before} → ${changed}: new pods for ${targets.join(", ")}`);
const restored = await release(["rollback", before]);
console.log(`  rolled back to revision ${before} (now ${restored}): new pods again`);
await new Promise((resolve) => setTimeout(resolve, 8000));
running = false;
await Promise.all(workers);
const seconds = (Date.now() - began) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p: number) => Math.round(latencies[Math.floor((latencies.length - 1) * p)] ?? 0);
console.log(
  `  ${stats.total} requests in ${seconds.toFixed(0)} s (${Math.round(stats.total / seconds)}/s; ${baseline} before the restart), latency p50 ${pct(0.5)} ms, p99 ${pct(0.99)} ms, max ${pct(1)} ms`,
);
for (const [name, entry] of stats.byProbe) {
  console.log(`    ${name.padEnd(15)} ${entry.ok} ok, ${entry.failed} failed`);
}
for (const failure of failures.slice(0, 20)) console.log(`    ! ${failure}`);
check(stats.failed === 0, `no failed request during either rollout (${stats.failed} failed)`);
finish();
