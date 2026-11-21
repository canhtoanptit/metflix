// A long outage of a shared dependency (well past the readiness probe's tolerance): its pod is
// deleted while its node is cordoned, so the replacement stays Pending for N seconds (its volume
// is bound to that node), as when a pod is rescheduled and waits for its volume. No release
// object is touched (a node is not one). Requirements (docs/KUBERNETES.md §3):
//   - every API pod stays Ready (the gateway keeps routing; nothing becomes a blanket 503),
//   - what does not need the dependency keeps working (signed segments, artwork, plans, web),
//   - what needs it fails fast, every failure a 503 with Retry-After, and
//   - everything recovers on its own once the dependency is back.
//
//   node deploy/kind/verify/outage.ts valkey|postgresql [seconds]     (make k8s-outage)
import {
  BASE_URL,
  check,
  finish,
  kubectl,
  newAccount,
  playableMovie,
  processRestarts,
  RELEASE,
  restartedSince,
  section,
  sleep,
} from "./lib.ts";

const target = process.argv[2] === "postgresql" ? "postgresql" : "valkey";
const outageSec = Number(process.argv[3] ?? "45");

// --- what users hold before the outage ---------------------------------------------------------
const viewer = await newAccount("premium");
const titleId = await playableMovie(viewer.device);
const start = await viewer.device.request("POST", "/api/v1/playback/sessions", {
  body: { titleId },
});
const playback = start.json as { id: string; manifestUrl: string };
const master = new URL(playback.manifestUrl, BASE_URL);
const masterText = await (await fetch(master)).text();
const variant = new URL(masterText.split("\n").find((l) => l && !l.startsWith("#")) ?? "", master);
const variantText = await (await fetch(variant)).text();
const segment = new URL(
  variantText.split("\n").find((l) => l && !l.startsWith("#")) ?? "",
  variant,
);
const detail = (await viewer.device.request("GET", `/api/v1/titles/${titleId}`)).json as {
  images: { backdrop: { template: string; widths: number[] } };
};
const artwork = new URL(
  detail.images.backdrop.template
    .replace("{width}", String(detail.images.backdrop.widths[0]))
    .replace("{format}", "webp"),
  BASE_URL,
);

type Outcome = { status: number; retryAfter: string | null };
const probes: Record<string, () => Promise<Outcome>> = {
  web: () => fetch(`${BASE_URL}/`),
  plans: () => fetch(`${BASE_URL}/api/v1/plans`),
  segment: () => fetch(segment, { headers: { Range: "bytes=0-1023" } }),
  artwork: () => fetch(artwork),
  browse: () =>
    fetch(`${BASE_URL}/api/v1/browse?view=home`, { headers: { Cookie: viewer.device.cookie } }),
  heartbeat: () =>
    fetch(`${BASE_URL}/api/v1/playback/sessions/${playback.id}/heartbeat`, {
      method: "POST",
      headers: {
        Cookie: viewer.device.cookie,
        "Content-Type": "application/json",
        "X-Webflix-Client": "web",
      },
      body: JSON.stringify({ positionSec: 30, durationSec: 150, state: "playing" }),
    }),
} as unknown as Record<string, () => Promise<Outcome>>;
const names = Object.keys(probes);

interface Sample {
  at: number;
  ready: number;
  results: Record<string, Outcome>;
  ms: Record<string, number>;
}
const samples: Sample[] = [];
const t0 = Date.now();
let readyEndpoints = -1;
let probing = true;

const watcher = (async () => {
  while (probing) {
    try {
      readyEndpoints = Number(
        kubectl([
          "get",
          "deployment",
          `${RELEASE}-api`,
          "-o",
          "jsonpath={.status.readyReplicas}",
        ]).trim() || "0",
      );
    } catch {
      readyEndpoints = -1;
    }
    await sleep(1000);
  }
})();

const prober = (async () => {
  while (probing) {
    const at = Date.now() - t0;
    const results: Record<string, Outcome> = {};
    const ms: Record<string, number> = {};
    await Promise.all(
      names.map(async (name) => {
        const began = performance.now();
        try {
          const response = (await probes[name]?.()) as unknown as Response;
          await response.arrayBuffer();
          results[name] = {
            status: response.status,
            retryAfter: response.headers.get("Retry-After"),
          };
        } catch {
          results[name] = { status: 0, retryAfter: null };
        }
        ms[name] = Math.round(performance.now() - began);
      }),
    );
    samples.push({ at, ready: readyEndpoints, results, ms });
    await sleep(500);
  }
})();

