/**
 * The S3 adapter against object stores that misbehave at the socket level (no external service
 * needed, so this runs in every `pnpm test`):
 * - accepts connections and never answers: every operation fails within its deadline as
 *   `service_unavailable`, instead of hanging until the gateway gives up;
 * - sends the headers, then stalls mid-body: reading fails after the idle timeout;
 * - a slow consumer (backpressure) is not mistaken for a stall.
 */
import { createServer, type Server, type Socket } from "node:net";
import { AppError } from "@webflix/core";
import { readAll } from "@webflix/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createS3BlobStore, type S3BlobStore } from "../src/s3-blob-store.ts";

type Behaviour = (socket: Socket) => void;

const open: { server: Server; sockets: Set<Socket>; store: S3BlobStore }[] = [];

async function fakeStore(behaviour: Behaviour): Promise<S3BlobStore> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    behaviour(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const store = createS3BlobStore({
    bucket: "webflix-media",
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    accessKeyId: "test",
    secretAccessKey: "test",
    forcePathStyle: true,
    connectionTimeoutMs: 300,
    requestTimeoutMs: 400,
    bodyIdleTimeoutMs: 400,
    maxAttempts: 1,
  });
  open.push({ server, sockets, store });
  return store;
}

afterEach(async () => {
  for (const { server, sockets, store } of open.splice(0)) {
    store.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** Answer each request (once its headers arrived) with `respond`. */
function onRequest(respond: (socket: Socket) => void): Behaviour {
  return (socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      if (buffered.includes("\r\n\r\n")) {
        buffered = "";
        respond(socket);
      }
    });
  };
}

const OBJECT_HEADERS = (length: number) =>
  [
    "HTTP/1.1 200 OK",
    "Content-Type: video/iso.segment",
    `Content-Length: ${length}`,
    'ETag: "0123456789abcdef"',
    "Last-Modified: Sat, 21 Nov 2026 10:00:00 GMT",
    "",
    "",
  ].join("\r\n");

async function settlesWithin<T>(ms: number, promise: Promise<T>) {
  const started = Date.now();
  const outcome = await promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { ...outcome, elapsed: Date.now() - started, inTime: Date.now() - started < ms };
}

describe("S3 BlobStore against a stalled object store", () => {
  it("fails every operation within its deadline when the store never answers", async () => {
    const store = await fakeStore(() => {});
    const operations: [string, () => Promise<unknown>][] = [
      ["get", () => store.get("vod/a/master.m3u8")],
      ["head", () => store.head("vod/a/master.m3u8")],
      ["list", () => store.list({ prefix: "vod/" })],
      ["delete", () => store.delete(["a", "b"])],
      ["put", () => store.put("vod/a/x.m4s", new Uint8Array(1024))],
      ["ping", () => store.ping()],
    ];
    const results = await Promise.all(
      operations.map(async ([name, run]) => [name, await settlesWithin(3000, run())] as const),
    );
    for (const [name, result] of results) {
      expect(result.ok, name).toBe(false);
      expect(result.inTime, `${name} settled after ${result.elapsed} ms`).toBe(true);
      if (name !== "ping" && !result.ok) {
        expect(AppError.is(result.error, "service_unavailable"), name).toBe(true);
      }
    }
  });

  it("fails a body that stalls mid-transfer after the idle timeout", async () => {
    const store = await fakeStore(
      onRequest((socket) => {
        socket.write(OBJECT_HEADERS(100_000));
        socket.write(Buffer.alloc(1000, 1)); // then nothing more
      }),
    );
    const object = await store.get("vod/a/seg-1.m4s");
    expect(object?.size).toBe(100_000);
    const result = await settlesWithin(3000, readAll(object?.body ?? new ReadableStream()));
    expect(result.ok).toBe(false);
    expect(result.inTime, `stalled body settled after ${result.elapsed} ms`).toBe(true);
    expect(String((result as { error: unknown }).error)).toMatch(/No bytes from the object store/);
  });

  it("does not mistake a slow reader (backpressure) for a stalled store", async () => {
    const size = 64 * 1024;
    const store = await fakeStore(
      onRequest((socket) => {
        socket.write(OBJECT_HEADERS(size));
        socket.write(Buffer.alloc(size, 7));
      }),
    );
    const object = await store.get("vod/a/seg-2.m4s");
    // The client is busy for three idle periods before it reads anything.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const bytes = await readAll(object?.body ?? new ReadableStream());
    expect(bytes.byteLength).toBe(size);
  });
});
