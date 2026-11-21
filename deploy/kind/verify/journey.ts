// Product journey over real HTTP through the gateway, with at least two API replicas, proving
// that shared state is shared: every request is attributed to the pod that served it.
//
//   node deploy/kind/verify/journey.ts        (make k8s-verify)
import {
  authLimit,
  BASE_URL,
  check,
  Device,
  finish,
  login,
  newAccount,
  playableMovie,
  podsByRequestId,
  section,
  sleep,
} from "./lib.ts";

const started = Date.now();
console.log(`Journey against ${BASE_URL}`);

// --- identity, profile, browse, search ---------------------------------------------------------
section("Sign up, profile, browse, search");
const account = await newAccount("basic");
const laptop = account.device;
const session = (await laptop.request("GET", "/api/v1/session")).json as {
  authenticated: boolean;
  plan: { id: string; maxStreams: number };
  activeProfile: { id: string } | null;
};
check(session.authenticated && session.plan.id === "basic", "signed up on Basic (1 screen)");
check(session.activeProfile?.id === account.profileId, "profile created and selected");
const home = await laptop.request("GET", "/api/v1/browse?view=home");
const rows = (home.json as { rows: unknown[] }).rows;
check(home.status === 200 && rows.length > 0, `home has ${rows.length} rows`);
const search = await laptop.request("GET", "/api/v1/search?q=the");
check(
  search.status === 200 && ((search.json as { results: unknown[] }).results?.length ?? 0) > 0,
  "search returns results",
);
const titleId = await playableMovie(laptop);

// --- playback, HLS, Range ------------------------------------------------------------------------
section("Playback session, HLS playlists, segment Range requests");
const start = await laptop.request("POST", "/api/v1/playback/sessions", { body: { titleId } });
const playback = start.json as { id: string; manifestUrl: string; heartbeatIntervalSec: number };
check(start.status === 201 || start.status === 200, `playback session started for ${titleId}`);
const masterUrl = new URL(playback.manifestUrl, BASE_URL);
check(masterUrl.origin === new URL(BASE_URL).origin, "packaged media served same-origin (/media)");
const master = await laptop.request("GET", masterUrl.toString());
check(
  master.status === 200 && master.text.startsWith("#EXTM3U"),
  "master playlist (stream slot checked)",
);
const variantPath = master.text.split("\n").find((line) => line && !line.startsWith("#"));
const variantUrl = new URL(variantPath ?? "", masterUrl);
const variant = await laptop.request("GET", variantUrl.toString());
check(variant.status === 200 && variant.text.includes("#EXTINF"), "media playlist");
const segmentPath = variant.text.split("\n").find((line) => line && !line.startsWith("#"));
const segmentUrl = new URL(segmentPath ?? "", variantUrl).toString();
const full = await laptop.request("GET", segmentUrl);
const size = Number(full.headers.get("Content-Length") ?? "0");
check(
  full.status === 200 && size > 1024,
  `segment (${size} bytes, ${full.headers.get("Content-Type")})`,
);
check(full.headers.get("Accept-Ranges") === "bytes", "Accept-Ranges: bytes");
const ranged = await laptop.request("GET", segmentUrl, { headers: { Range: "bytes=100-1123" } });
check(
  ranged.status === 206 && ranged.headers.get("Content-Range") === `bytes 100-1123/${size}`,
  "Range bytes=100-1123 → 206 with Content-Range",
  { status: ranged.status, range: ranged.headers.get("Content-Range") },
);
const suffix = await laptop.request("GET", segmentUrl, { headers: { Range: "bytes=-64" } });
check(
  suffix.status === 206 &&
    suffix.headers.get("Content-Range") === `bytes ${size - 64}-${size - 1}/${size}`,
  "suffix Range bytes=-64 → 206",
);
const beyond = await laptop.request("GET", segmentUrl, {
  headers: { Range: `bytes=${size + 10}-` },
});
check(beyond.status === 416, "unsatisfiable Range → 416", beyond.status);

// --- heartbeats → continue watching, from several replicas -------------------------------------
section("Heartbeats feed Continue Watching (whichever replica they land on)");
for (const [index, position] of [20, 40, 60, 75].entries()) {
  const beat = await laptop.request("POST", `/api/v1/playback/sessions/${playback.id}/heartbeat`, {
    body: { positionSec: position, durationSec: 150, state: index === 3 ? "paused" : "playing" },
  });
  check(beat.status === 200, `heartbeat at ${position}s`, beat.status);
}
const continueWatching = (await laptop.request("GET", "/api/v1/continue-watching")).json as {
  items: { title: { id: string }; progress: { positionSec: number } | null }[];
};
const resumed = continueWatching.items.find((item) => item.title.id === titleId);
check(
  resumed?.progress?.positionSec === 75,
  "Continue Watching resumes at 75 s",
  resumed?.progress,
);