const restartsBefore = processRestarts();
const pod = `${RELEASE}-${target}-0`;
const node = kubectl(["get", "pod", pod, "-o", "jsonpath={.spec.nodeName}"]).trim();
if (!node.startsWith("webflix")) throw new Error(`Refusing to cordon node ${node}`);
let cordoned = false;
const uncordon = () => {
  if (!cordoned) return;
  kubectl(["uncordon", node]);
  cordoned = false;
};
// Never leave the node cordoned, whatever happens to this script.
process.on("exit", uncordon);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    uncordon();
    process.exit(130);
  });
}
section(`${target} down for ${outageSec} s (pod deleted, ${node} cordoned)`);
await sleep(4000);
const downAt = Date.now() - t0;
kubectl(["cordon", node]);
cordoned = true;
kubectl(["delete", "pod", pod, "--wait=false"]);
await sleep(outageSec * 1000);
const upAt = Date.now() - t0;
uncordon();
for (let attempt = 0; attempt < 36; attempt += 1) {
  try {
    kubectl(["wait", "--for=condition=Ready", `pod/${pod}`, "--timeout=5s"]);
    break;
  } catch {
    await sleep(1000);
  }
}
const readyAt = Date.now() - t0;
const healthy = (sample: Sample) =>
  names.every((name) => {
    const code = sample.results[name]?.status ?? 0;
    return code > 0 && code < 400;
  });
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const recent = samples.slice(-6);
  if (recent.length === 6 && recent.every(healthy) && (recent[0]?.at ?? 0) > readyAt) break;
  await sleep(500);
}
probing = false;
await Promise.all([prober, watcher]);

console.log(
  `  pod deleted at ${(downAt / 1000).toFixed(1)} s, node uncordoned at ${(upAt / 1000).toFixed(1)} s, pod Ready at ${(readyAt / 1000).toFixed(1)} s`,
);
let previous = "";
for (const sample of samples) {
  const line = `ready API pods ${sample.ready}  ${names
    .map((name) => {
      const outcome = sample.results[name];
      return `${name} ${outcome?.status}${outcome?.retryAfter ? `(Retry-After ${outcome.retryAfter})` : ""}`;
    })
    .join("  ")}`;
  if (line !== previous) console.log(`    ${(sample.at / 1000).toFixed(1).padStart(6)} s  ${line}`);
  previous = line;
}

const during = samples.filter((sample) => sample.at > downAt + 2000 && sample.at < upAt);
const independent =
  target === "valkey"
    ? ["web", "plans", "segment", "artwork", "browse"]
    : ["web", "plans", "segment", "artwork"];
const dependent = target === "valkey" ? ["heartbeat"] : ["browse", "heartbeat"];
check(
  during.every((sample) => sample.ready >= 2),
  `every API pod stayed Ready throughout (${Math.min(...during.map((s) => s.ready))} or more)`,
);
for (const name of independent) {
  const failed = during.filter(
    (sample) => (sample.results[name]?.status ?? 0) >= 400 || sample.results[name]?.status === 0,
  );
  check(
    failed.length === 0,
    `${name} kept working while ${target} was down (${during.length} probes)`,
  );
}
for (const name of dependent) {
  const outcomes = during.map((sample) => sample.results[name]);
  const failing = outcomes.filter(
    (outcome) => (outcome?.status ?? 0) >= 400 || outcome?.status === 0,
  );
  const slowest = Math.max(...during.map((sample) => sample.ms[name] ?? 0));
  const statuses = [...new Set(failing.map((outcome) => outcome?.status))].join(", ");
  check(
    failing.length > 0,
    `${name} failed while ${target} was down (${statuses}), at most ${slowest} ms per request`,
  );
  const answered = failing.filter(
    (outcome) => outcome?.status === 503 && outcome.retryAfter !== null,
  );
  check(
    answered.length === failing.length,
    `every failure of ${name} was a 503 with Retry-After (${answered.length} of ${failing.length})`,
  );
}
check(samples.slice(-6).every(healthy), "everything recovered without intervention");
const restarted = restartedSince(restartsBefore);
check(
  restarted.length === 0,
  `no API or worker process restarted${restarted.length ? ` (restarted: ${restarted.join(", ")})` : ""}`,
);
finish();
