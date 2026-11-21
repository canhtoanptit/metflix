#!/usr/bin/env node
/**
 * The production path of the Cloudflare mode (docs/CLOUDFLARE.md, "Deploying").
 *
 *   node scripts/deploy.ts provision [--dry-run]   find or create D1, KV, R2, Queues; write ids
 *                                                   and the routing derived from the origin
 *   node scripts/deploy.ts deploy    [--dry-run] [--skip-media] [--skip-seed] [--with-demo]
 *   node scripts/deploy.ts media-key add|promote|retire [--dry-run] [--force]
 *   node scripts/deploy.ts bundle                   production bundle (no upload) + size report
 *
 * `deploy` = provision → stage assets → D1 migrations (remote) → media upload → seed →
 * `wrangler deploy` (+ the media-token secret on first deploy) → readiness check.
 * Every step is idempotent, so a failed run is fixed by running it again.
 *
 * `--dry-run` needs no account: it validates the production config, stages the assets,
 * builds the exact bundle `wrangler deploy` would upload, and prints every remote command
 * instead of running it.
 *
 * Credentials: `wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (CI).
 *
 * Media-token keys (lib/media-keys.ts): the first deploy sets WEBFLIX_MEDIA_TOKEN_KEYS from the
 * environment, else from the operator's key file, else a generated key; later deploys never
 * touch it. Rotation is `media-key add`, deploy, `promote`, deploy, `retire`. Secrets are
 * write-only on the platform, so the current set comes from WEBFLIX_MEDIA_TOKEN_KEYS (your
 * secret manager) or the key file the tooling keeps (apps/edge/.wrangler/secrets, mode 600).
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { unstable_readConfig } from "wrangler";
import { stageAssets } from "./lib/assets.ts";
import { routingForOrigin, writeProductionIds, writeProductionRouting } from "./lib/config.ts";
import {
  decideFirstKey,
  formatKeys,
  MEDIA_KEYS_SECRET,
  newKey,
  parseKeys,
  type RotationStep,
  rotate,
  type SigningKey,
} from "./lib/media-keys.ts";
import { EDGE_DIR, WRANGLER_CONFIG } from "./lib/platform.ts";
import { parseJsonOutput, wrangler } from "./lib/wrangler.ts";

const ENV = "production";
const say = (message: string) => console.log(`[cf] ${message}`);
const plan = (command: string) => console.log(`[cf]   (dry run) would run: ${command}`);

/** KV namespaces are found by title; the binding only stores the id. */
const KV_TITLE = "webflix-cache";
/** Queues' maximum retention on Workers Paid (14 days). */
const DEAD_LETTER_RETENTION_SEC = 14 * 24 * 60 * 60;
/** Ids that mean "not provisioned yet" in wrangler.jsonc. */
const PLACEHOLDER = /^0+(-0+)*$/;

interface ProductionResources {
  databaseName: string;
  databaseId: string | undefined;
  kvId: string | undefined;
  bucket: string;
  queues: string[];
  deadLetterQueues: string[];
}

function readProductionConfig(): ProductionResources {
  const config = unstable_readConfig({ config: WRANGLER_CONFIG, env: ENV }, { hideWarnings: true });
  const db = config.d1_databases[0];
  const kv = config.kv_namespaces[0];
  const r2 = config.r2_buckets[0];
  if (!db?.database_name || !kv || !r2?.bucket_name) {
    throw new Error("wrangler.jsonc env.production must declare the DB, CACHE and MEDIA bindings");
  }
  const queues = new Set<string>();
  const deadLetterQueues: string[] = [];
  for (const producer of config.queues.producers ?? []) {
    if (producer.queue) queues.add(producer.queue);
  }
  for (const consumer of config.queues.consumers ?? []) {
    queues.add(consumer.queue);
    if (consumer.dead_letter_queue) {
      queues.add(consumer.dead_letter_queue);
      deadLetterQueues.push(consumer.dead_letter_queue);
    }
  }
  return {
    databaseName: db.database_name,
    databaseId: db.database_id && !PLACEHOLDER.test(db.database_id) ? db.database_id : undefined,
    kvId: kv.id && !PLACEHOLDER.test(kv.id) ? kv.id : undefined,
    bucket: r2.bucket_name,
    queues: [...queues],
    deadLetterQueues,
  };
}

