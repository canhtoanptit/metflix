import dns from "node:dns";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import http2, { type ClientHttp2Session } from "node:http2";
import https from "node:https";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDir, exists, readJson, writeJson } from "./fs.ts";
import { sha256File } from "./hash.ts";
import { formatBytes, log } from "./log.ts";

/**
 * Identifies the pipeline to the hosts we download from (Wikimedia asks every client for a
 * descriptive User-Agent). Deliberately carries no personal contact details.
 */
export const USER_AGENT =
  "WebflixMediaPipeline/1.0 (offline build of a local demo; low-volume, cached)";

/** `WEBFLIX_MEDIA_OFFLINE=1`: never touch the network; cached files or fallbacks only. */
export function isOffline(): boolean {
  return process.env.WEBFLIX_MEDIA_OFFLINE === "1";
}

// One request at a time per host, spaced out: we are a guest on these servers.
const hostQueues = new Map<string, Promise<void>>();
const HOST_SPACING_MS: Record<string, number> = {
  "commons.wikimedia.org": 1500,
  // One photo every few seconds: Wikimedia penalises bursts of uncached thumbnails.
  "upload.wikimedia.org": 4000,
};

/** When a host answers 429, every request to it waits out its Retry-After, not just one. */
const hostPausedUntil = new Map<string, number>();

function pauseHost(url: string, seconds: number): void {
  const host = new URL(url).host;
  const until = Date.now() + Math.min(Math.max(seconds, 5), 120) * 1000;
  hostPausedUntil.set(host, Math.max(hostPausedUntil.get(host) ?? 0, until));
}

async function politely<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  const previous = hostQueues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostQueues.set(
    host,
    previous.then(() => turn),
  );
  await previous;
  const pause = (hostPausedUntil.get(host) ?? 0) - Date.now();
  if (pause > 0) await sleep(pause);
  try {
    return await fn();
  } finally {
    const spacing = HOST_SPACING_MS[host] ?? 100;
    setTimeout(release, spacing);
  }
}