// --- concurrent stream limit across replicas -------------------------------------------------
section("Concurrent-stream limit enforced across replicas");
// The phone tries to start a second stream until one attempt lands on a pod other than the
// one that granted the laptop's lease.
let crossReplicaRefusal = false;
const phone = await login("phone", account.email, account.password, account.profileId);
for (let attempt = 0; attempt < 8 && !crossReplicaRefusal; attempt += 1) {
  const second = await phone.request("POST", "/api/v1/playback/sessions", { body: { titleId } });
  const problem = second.json as { code?: string; activeStreams?: unknown[] };
  check(
    second.status === 409 && problem.code === "stream_limit_reached",
    `second screen refused (attempt ${attempt + 1}): 409 stream_limit_reached`,
    second.status,
  );
  await sleep(1500); // let the access logs flush
  const pods = podsByRequestId();
  const grantedBy = pods.get(start.requestId);
  const refusedBy = pods.get(second.requestId);
  if (grantedBy && refusedBy && grantedBy !== refusedBy) {
    crossReplicaRefusal = true;
    check(true, `lease granted by ${grantedBy}, second stream refused by ${refusedBy}`);
  }
}
check(crossReplicaRefusal, "a refusal came from a different replica than the grant");

// --- rate limiting counted across replicas -----------------------------------------------------
section("Sign-in rate limit counted across replicas");
const attacker = new Device("attacker");
const attempts = await Promise.all(
  Array.from({ length: 150 }, (_, index) =>
    sleep(index * 4).then(() =>
      attacker.request("POST", "/api/v1/auth/login", {
        body: { email: `nobody-${index}@example.com`, password: "wrong-password-123" },
      }),
    ),
  ),
);
const admitted = attempts.filter((reply) => reply.status !== 429);
const limited = attempts.filter((reply) => reply.status === 429);
await sleep(1500);
const attemptPods = podsByRequestId();
const admittedPods = new Set(admitted.map((reply) => attemptPods.get(reply.requestId)));
const limitedPods = new Set(limited.map((reply) => attemptPods.get(reply.requestId)));
admittedPods.delete(undefined);
limitedPods.delete(undefined);
const seconds = (attempts.length * 4) / 1000;
// One shared counter admits at most the limit plus what refills during the burst (GCRA:
// limit per window, smoothly); per-replica counters would admit about that much per pod.
const { limit, windowSec } = authLimit();
const ceiling = limit + Math.ceil((seconds * limit) / windowSec) + 1;
check(
  admitted.length <= ceiling && limited.length > 0,
  `${admitted.length} admitted (limit ${limit}/${windowSec}s, at most ${ceiling} with refill), ${limited.length} limited: one budget shared by ${admittedPods.size + limitedPods.size > 0 ? "every" : "the"} pod`,
);
check(
  admittedPods.size >= 2 || admitted.length < 2,
  `admitted attempts were served by ${admittedPods.size} pods`,
);
check(limitedPods.size >= 2, `429s were answered by ${limitedPods.size} pods`);
const retryAfter = limited[0]?.headers.get("Retry-After");
check(Number(retryAfter) >= 1, `Retry-After: ${retryAfter}`);

// --- sign out everywhere: immediate on every replica ------------------------------------------
section("Sign out of all devices: effective immediately on every replica");
const logoutAll = await phone.request("POST", "/api/v1/auth/logout-all");
check(logoutAll.status === 204, "logout-all from the phone", logoutAll.status);
const after = await Promise.all(
  Array.from({ length: 8 }, () => laptop.request("GET", "/api/v1/account")),
);
check(
  after.every((reply) => reply.status === 401),
  "the laptop's session is rejected by every request right after",
  after.map((reply) => reply.status),
);
const playlistAfter = await new Device("copied-url").request("GET", masterUrl.toString());
check(
  playlistAfter.status === 410,
  "the laptop's playlist URL stops working (stream slot released)",
  playlistAfter.status,
);
await sleep(1500);
const logoutPods = podsByRequestId();
const rejectedBy = new Set(after.map((reply) => logoutPods.get(reply.requestId)));
rejectedBy.delete(undefined);
check(rejectedBy.size >= 2, `rejections came from ${rejectedBy.size} different pods`);

// --- demo account browse still fine; gateway preserved our request id -------------------------
section("Gateway details");
const plans = await new Device("anon").request("GET", "/api/v1/plans");
check(
  plans.headers.get("X-Request-Id") === plans.requestId,
  "client X-Request-Id preserved end to end",
);
const openapi = await fetch(`${BASE_URL}/api/openapi.json`, {
  headers: { "Accept-Encoding": "gzip" },
});
await openapi.arrayBuffer();
check(openapi.headers.get("Content-Encoding") === "gzip", "API JSON is gzip-compressed when asked");

console.log(`\n(${Math.round((Date.now() - started) / 1000)} s)`);
finish();