function productionOrigin(): string {
  const config = unstable_readConfig({ config: WRANGLER_CONFIG, env: ENV }, { hideWarnings: true });
  return String(config.vars.WEBFLIX_PUBLIC_ORIGIN ?? "");
}

async function provision(dryRun: boolean): Promise<void> {
  const wanted = readProductionConfig();
  // Fail before touching the account: the origin decides the routing and the readiness check.
  const routing = routingForOrigin(productionOrigin());
  if (!routing.ok) {
    if (!dryRun) throw new Error(routing.reason);
    say(`WARNING: a real deploy would stop here. ${routing.reason}`);
  } else {
    say(
      `routing: ${routing.workersDev ? `workers.dev only (${routing.host})` : `custom domain ${routing.host}, workers.dev off`}`,
    );
  }
  say(
    `production resources: D1 "${wanted.databaseName}", KV "${KV_TITLE}", R2 "${wanted.bucket}", queues ${wanted.queues.map((q) => `"${q}"`).join(", ")}`,
  );
  if (dryRun) {
    plan("wrangler whoami --json");
    plan(`wrangler d1 list --json   → else: wrangler d1 create ${wanted.databaseName}`);
    plan(`wrangler kv namespace list → else: wrangler kv namespace create ${KV_TITLE}`);
    plan(
      `wrangler r2 bucket info ${wanted.bucket} → else: wrangler r2 bucket create ${wanted.bucket}`,
    );
    for (const queue of wanted.queues) {
      const retention = wanted.deadLetterQueues.includes(queue)
        ? ` --message-retention-period-secs ${DEAD_LETTER_RETENTION_SEC}`
        : "";
      plan(`wrangler queues info ${queue} → else: wrangler queues create ${queue}${retention}`);
    }
    plan("write the D1 and KV ids, workers_dev and routes into wrangler.jsonc env.production");
    say(
      `config today: D1 id ${wanted.databaseId ?? "not provisioned"}, KV id ${wanted.kvId ?? "not provisioned"}`,
    );
    return;
  }

  const whoami = await wrangler(["whoami", "--json"], { allowFailure: true });
  if (whoami.code !== 0) {
    throw new Error(
      "Not authenticated with Cloudflare: run `pnpm --filter @webflix/edge exec wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID",
    );
  }

  // D1
  const databases = parseJsonOutput<{ uuid: string; name: string }[]>(
    (await wrangler(["d1", "list", "--json"])).stdout,
  );
  let databaseId = databases.find((db) => db.name === wanted.databaseName)?.uuid;
  if (!databaseId) {
    say(`creating D1 database ${wanted.databaseName}…`);
    await wrangler(["d1", "create", wanted.databaseName]);
    databaseId = parseJsonOutput<{ uuid: string; name: string }[]>(
      (await wrangler(["d1", "list", "--json"])).stdout,
    ).find((db) => db.name === wanted.databaseName)?.uuid;
  }
  if (!databaseId) throw new Error(`D1 database ${wanted.databaseName} not found after creation`);

  // KV
  const listNamespaces = async () =>
    parseJsonOutput<{ id: string; title: string }[]>(
      (await wrangler(["kv", "namespace", "list"])).stdout,
    );
  let kvId = (await listNamespaces()).find((ns) => ns.title === KV_TITLE)?.id;
  if (!kvId) {
    say(`creating KV namespace ${KV_TITLE}…`);
    await wrangler(["kv", "namespace", "create", KV_TITLE]);
    kvId = (await listNamespaces()).find((ns) => ns.title === KV_TITLE)?.id;
  }
  if (!kvId) throw new Error(`KV namespace ${KV_TITLE} not found after creation`);

  // R2
  if (
    (await wrangler(["r2", "bucket", "info", wanted.bucket], { allowFailure: true })).code !== 0
  ) {
    say(`creating R2 bucket ${wanted.bucket}…`);
    await wrangler(["r2", "bucket", "create", wanted.bucket]);
  }

  // Queues (the dead-letter queue included: it must exist before the consumer references it).
  // Nothing consumes the dead-letter queue, so it keeps messages as long as Queues allows.
  for (const queue of wanted.queues) {
    if ((await wrangler(["queues", "info", queue], { allowFailure: true })).code !== 0) {
      say(`creating queue ${queue}…`);
      const retention = wanted.deadLetterQueues.includes(queue)
        ? ["--message-retention-period-secs", String(DEAD_LETTER_RETENTION_SEC)]
        : [];
      await wrangler(["queues", "create", queue, ...retention]);
    }
  }

  const changed =
    (await writeProductionIds(WRANGLER_CONFIG, { databaseId, kvId })) ||
    (routing.ok && (await writeProductionRouting(WRANGLER_CONFIG, routing)));
  say(
    `provisioned: D1 ${databaseId}, KV ${kvId}, R2 ${wanted.bucket}, ${wanted.queues.length} queues`,
  );
  if (changed) say("wrote resource ids / routing into apps/edge/wrangler.jsonc: commit them");
}