export class DownloadError extends Error {
  override readonly name = "DownloadError";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchText(url: string): Promise<string> {
  if (isOffline()) throw new DownloadError(`offline: ${url}`);
  const response = await getWithRetry(url, {});
  if (response.statusCode >= 400) {
    response.body.resume();
    throw new DownloadError(`${response.statusCode} for ${url}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

interface DownloadRecord {
  url: string;
  sha256: string;
  bytes: number;
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | undefined>;
  body: Readable;
}

/**
 * Hosts reached over HTTP/2. Wikimedia's media servers throttle HTTP/1.1 clients (429 with a
 * two-minute Retry-After) while serving HTTP/2 normally. Everything else uses HTTP/1.1, where
 * a few parallel connections are faster than one multiplexed one.
 */
const HTTP2_HOSTS = new Set(["upload.wikimedia.org", "commons.wikimedia.org"]);
const sessions = new Map<string, Promise<ClientHttp2Session>>();
const activeStreams = new WeakMap<ClientHttp2Session, number>();

function http2Session(origin: string): Promise<ClientHttp2Session> {
  let session = sessions.get(origin);
  if (!session) {
    session = new Promise((resolve, reject) => {
      // IPv4: Wikimedia shapes traffic per address, and an IPv6 address (often a shared /64)
      // was observed crawling at kilobytes per second while IPv4 ran at full speed.
      const client = http2.connect(origin, {
        settings: { initialWindowSize: 8 * 1024 * 1024 },
        lookup: (hostname, options, callback) =>
          dns.lookup(hostname, { ...options, family: 4 }, callback),
      });
      client.once("connect", () => {
        client.setLocalWindowSize(32 * 1024 * 1024);
        // Idle sessions must not keep the process alive; active streams ref it (http2Get).
        client.unref();
        resolve(client);
      });
      client.once("error", (error) => {
        sessions.delete(origin);
        reject(error);
      });
      client.once("close", () => sessions.delete(origin));
      client.once("goaway", () => sessions.delete(origin));
    });
    sessions.set(origin, session);
  }
  return session;
}

function flatHeaders(headers: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value === undefined
        ? undefined
        : String(value);
  }
  return out;
}

async function http2Get(url: URL, headers: Record<string, string>): Promise<HttpResponse> {
  const session = await http2Session(url.origin);
  const active = (activeStreams.get(session) ?? 0) + 1;
  activeStreams.set(session, active);
  session.ref();
  return new Promise((resolve, reject) => {
    const stream = session.request({
      ":path": `${url.pathname}${url.search}`,
      "user-agent": USER_AGENT,
      ...Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
      ),
    });
    stream.setTimeout(60_000, () => stream.destroy(new DownloadError(`timeout for ${url}`)));
    stream.once("response", (responseHeaders) => {
      resolve({
        statusCode: Number(responseHeaders[":status"] ?? 0),
        headers: flatHeaders(responseHeaders as Record<string, unknown>),
        body: stream,
      });
    });
    stream.once("error", reject);
    stream.once("close", () => {
      const left = (activeStreams.get(session) ?? 1) - 1;
      activeStreams.set(session, left);
      if (left === 0) session.unref();
    });
    stream.end();
  });
}

function http1Get(url: URL, headers: Record<string, string>): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, ...headers }, timeout: 60_000 },
      (response) => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: flatHeaders(response.headers as Record<string, unknown>),
          body: response,
        });
      },
    );
    request.on("timeout", () => request.destroy(new DownloadError(`timeout for ${url}`)));
    request.on("error", reject);
  });
}

/** GET with redirects followed, over HTTP/2 or HTTP/1.1 depending on the host. */
async function httpGet(
  url: string,
  headers: Record<string, string>,
  redirects = 5,
): Promise<HttpResponse> {
  const parsed = new URL(url);
  const response = HTTP2_HOSTS.has(parsed.host)
    ? await http2Get(parsed, headers)
    : await http1Get(parsed, headers);
  const location = response.headers.location;
  if (response.statusCode >= 300 && response.statusCode < 400 && location && redirects > 0) {
    response.body.resume();
    return httpGet(new URL(location, url).toString(), headers, redirects - 1);
  }
  return response;
}

/**
 * GET that retries throttling (429, honouring Retry-After) and server errors with backoff.
 * Hosts throttle bursts; a patient retry is the polite response.
 */
async function getWithRetry(
  url: string,
  headers: Record<string, string>,
  attempts = 6,
): Promise<HttpResponse> {
  for (let attempt = 1; ; attempt += 1) {
    let response: HttpResponse;
    try {
      response = await politely(url, () => httpGet(url, headers));
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    const status = response.statusCode;
    if (status !== 429 && status < 500) return response;
    response.body.resume();
    if (attempt >= attempts) throw new DownloadError(`${status} for ${url}`);
    if (status === 429) {
      pauseHost(url, Number(response.headers["retry-after"] ?? "0") || 3 * 2 ** attempt);
    } else {
      await sleep(Math.min(3000 * 2 ** (attempt - 1), 30_000));
    }
  }
}

/** Download `[start, end]` (inclusive) of `url` into `path`, resuming what is already there. */
async function downloadRange(url: string, path: string, start: number, end: number): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    let have = 0;
    try {
      have = (await stat(path)).size;
    } catch {
      have = 0;
    }
    if (have >= end - start + 1) return;
    try {
      const response = await politely(url, () =>
        httpGet(url, { Range: `bytes=${start + have}-${end}` }),
      );
      if (response.statusCode !== 206) {
        response.body.resume();
        throw new DownloadError(`${response.statusCode} for range of ${url}`);
      }
      await pipeline(response.body, createWriteStream(path, { flags: "a" }));
    } catch (error) {
      if (attempt >= 5) throw error;
      await sleep(1500 * 2 ** (attempt - 1));
    }
  }
}

/** Total size and range support, from a one-byte range request. */
async function probeSize(
  url: string,
  attempts: number,
): Promise<{ size: number; ranges: boolean }> {
  const response = await getWithRetry(url, { Range: "bytes=0-0" }, attempts);
  response.body.resume();
  const contentRange = response.headers["content-range"];
  if (response.statusCode === 206 && typeof contentRange === "string") {
    return { size: Number(contentRange.split("/")[1] ?? "0"), ranges: true };
  }
  if ((response.statusCode ?? 0) >= 400)
    throw new DownloadError(`${response.statusCode} for ${url}`);
  return { size: Number(response.headers["content-length"] ?? "0"), ranges: false };
}

const PART_BYTES = 48 * 1024 * 1024;
const PARALLEL_PARTS = 4;

/**
 * Download `url` to `target` once. A `.download.json` record next to the file remembers its
 * hash, so later runs neither re-download nor re-hash. Large files are fetched as a few
 * parallel byte ranges (each resumable); when `sha256` is given the bytes must match it.
 */
export async function downloadFile(
  url: string,
  target: string,
  expectedSha256: string | null = null,
  options: { attempts?: number; parallel?: boolean } = {},
): Promise<DownloadRecord> {
  const attempts = options.attempts ?? 6;
  // Small files (photos, subtitles) skip the size probe: one request instead of two.
  const parallel = options.parallel ?? true;
  const recordPath = `${target}.download.json`;
  const record = await readJson<DownloadRecord>(recordPath);
  if (
    record &&
    record.url === url &&
    (expectedSha256 === null || record.sha256 === expectedSha256) &&
    (await exists(target)) &&
    (await stat(target)).size === record.bytes
  ) {
    return record;
  }
  if (isOffline()) throw new DownloadError(`offline and not cached: ${url}`);

  await ensureDir(dirname(target));
  const partial = `${target}.part`;
  const { size, ranges } = parallel ? await probeSize(url, attempts) : { size: 0, ranges: false };
  if (size > 20 * 1024 * 1024) log.info(`downloading ${formatBytes(size)} from ${url}`);
  if (ranges && size > 0) {
    const count = Math.max(1, Math.min(PARALLEL_PARTS, Math.ceil(size / PART_BYTES)));
    const chunk = Math.ceil(size / count);
    const parts = Array.from({ length: count }, (_, index) => ({
      path: `${partial}${index}`,
      start: index * chunk,
      end: Math.min(size, (index + 1) * chunk) - 1,
    }));
    await Promise.all(parts.map((part) => downloadRange(url, part.path, part.start, part.end)));
    await rm(partial, { force: true });
    for (const part of parts) {
      await pipeline(createReadStream(part.path), createWriteStream(partial, { flags: "a" }));
    }
    for (const part of parts) await rm(part.path, { force: true });
  } else {
    const response = await getWithRetry(url, {}, attempts);
    if (response.statusCode >= 400) {
      response.body.resume();
      throw new DownloadError(`${response.statusCode} for ${url}`);
    }
    await pipeline(response.body, createWriteStream(partial));
  }
  const sha256 = await sha256File(partial);
  if (expectedSha256 !== null && sha256 !== expectedSha256) {
    await rm(partial, { force: true });
    throw new DownloadError(`sha256 mismatch for ${url}: got ${sha256}, want ${expectedSha256}`);
  }
  await rename(partial, target);
  const bytes = (await stat(target)).size;
  const result = { url, sha256, bytes };
  await writeJson(recordPath, result);
  return result;
}
