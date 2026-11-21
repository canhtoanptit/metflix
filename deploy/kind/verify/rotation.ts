// Media token key rotation under steady playback load: sessions are started, playlists and
// segments fetched and heartbeats sent continuously (each request on whichever replica the
// gateway picks) while the signing key rotates and the API rolls.
//
//   node deploy/kind/verify/rotation.ts            two-phase rotation (add, then promote): 0 failures
//   node deploy/kind/verify/rotation.ts naive      the new key first in one step: shows the failures
//
// Afterwards retire the old keys with: make k8s-rotate-media-key STEP=retire
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import {
  BASE_URL,
  CONTEXT,
  check,
  type Device,
  finish,
  KUBECONFIG,
  kubectl,
  NAMESPACE,
  newAccount,
  playableMovie,
  RELEASE,
  release,
  section,
  sleep,
} from "./lib.ts";

const mode = process.argv[2] === "naive" ? "naive" : "two-phase";
const workers = 4;

const failures: string[] = [];
let total = 0;
let limited = 0;
let running = true;

async function playLoop(device: Device, titleId: string) {
  while (running) {
    // Session starts are rate limited per account (playback-start): one every 2 s per player.
    const paced = sleep(2000);
    const started = await device.request("POST", "/api/v1/playback/sessions", {
      body: { titleId },
    });
    total += 1;
    if (started.status === 429) {
      limited += 1;
      await sleep(Number(started.headers.get("Retry-After") ?? "2") * 1000);
      continue;
    }
    if (started.status !== 201) {
      failures.push(`start ${started.status} ${started.text.slice(0, 80)}`);
      await paced;
      continue;
    }
    const session = started.json as { id: string; manifestUrl: string };
    const master = new URL(session.manifestUrl, BASE_URL);
    for (let round = 0; round < 3 && running; round += 1) {
      const playlist = await fetch(master);
      const text = await playlist.text();
      total += 1;
      if (playlist.status !== 200) {
        failures.push(`master ${playlist.status} ${text.slice(0, 80)}`);
        break;
      }
      const variant = new URL(text.split("\n").find((l) => l && !l.startsWith("#")) ?? "", master);
      const media = await fetch(variant);
      const mediaText = await media.text();
      total += 1;
      if (media.status !== 200) {
        failures.push(`playlist ${media.status} ${mediaText.slice(0, 80)}`);
        break;
      }
      const segment = new URL(
        mediaText.split("\n").find((l) => l && !l.startsWith("#")) ?? "",
        variant,
      );
      const bytes = await fetch(segment, { headers: { Range: "bytes=0-2047" } });
      await bytes.arrayBuffer();
      total += 1;
      if (bytes.status !== 206) failures.push(`segment ${bytes.status}`);
      const beat = await device.request(
        "POST",
        `/api/v1/playback/sessions/${session.id}/heartbeat`,
        {
          body: { positionSec: 10 * (round + 1), durationSec: 150, state: "playing" },
        },
      );
      total += 1;
      if (beat.status !== 200) failures.push(`heartbeat ${beat.status} ${beat.text.slice(0, 80)}`);
    }
    await paced;
  }
}

function keyIds(): string {
  const encoded = kubectl([
    "get",
    "secret",
    `${RELEASE}-media-tokens`,
    "-o",
    "jsonpath={.data.WEBFLIX_MEDIA_TOKEN_KEYS}",
  ]);
  return Buffer.from(encoded, "base64")
    .toString("utf8")
    .split(",")
    .map((entry) => entry.split(":")[0])
    .join(",");
}

/** Run a command without blocking this process: the load loop must keep going meanwhile. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
    );
  });
}

const kubectlArgs = (args: string[]) => [
  "--kubeconfig",
  KUBECONFIG,
  "--context",
  CONTEXT,
  "-n",
  NAMESPACE,
  ...args,
];

function rotate(step: string): Promise<void> {
  return run(join(dirname(import.meta.dirname), "rotate-media-key.sh"), [step]);
}

async function naiveRotate(): Promise<void> {
  // The single-step rotation the docs used to describe: the new key first, then roll (through
  // the release, like the two-phase steps).
  const encoded = kubectl([
    "get",
    "secret",
    `${RELEASE}-media-tokens`,
    "-o",
    "jsonpath={.data.WEBFLIX_MEDIA_TOKEN_KEYS}",
  ]);
  const current = Buffer.from(encoded, "base64").toString("utf8");
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(36)), (b) =>
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".charAt(b % 62),
  ).join("");
  const next = `n${Date.now().toString(36).slice(-8)}:${secret},${current}`;
  await run(
    "kubectl",
    kubectlArgs([
      "patch",
      "secret",
      `${RELEASE}-media-tokens`,
      "--type",
      "merge",
      "--field-manager=webflix-rotate-media-key",
      "-p",
      JSON.stringify({ stringData: { WEBFLIX_MEDIA_TOKEN_KEYS: next } }),
    ]),
  );
  await release(["reapply"]);
}

section(`Key rotation (${mode}) under ${workers} concurrent players`);
const players = await Promise.all(
  Array.from({ length: workers }, async () => {
    const account = await newAccount("premium");
    return { device: account.device, titleId: await playableMovie(account.device) };
  }),
);
const before = keyIds();
const loops = players.map((player) => playLoop(player.device, player.titleId));
await sleep(5000);
const warmup = total;
if (mode === "naive") await naiveRotate();
else {
  await rotate("add");
  await rotate("promote");
}
await sleep(8000);
running = false;
await Promise.all(loops);
console.log(`  keys ${before} → ${keyIds()} (first signs)`);
console.log(
  `  ${total} requests (${warmup} before the rotation), ${failures.length} failed${limited ? `, ${limited} session starts rate limited (waited out, not counted)` : ""}`,
);
const kinds = new Map<string, number>();
for (const failure of failures) kinds.set(failure, (kinds.get(failure) ?? 0) + 1);
for (const [failure, count] of [...kinds].slice(0, 8)) console.log(`    ! ${count} × ${failure}`);
if (mode === "naive") {
  check(
    failures.length > 0,
    "the single-step rotation fails requests during the rollout (expected)",
  );
} else {
  check(failures.length === 0, "two-phase rotation: no failed request during either rollout");
}
finish();