/** The operator's copy of the key set (secrets cannot be read back from the platform). */
const KEY_FILE = join(EDGE_DIR, ".wrangler", "secrets", "production-media-token-keys.json");

interface KeyFile {
  keys: string;
  updatedAt: string;
  /** When the newest key started signing (`promote`); `retire` waits a token lifetime. */
  promotedAt?: string;
}

async function readKeyFile(): Promise<KeyFile | null> {
  try {
    return JSON.parse(await readFile(KEY_FILE, "utf8")) as KeyFile;
  } catch {
    return null;
  }
}

async function writeKeyFile(file: KeyFile): Promise<void> {
  await mkdir(join(KEY_FILE, ".."), { recursive: true });
  await writeFile(KEY_FILE, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  say(`key set saved to ${KEY_FILE} (mode 600): keep a copy in your secret manager`);
}

/** The current key set, from the environment (secret manager) or the key file. */
async function currentKeys(): Promise<SigningKey[]> {
  const fromEnvironment = process.env[MEDIA_KEYS_SECRET];
  if (fromEnvironment) return parseKeys(fromEnvironment);
  const file = await readKeyFile();
  if (file) return parseKeys(file.keys);
  throw new Error(
    `The current media-token keys are needed: set ${MEDIA_KEYS_SECRET} from your secret manager (the platform cannot show secrets again), or run from the machine that holds ${KEY_FILE}`,
  );
}

/** A secrets file for the first deploy, or null when the secret is already set. */
async function firstDeploySecrets(dir: string): Promise<string | null> {
  const listing = await wrangler(["secret", "list", "--env", ENV, "--format", "json"], {
    allowFailure: true,
  });
  const decision = decideFirstKey(listing, readWorkerName());
  if (decision.action === "abort") throw new Error(decision.reason);
  if (decision.action === "keep") {
    if (process.env[MEDIA_KEYS_SECRET]) {
      say(
        `${MEDIA_KEYS_SECRET} is already set: ignoring the environment value (use \`media-key\` to rotate)`,
      );
    }
    return null;
  }
  say(`setting ${MEDIA_KEYS_SECRET}: ${decision.why}`);
  let keys: SigningKey[];
  const fromEnvironment = process.env[MEDIA_KEYS_SECRET];
  const file = await readKeyFile();
  if (fromEnvironment) keys = parseKeys(fromEnvironment);
  else if (file) keys = parseKeys(file.keys);
  else {
    if (process.env.CI) {
      throw new Error(
        `First deploy from CI: provide ${MEDIA_KEYS_SECRET} from the CI secret store (a key generated here would be lost with the runner)`,
      );
    }
    keys = [newKey()];
    say("generated a 256-bit media-token key");
  }
  if (!fromEnvironment)
    await writeKeyFile({ keys: formatKeys(keys), updatedAt: new Date().toISOString() });
  const path = join(dir, "secrets.json");
  await writeFile(path, JSON.stringify({ [MEDIA_KEYS_SECRET]: formatKeys(keys) }), { mode: 0o600 });
  return path;
}

function readWorkerName(): string {
  const config = unstable_readConfig({ config: WRANGLER_CONFIG, env: ENV }, { hideWarnings: true });
  return config.name ?? "webflix";
}

/** One step of the two-phase rotation; each step is uploaded (and deployed) on its own. */
async function mediaKey(step: RotationStep, options: { dryRun: boolean; force: boolean }) {
  const keys = await currentKeys();
  const file = await readKeyFile();
  if (step === "retire" && !options.force) {
    const ttlSec = Number(
      unstable_readConfig({ config: WRANGLER_CONFIG, env: ENV }, { hideWarnings: true }).vars
        .WEBFLIX_MEDIA_TOKEN_TTL_SEC ?? 21_600,
    );
    const promotedAt = file?.promotedAt ? Date.parse(file.promotedAt) : Number.NaN;
    if (!(Date.now() - promotedAt >= ttlSec * 1000)) {
      throw new Error(
        `retire drops the previous key, so tokens it signed stop working: wait ${ttlSec} s (the token lifetime) after \`promote\` was deployed${file?.promotedAt ? ` (${file.promotedAt})` : ""}, or pass --force`,
      );
    }
  }
  const next = rotate(keys, step, step === "add" ? newKey() : undefined);
  say(
    `${step}: ${keys.map((key) => key.id).join(", ")} → ${next.map((key, index) => `${key.id}${index === 0 ? " (signs)" : " (verifies)"}`).join(", ")}`,
  );
  if (options.dryRun) {
    plan(
      `wrangler secret bulk <file with ${MEDIA_KEYS_SECRET}> --env ${ENV}   (uploads and deploys)`,
    );
    return;
  }
  const temp = await mkdtemp(join(tmpdir(), "webflix-keys-"));
  try {
    const path = join(temp, "secrets.json");
    await writeFile(path, JSON.stringify({ [MEDIA_KEYS_SECRET]: formatKeys(next) }), {
      mode: 0o600,
    });
    await wrangler(["secret", "bulk", path, "--env", ENV], { inherit: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  await writeKeyFile({
    keys: formatKeys(next),
    updatedAt: new Date().toISOString(),
    ...(step === "promote" ? { promotedAt: new Date().toISOString() } : {}),
  });
  const after: Record<RotationStep, string> = {
    add: "when that version serves all traffic: `media-key promote`",
    promote: "after the token lifetime (6 h by default): `media-key retire`",
    retire: "rotation complete",
  };
  say(`uploaded and deployed; next ${after[step]}`);
}

interface BundleReport {
  files: { name: string; bytes: number; gzip: number }[];
  totalBytes: number;
  totalGzip: number;
}

/**
 * zod's locale tables are ~260 KiB of minified Worker when something imports zod as
 * `import { z } from "zod"` (esbuild keeps that namespace whole). Namespace imports keep only
 * the default locale (~3 KiB); anything above this bound means one came back.
 */
const ZOD_LOCALES_BUDGET_BYTES = 16 * 1024;

async function bundle(outdir: string): Promise<BundleReport> {
  await rm(outdir, { recursive: true, force: true });
  const metafile = join(outdir, "..", "worker-meta.json");
  await wrangler(
    ["deploy", "--dry-run", "--env", ENV, "--outdir", outdir, "--metafile", metafile],
    { inherit: true },
  );
  const meta = JSON.parse(await readFile(metafile, "utf8")) as {
    outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>;
  };
  let zod = 0;
  let locales = 0;
  for (const output of Object.values(meta.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (!input.includes("node_modules/zod/")) continue;
      zod += bytesInOutput;
      if (input.includes("/locales/")) locales += bytesInOutput;
    }
  }
  say(
    `zod in the bundle: ${(zod / 1024).toFixed(1)} KiB (locales ${(locales / 1024).toFixed(1)} KiB)`,
  );
  if (locales > ZOD_LOCALES_BUDGET_BYTES) {
    throw new Error(
      `zod locale tables are ${(locales / 1024).toFixed(1)} KiB of the Worker: something imports zod as \`import { z } from "zod"\`; use \`import * as z from "zod"\``,
    );
  }
  const files: BundleReport["files"] = [];
  for (const name of await readdir(outdir)) {
    if (!/\.(m?js|wasm)$/.test(name) || !(await stat(join(outdir, name))).isFile()) continue;
    const content = await readFile(join(outdir, name));
    files.push({
      name,
      bytes: content.byteLength,
      gzip: gzipSync(content, { level: 9 }).byteLength,
    });
  }
  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalGzip: files.reduce((sum, file) => sum + file.gzip, 0),
  };
}

function printBundle(report: BundleReport): void {
  const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
  for (const file of report.files)
    say(`bundle ${file.name}: ${kib(file.bytes)} (gzip ${kib(file.gzip)})`);
  say(`bundle total: ${kib(report.totalBytes)}, gzip ${kib(report.totalGzip)}`);
}

async function runOps(args: string[], dryRun: boolean): Promise<void> {
  const command = `node scripts/ops.ts ${args.join(" ")}`;
  if (dryRun) return plan(command);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/ops.ts", ...args], {
    cwd: EDGE_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`${command} failed`);
}

async function verify(url: string): Promise<void> {
  const response = await fetch(new URL("/readyz", url));
  const body = await response.text();
  if (!response.ok) throw new Error(`${url}/readyz answered ${response.status}: ${body}`);
  say(`${url}/readyz → ${body}`);
}

async function deploy(options: { dryRun: boolean; media: boolean; seed: boolean; demo: boolean }) {
  const { dryRun } = options;
  await provision(dryRun);

  const assets = await stageAssets("production");
  say(`static assets staged: ${assets.files} files, ${(assets.bytes / 1e6).toFixed(1)} MB`);

  const migrate = ["d1", "migrations", "apply", "DB", "--remote", "--env", ENV, "--force"];
  if (dryRun) plan(`wrangler ${migrate.join(" ")}`);
  else await wrangler(migrate, { inherit: true });

  if (options.media) await runOps(["media", "--target", "production"], dryRun);
  // The demo account's credentials are public (docs): production seeds it only on request.
  if (options.seed) {
    await runOps(["seed", "--target", "production", options.demo ? "--demo" : "--no-demo"], dryRun);
  }

  if (dryRun) {
    printBundle(await bundle(join(EDGE_DIR, "dist", "worker")));
    plan(
      `wrangler secret list --env ${ENV} → first deploy only: --secrets-file with ${MEDIA_KEYS_SECRET}`,
    );
    plan(`wrangler deploy --env ${ENV}`);
    plan("GET <WEBFLIX_PUBLIC_ORIGIN>/readyz");
    say("dry run complete: nothing was sent to Cloudflare");
    return;
  }

  const temp = await mkdtemp(join(tmpdir(), "webflix-deploy-"));
  try {
    const secrets = await firstDeploySecrets(temp);
    const result = await wrangler(
      ["deploy", "--env", ENV, ...(secrets ? ["--secrets-file", secrets] : [])],
      { inherit: true },
    );
    if (result.code !== 0) throw new Error("wrangler deploy failed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  // provision() refused a placeholder origin, so this check always runs.
  await verify(productionOrigin());
}

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "skip-media": { type: "boolean", default: false },
      "skip-seed": { type: "boolean", default: false },
      "with-demo": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  const dryRun = values["dry-run"];
  switch (positionals[0]) {
    case "provision":
      await provision(dryRun);
      return 0;
    case "deploy":
      await deploy({
        dryRun,
        media: !values["skip-media"],
        seed: !values["skip-seed"],
        demo: values["with-demo"],
      });
      return 0;
    case "media-key": {
      const step = positionals[1];
      if (step !== "add" && step !== "promote" && step !== "retire") {
        console.error(
          "Usage: node scripts/deploy.ts media-key <add|promote|retire> [--dry-run] [--force]",
        );
        return 1;
      }
      await mediaKey(step, { dryRun, force: values.force });
      return 0;
    }
    case "bundle":
      printBundle(await bundle(join(EDGE_DIR, "dist", "worker")));
      return 0;
    default:
      console.error(
        "Usage: node scripts/deploy.ts <provision|deploy|media-key|bundle> [--dry-run]",
      );
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[cf] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
