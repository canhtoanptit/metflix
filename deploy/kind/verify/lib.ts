// Shared helpers for the kind verification scripts (Node built-ins only, run from the host:
// `node deploy/kind/verify/<script>.ts`). They talk to the product over real HTTP through the
// gateway and use kubectl (context kind-webflix) to see which pod served what.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
export const CONTEXT = `kind-${process.env.WEBFLIX_KIND_CLUSTER ?? "webflix"}`;
/** The repository's kubeconfig (deploy/kind/lib.sh), never ~/.kube/config. */
export const KUBECONFIG =
  process.env.WEBFLIX_KUBECONFIG ?? resolve(import.meta.dirname, "../../../.cache/kube/config");
if (!CONTEXT.startsWith("kind-webflix")) throw new Error(`Refusing to use ${CONTEXT}`);
export const NAMESPACE = process.env.WEBFLIX_NAMESPACE ?? "webflix";
// The Helm release name (WEBFLIX_HELM_RELEASE; WEBFLIX_RELEASE is a product setting).
export const RELEASE = process.env.WEBFLIX_HELM_RELEASE ?? "webflix";

export function kubectl(args: string[], input?: string): string {
  return execFileSync(
    "kubectl",
    ["--kubeconfig", KUBECONFIG, "--context", CONTEXT, "-n", NAMESPACE, ...args],
    {
      encoding: "utf8",
      input,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}

/**
 * Change the release through Helm (deploy/kind/release.sh): `["reapply", "--set", "k=v"]`,
 * `["rollback", revision]` or `["revision"]`. Scripts never kubectl set/scale/edit release
 * objects, which would leave fields owned outside the release. Asynchronous, so load loops keep
 * running meanwhile; resolves with the revision deployed afterwards.
 */
export function release(args: string[]): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(resolve(import.meta.dirname, "../release.sh"), args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? done(output.trim().split("\n").at(-1) ?? "")
        : reject(new Error(`release.sh ${args.join(" ")} exited ${code}`)),
    );
  });
}

export interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
  requestId: string;
}

/** A browser: its own cookie jar; every request carries a fresh X-Request-Id we can trace. */
export class Device {
  readonly name: string;
  cookie = "";
  readonly requestIds: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const requestId = randomUUID();
    this.requestIds.push(requestId);
    const headers: Record<string, string> = {
      "X-Request-Id": requestId,
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(method !== "GET" && method !== "HEAD" ? { "X-Webflix-Client": "web" } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    };
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    const response = await fetch(url, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      if (pair.startsWith("webflix_session=")) this.cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json, requestId };
  }
}

/** requestId → pod name, from every API pod's access log (http.request lines). */
export function podsByRequestId(sinceSeconds = 600): Map<string, string> {
  const map = new Map<string, string>();
  const pods = kubectl([
    "get",
    "pods",
    "-l",
    "app.kubernetes.io/component=api",
    "-o",
    "jsonpath={.items[*].metadata.name}",
  ])
    .split(/\s+/)
    .filter(Boolean);
  for (const pod of pods) {
    let logs = "";
    try {
      logs = kubectl(["logs", pod, "-c", "api", `--since=${sinceSeconds}s`]);
    } catch {
      continue;
    }
    for (const line of logs.split("\n")) {
      if (!line.includes('"http.request"')) continue;
      try {
        const record = JSON.parse(line) as { requestId?: string };
        if (record.requestId) map.set(record.requestId, pod);
      } catch {
        // not JSON
      }
    }
  }
  return map;
}

