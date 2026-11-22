/**
 * @webflix/dev-idp/node: the issuer on a real port, for tests and tools on Node. The only code in
 * this package that uses Node APIs; everything it serves is the portable fetch handler.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DevIdpOptions } from "../config.ts";
import { createDevIdpHost, type DevIdpHost, type DevIdpHostOptions } from "../host.ts";
import { createDevIdp, type DevIdp } from "../provider.ts";

export interface ServeOptions {
  /** Default 0: a free port chosen by the system. */
  port?: number;
  /** Default 127.0.0.1: never all interfaces unless asked. */
  hostname?: string;
}

export interface RunningServer {
  /** `http://hostname:port` */
  origin: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

async function toRequest(message: IncomingMessage, origin: string): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = message.method ?? "GET";
  // The URL is built from the configured origin, never from the Host header.
  return new Request(new URL(message.url ?? "/", origin), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

async function writeResponse(response: Response, out: ServerResponse): Promise<void> {
  out.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") out.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) out.setHeader("Set-Cookie", cookies);
  out.end(Buffer.from(await response.arrayBuffer()));
}

/** Serves a fetch handler on a port. */
export async function serveFetchHandler(
  handler: (request: Request) => Promise<Response>,
  options: ServeOptions = {},
): Promise<RunningServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  let origin = "";
  const server = createServer((message, out) => {
    void (async () => {
      try {
        const request = await toRequest(message, origin);
        if (!request) {
          out.statusCode = 413;
          out.end();
          return;
        }
        await writeResponse(await handler(request), out);
      } catch {
        if (!out.headersSent) out.statusCode = 500;
        out.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
  return {
    origin,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface DevIdpServerOptions extends Omit<DevIdpOptions, "issuer">, ServeOptions {
  /** The issuer's path on the server, e.g. `/realms/staff`. Default: the root. */
  path?: string;
}

export interface DevIdpServer extends RunningServer {
  idp: DevIdp;
  issuer: string;
}

/** One issuer on a real port: `issuer` is `http://127.0.0.1:<port>[path]`. */
export async function startDevIdpServer(options: DevIdpServerOptions): Promise<DevIdpServer> {
  const { port, hostname, path = "", ...idpOptions } = options;
  let idp: DevIdp | undefined;
  const server = await serveFetchHandler(
    async (request) => (idp ? idp.fetch(request) : new Response(null, { status: 503 })),
    { port, hostname },
  );
  try {
    idp = createDevIdp({ ...idpOptions, issuer: `${server.origin}${path}` });
  } catch (error) {
    await server.close();
    throw error;
  }
  return { ...server, idp, issuer: idp.issuer };
}

export interface DevIdpHostServer extends RunningServer {
  host: DevIdpHost;
}

/** Several issuers (for example the Webflix realms) on a real port. */
export async function startDevIdpHostServer(
  options: Omit<DevIdpHostOptions, "origin"> & ServeOptions,
): Promise<DevIdpHostServer> {
  const { port, hostname, ...hostOptions } = options;
  let host: DevIdpHost | undefined;
  const server = await serveFetchHandler(
    async (request) => (host ? host.fetch(request) : new Response(null, { status: 503 })),
    { port, hostname },
  );
  try {
    host = createDevIdpHost({ ...hostOptions, origin: server.origin });
  } catch (error) {
    await server.close();
    throw error;
  }
  return { ...server, host };
}
