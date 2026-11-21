// Runs a command against throwaway Valkey and S3 (Garage) containers:
//   node scripts/with-services.ts vitest run
// Every run starts its own pair, `webflix-k8s-valkey-test-<run>` and
// `webflix-k8s-garage-test-<run>`, on free host ports in 4501-4549 (this workflow's range), so
// overlapping runs never share or remove each other's containers. It waits until both answer,
// runs the command with WEBFLIX_TEST_VALKEY_URL and WEBFLIX_TEST_S3_* set, then removes its
// containers (on success, failure, SIGINT and SIGTERM).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = randomBytes(3).toString("hex");
const VALKEY = {
  name: `webflix-k8s-valkey-test-${RUN}`,
  image: "valkey/valkey:9.2.0-alpine3.24",
  port: 0,
};
const GARAGE = {
  name: `webflix-k8s-garage-test-${RUN}`,
  image: "dxflrs/garage:v2.5.0",
  port: 0,
};
const PORT_RANGE = { first: 4501, last: 4549 };

// Fixed test credentials (throwaway containers, never used outside tests).
const S3_ACCESS_KEY = "GK0000000000000000000000aa";
const S3_SECRET_KEY = `${"0".repeat(63)}a`;
const S3_BUCKET = "webflix-media";
const S3_REGION = "garage";
const READY_TIMEOUT_MS = 60_000;

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function remove(name: string): void {
  docker(["rm", "--force", "--volumes", name]);
}

/**
 * `docker run` publishing `containerPort` on a free host port of the range; another run may
 * take a port between the probe and the bind, so a bind failure moves on to the next one.
 */
async function run(name: string, containerPort: number, args: string[]): Promise<number> {
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port += 1) {
    if (!(await portIsFree(port))) continue;
    const result = docker([
      "run",
      "--detach",
      "--name",
      name,
      "--publish",
      `127.0.0.1:${port}:${containerPort}`,
      ...args,
    ]);
    if (result.status === 0) return port;
    remove(name);
    if (!/port is already allocated|address already in use/i.test(result.stderr)) {
      throw new Error(`docker run ${name} failed: ${result.stderr.trim()}`);
    }
  }
  throw new Error(`No free port in ${PORT_RANGE.first}-${PORT_RANGE.last} for ${name}`);
}

async function startValkey(): Promise<void> {
  VALKEY.port = await run(VALKEY.name, 6379, [
    "--tmpfs",
    "/data",
    VALKEY.image,
    "valkey-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
}

async function startGarage(configDir: string): Promise<void> {
  const config = join(configDir, "garage.toml");
  writeFileSync(
    config,
    [
      'metadata_dir = "/var/lib/garage/meta"',
      'data_dir = "/var/lib/garage/data"',
      'db_engine = "sqlite"',
      "replication_factor = 1",
      'rpc_bind_addr = "[::]:3901"',
      'rpc_public_addr = "127.0.0.1:3901"',
      `rpc_secret = "${randomBytes(32).toString("hex")}"`,
      "[s3_api]",
      `s3_region = "${S3_REGION}"`,
      'api_bind_addr = "[::]:3900"',
      "",
    ].join("\n"),
  );
  GARAGE.port = await run(GARAGE.name, 3900, [
    "--mount",
    `type=bind,source=${config},target=/etc/garage.toml,readonly`,
    "--tmpfs",
    "/var/lib/garage",
    "--env",
    `GARAGE_DEFAULT_ACCESS_KEY=${S3_ACCESS_KEY}`,
    "--env",
    `GARAGE_DEFAULT_SECRET_KEY=${S3_SECRET_KEY}`,
    "--env",
    `GARAGE_DEFAULT_BUCKET=${S3_BUCKET}`,
    GARAGE.image,
    "/garage",
    "server",
    "--single-node",
    "--default-bucket",
  ]);
}

function tcpAnswers(port: number, probe: string, expect: RegExp): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let data = "";
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
    socket.on("connect", () => socket.write(probe));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (expect.test(data)) done(true);
    });
  });
}

async function waitUntil(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} not ready after ${READY_TIMEOUT_MS / 1000}s`);
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: node scripts/with-services.ts <command> [args...]");
    return 2;
  }
  const configDir = mkdtempSync(join(tmpdir(), "webflix-garage-"));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    remove(VALKEY.name);
    remove(GARAGE.name);
    rmSync(configDir, { recursive: true, force: true });
  };

  let child: ReturnType<typeof spawn> | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (child) {
        child.kill(signal);
        return;
      }
      cleanup();
      process.exit(130);
    });
  }

  try {
    await startValkey();
    console.log(`with-services: ${VALKEY.image} as ${VALKEY.name} on ${VALKEY.port}`);
    await startGarage(configDir);
    console.log(`with-services: ${GARAGE.image} as ${GARAGE.name} on ${GARAGE.port}`);
    await waitUntil("Valkey", () => tcpAnswers(VALKEY.port, "PING\r\n", /\+PONG/));
    // Any HTTP answer from the S3 API means it is listening (anonymous requests get 403).
    await waitUntil("Garage", () =>
      tcpAnswers(GARAGE.port, "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n", /^HTTP\/1\.[01] \d{3}/),
    );
    const running = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        WEBFLIX_TEST_VALKEY_URL: `redis://127.0.0.1:${VALKEY.port}`,
        WEBFLIX_TEST_S3_ENDPOINT: `http://127.0.0.1:${GARAGE.port}`,
        WEBFLIX_TEST_S3_REGION: S3_REGION,
        WEBFLIX_TEST_S3_BUCKET: S3_BUCKET,
        WEBFLIX_TEST_S3_ACCESS_KEY_ID: S3_ACCESS_KEY,
        WEBFLIX_TEST_S3_SECRET_ACCESS_KEY: S3_SECRET_KEY,
      },
    });
    child = running;
    return await new Promise<number>((resolve) => {
      running.on("error", (error) => {
        console.error(`with-services: could not run ${command}: ${error.message}`);
        resolve(1);
      });
      running.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    cleanup();
  }
}

process.exitCode = await main();
