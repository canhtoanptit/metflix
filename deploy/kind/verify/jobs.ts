// Jobs flow API → Valkey Streams → worker, their effects land in PostgreSQL, and a worker
// that is down or killed loses nothing.
//
//   node deploy/kind/verify/jobs.ts        (make k8s-verify)
import {
  check,
  finish,
  kubectl,
  newAccount,
  playableMovie,
  RELEASE,
  release,
  section,
  sleep,
} from "./lib.ts";

const queue = (command: string) =>
  kubectl([
    "exec",
    `${RELEASE}-valkey-0`,
    "-c",
    "valkey",
    "--",
    "valkey-cli",
    "--no-auth-warning",
    ...command.split(" "),
  ]).trim();
const depth = () => ({
  stream: Number(queue("XLEN webflix:{jobs}:stream")),
  delayed: Number(queue("ZCARD webflix:{jobs}:delayed")),
  dead: Number(queue("XLEN webflix:{jobs}:dead")),
});
const sql = (statement: string) =>
  kubectl([
    "exec",
    `${RELEASE}-postgresql-0`,
    "--",
    "psql",
    "-U",
    "webflix",
    "-d",
    "webflix",
    "-tA",
    "-c",
    statement,
  ]).trim();
const workerLogs = (since: string) => {
  try {
    return kubectl([
      "logs",
      "-l",
      "app.kubernetes.io/component=worker",
      "-c",
      "worker",
      "--since-time",
      since,
      "--tail=-1",
    ]);
  } catch {
    return "";
  }
};
/** Types of the dead letters added after `afterId` (valkey-cli prints field and value lines). */
const deadSince = (afterId: string) => {
  const lines = queue(`XRANGE webflix:{jobs}:dead ${afterId ? `(${afterId}` : "-"} +`).split("\n");
  return lines.flatMap((line, index) =>
    line.trim() === "type" ? [lines[index + 1]?.trim() ?? ""] : [],
  );
};
const lastDeadId = () =>
  queue("XREVRANGE webflix:{jobs}:dead + - COUNT 1").split("\n")[0]?.trim() ?? "";
// The scheduler publishes `sessions.cleanup` every tick; a worker from the previous release that
// does not know a newer job type dead-letters it during a rolling deploy (harmless: the next
// tick publishes it again). Only dead letters of the jobs this script causes are failures.
const SCHEDULED = new Set(["sessions.cleanup"]);
const today = new Date().toISOString().slice(0, 10);

/** One viewing: start, a few heartbeats (watched time), end. Ending publishes a rollup job. */
async function watch(account: Awaited<ReturnType<typeof newAccount>>, titleId: string) {
  const start = await account.device.request("POST", "/api/v1/playback/sessions", {
    body: { titleId },
  });
  const { id } = start.json as { id: string };
  for (const position of [30, 60, 90]) {
    await account.device.request("POST", `/api/v1/playback/sessions/${id}/heartbeat`, {
      body: { positionSec: position, durationSec: 150, state: "playing" },
    });
  }
  const end = await account.device.request("DELETE", `/api/v1/playback/sessions/${id}`);
  return end.status;
}

async function until(label: string, predicate: () => boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(1000);
  }
  console.log(`  … timed out waiting for ${label}`);
  return false;
}

const deadBefore = lastDeadId();
const account = await newAccount("premium");
const titleId = await playableMovie(account.device);
const statsRow = () =>
  sql(
    `select coalesce(sum(watch_sec), 0) from title_stats where day = '${today}' and title_id = '${titleId}' and source = 'playback'`,
  );

section("A viewing publishes a stats rollup; the worker applies it");
const before = Number(statsRow());
let since = new Date().toISOString();
check((await watch(account, titleId)) === 204, `watched ${titleId} for 90 s and ended the session`);
check(
  await until("stats.rolled_up", () => workerLogs(since).includes(`"stats.rolled_up"`)),
  "worker logged stats.rolled_up for the job (delivered through Valkey Streams)",
);
const after = Number(statsRow());
check(after > before, `title_stats.watch_sec for ${titleId} today: ${before} → ${after}`);

section("Worker down: jobs wait in Valkey, nothing is lost");
// Through the release (worker.replicas=0), and back by rolling the release back.
const revision = await release(["revision"]);
const workerless = await release(["reapply", "--set", "worker.replicas=0"]);
kubectl([
  "wait",
  "--for=delete",
  "pod",
  "-l",
  "app.kubernetes.io/component=worker",
  "--timeout=90s",
]);
check(true, `worker at 0 replicas (revision ${revision} → ${workerless})`);
const queuedBefore = Number(statsRow());
for (let index = 0; index < 3; index += 1) await watch(account, titleId);
await sleep(7000); // past the 5 s publish delay: promoted only by a running consumer
const waiting = depth();
check(
  waiting.delayed + waiting.stream >= 3,
  `3 rollup jobs held in Valkey while no worker runs (delayed ${waiting.delayed}, stream ${waiting.stream})`,
);
since = new Date().toISOString();
const restored = await release(["rollback", revision]);
console.log(`  rolled back to revision ${revision} (now ${restored}): the worker is back`);
check(
  await until("queue drained", () => {
    const now = depth();
    return now.delayed === 0 && now.stream === 0;
  }),
  "worker back: the queue drains",
);
check(Number(statsRow()) > queuedBefore, "their effect landed in title_stats");

section("Worker killed (no graceful shutdown) with jobs pending: the next pod processes them");
for (let index = 0; index < 2; index += 1) await watch(account, titleId);
const victim = kubectl([
  "get",
  "pods",
  "-l",
  "app.kubernetes.io/component=worker",
  "-o",
  "jsonpath={.items[0].metadata.name}",
]).trim();
kubectl(["delete", "pod", victim, "--grace-period=0", "--force", "--wait=false"]);
check(true, `force-deleted ${victim}`);
await sleep(2000);
kubectl(["rollout", "status", `deployment/${RELEASE}-worker`, "--timeout=120s"]);
check(
  await until(
    "queue drained after kill",
    () => {
      const now = depth();
      return now.delayed === 0 && now.stream === 0;
    },
    120_000,
  ),
  "replacement worker drained the queue",
);
const dead = deadSince(deadBefore);
const scheduled = dead.filter((type) => SCHEDULED.has(type));
check(
  dead.length === scheduled.length,
  `no dead letters from these jobs (${dead.length - scheduled.length}${scheduled.length ? `; ${scheduled.length} scheduled ${[...new Set(scheduled)].join(", ")} from a rolling worker, republished each tick` : ""})`,
);
const group = queue("XINFO GROUPS webflix:{jobs}:stream");
check(
  /pending\s+0/.test(group.replace(/\n/g, " ")),
  "no delivery left pending in the consumer group",
);

finish();