let failures = 0;
export function check(condition: boolean, message: string, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  }
}
export function section(title: string): void {
  console.log(`\n${title}`);
}
export function finish(): never {
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Restart count of every API and worker pod, by pod name. */
export function processRestarts(): Map<string, number> {
  const listing = kubectl([
    "get",
    "pods",
    "-l",
    "app.kubernetes.io/component in (api,worker)",
    "-o",
    "jsonpath={range .items[*]}{.metadata.name}={.status.containerStatuses[0].restartCount} {end}",
  ]);
  return new Map(
    listing
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((entry) => {
        const [name = "", count = "0"] = entry.split("=");
        return [name, Number(count)] as const;
      }),
  );
}

/** Pods (of those listed now) that restarted since `before` was taken. */
export function restartedSince(before: Map<string, number>): string[] {
  return [...processRestarts()]
    .filter(([name, count]) => count > (before.get(name) ?? 0))
    .map(([name]) => name);
}

/**
 * A request that waits out `429 rate_limited` (Retry-After) and tries again: under the strict
 * production limits every script on this machine shares one client address.
 */
export async function patiently(
  device: Device,
  method: string,
  path: string,
  options: { body?: unknown } = {},
): Promise<Reply> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reply = await device.request(method, path, options);
    if (reply.status !== 429) return reply;
    const wait = Number(reply.headers.get("Retry-After") ?? "5");
    console.log(`  … rate limited on ${method} ${path}, waiting ${wait} s`);
    await sleep((wait + 1) * 1000);
  }
  throw new Error(`still rate limited: ${method} ${path}`);
}

export const PAYMENT = {
  method: "card",
  cardNumber: "4242424242424242",
  expMonth: 12,
  expYear: 2035,
  cvc: "123",
  nameOnCard: "Kind Verify",
};

/** A new account on `planId` with one profile selected; returns the device and credentials. */
export async function newAccount(planId: "basic" | "standard" | "premium") {
  const device = new Device("signup");
  const email = `verify-${randomUUID().slice(0, 8)}@example.com`;
  const password = "kind-verify-password";
  const signup = await patiently(device, "POST", "/api/v1/auth/signup", {
    body: { email, password, planId, payment: PAYMENT },
  });
  if (signup.status !== 201 && signup.status !== 200) {
    throw new Error(`signup failed: ${signup.status} ${signup.text}`);
  }
  const avatars = (await device.request("GET", "/api/v1/avatars")).json as {
    groups: { avatars: { id: string }[] }[];
  };
  const avatarId = avatars.groups[0]?.avatars[0]?.id;
  const profile = (
    await device.request("POST", "/api/v1/profiles", { body: { name: "Verify", avatarId } })
  ).json as { id: string };
  await patiently(device, "PUT", "/api/v1/session/profile", { body: { profileId: profile.id } });
  return { device, email, password, profileId: profile.id };
}

export async function login(name: string, email: string, password: string, profileId: string) {
  const device = new Device(name);
  const reply = await patiently(device, "POST", "/api/v1/auth/login", {
    body: { email, password },
  });
  if (reply.status !== 200) throw new Error(`login failed: ${reply.status} ${reply.text}`);
  await patiently(device, "PUT", "/api/v1/session/profile", { body: { profileId } });
  return device;
}

/** A movie the profile can play (first card of the first row that has a movie). */
export async function playableMovie(device: Device): Promise<string> {
  const browse = (await device.request("GET", "/api/v1/browse?view=movies")).json as {
    rows: { items: { id?: string; title?: { id: string; type: string } }[] }[];
  };
  for (const row of browse.rows) {
    for (const item of row.items) {
      const title = item.title ?? (item as { id: string; type: string });
      if (title && (title as { type?: string }).type === "movie") return title.id;
    }
  }
  throw new Error("no movie in the movies view");
}

/** The deployed sign-in limit ("limit/windowSec" from the ConfigMap, else the strict default). */
export function authLimit(): { limit: number; windowSec: number } {
  const value = kubectl([
    "get",
    "configmap",
    `${RELEASE}-config`,
    "-o",
    "jsonpath={.data.WEBFLIX_RATE_LIMIT_AUTH}",
  ]).trim();
  const [limit = "10", windowSec = "60"] = (value || "10/60").split("/");
  return { limit: Number(limit), windowSec: Number(windowSec) };
}
