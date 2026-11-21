// Runs a command against a throwaway PostgreSQL container:
//   node scripts/with-postgres.ts vitest run --project node
// Starts `postgres:19-alpine` as `webflix-be-pg-test` on 127.0.0.1:4141, waits until it accepts
// real connections, runs the command with WEBFLIX_TEST_POSTGRES_URL set, then removes the
// container (on success, failure, SIGINT and SIGTERM). A container of that name that is
// already running is reused and left running: someone else started it.
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";

const CONTAINER = "webflix-be-pg-test";
const IMAGE = "postgres:19-alpine";
const PORT = 4141;
const DATABASE_URL = `postgres://webflix:webflix@127.0.0.1:${PORT}/webflix`;
const READY_TIMEOUT_MS = 60_000;

function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function isRunning(): boolean {
  const result = docker(["ps", "--quiet", "--filter", `name=^${CONTAINER}$`]);
  return result.status === 0 && result.stdout.trim() !== "";
}

function removeContainer(): void {
  docker(["rm", "--force", "--volumes", CONTAINER]);
}

function startContainer(): void {
  // A stopped leftover of ours would block the name.
  removeContainer();
  const result = docker([
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--env",
    "POSTGRES_USER=webflix",
    "--env",
    "POSTGRES_PASSWORD=webflix",
    "--env",
    "POSTGRES_DB=webflix",
    "--publish",
    `127.0.0.1:${PORT}:5432`,
    // Data on tmpfs and no fsync: a test server, thrown away afterwards.
    "--tmpfs",
    "/var/lib/postgresql",
    IMAGE,
    "-c",
    "fsync=off",
    "-c",
    "synchronous_commit=off",
    "-c",
    "full_page_writes=off",
    "-c",
    "max_connections=200",
  ]);
  if (result.status !== 0) {
    throw new Error(`docker run failed: ${result.stderr.trim()}`);
  }
}

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // pg_isready alone is not enough: the image's init phase runs a temporary server (socket
    // only) and restarts it. The TCP connection only succeeds against the final server.
    const ready = docker(["exec", CONTAINER, "pg_isready", "-U", "webflix", "-d", "webflix"]);
    if (ready.status === 0 && (await canConnect())) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Postgres in ${CONTAINER} not ready after ${READY_TIMEOUT_MS / 1000}s`);
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error("usage: node scripts/with-postgres.ts <command> [args...]");
    return 2;
  }

  const reuse = isRunning();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || reuse) return;
    cleaned = true;
    removeContainer();
  };

  let child: ReturnType<typeof spawn> | undefined;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // Forward to the command; before it runs, clean up and stop here.
      if (child) {
        child.kill(signal);
        return;
      }
      cleanup();
      process.exit(130);
    });
  }

  if (reuse) {
    console.log(`with-postgres: reusing running container ${CONTAINER}`);
  } else {
    console.log(`with-postgres: starting ${IMAGE} as ${CONTAINER} on port ${PORT}`);
    startContainer();
  }

  try {
    await waitUntilReady();
    const running = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, WEBFLIX_TEST_POSTGRES_URL: DATABASE_URL },
    });
    child = running;
    return await new Promise<number>((resolve) => {
      running.on("error", (error) => {
        console.error(`with-postgres: could not run ${command}: ${error.message}`);
        resolve(1);
      });
      running.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } finally {
    cleanup();
  }
}

process.exitCode = await main();
