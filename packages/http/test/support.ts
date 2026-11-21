import {
  type ApiClientFor,
  createRouteClient,
  type PlanId,
  type Routes,
  routes,
} from "@webflix/contracts";
import { MemoryBlobStore, MemoryRateLimiter } from "@webflix/core/memory";
import {
  bytesOf,
  createTestServices,
  FIXTURE_MASTER_PLAYLIST,
  FIXTURE_PACKAGED_ASSET,
  type TestServices,
  type TestServicesOptions,
} from "@webflix/core/testing";
import type { Hono } from "hono";
import { type AppContainer, type AppEnv, createApp } from "../src/index.ts";

export const SEGMENT_BYTES = bytesOf(10_000, 7);
export const SEGMENT_PATH = "720p/seg0.m4s";
export const APPROVED_CARD = {
  method: "card" as const,
  cardNumber: "4242 4242 4242 4242",
  expMonth: 12,
  expYear: 2030,
  cvc: "123",
  nameOnCard: "Test Viewer",
};
export const DECLINED_CARD = { ...APPROVED_CARD, cardNumber: "4000000000000002" };

export interface TestApp extends TestServices {
  app: Hono<AppEnv>;
  blobs: MemoryBlobStore;
  container: AppContainer;
  /** A browser: its own cookie jar and User-Agent. */
  device(userAgent?: string): Device;
  /** Raw request through the app (relative URL). */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface Device {
  api: ApiClientFor<Routes>;
  cookies: Map<string, string>;
  /** Every Set-Cookie header this device received, latest last. */
  setCookies: string[];
  request(path: string, init?: RequestInit): Promise<Response>;
}

/** Fixture media the packaged fixture asset points at (see FIXTURE_MANIFEST). */
async function fillBlobs(blobs: MemoryBlobStore): Promise<void> {
  const vod = `vod/${FIXTURE_PACKAGED_ASSET}`;
  await blobs.put(`${vod}/master.m3u8`, FIXTURE_MASTER_PLAYLIST);
  await blobs.put(
    `${vod}/720p/index.m3u8`,
    "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.m4s\n#EXT-X-ENDLIST\n",
  );
  await blobs.put(`${vod}/${SEGMENT_PATH}`, SEGMENT_BYTES);
  await blobs.put(`${vod}/subs/en.vtt`, "WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n");
  await blobs.put("public/img/titles/t-orbit/card-320.webp", bytesOf(2_000, 3));
}

export async function createTestApp(
  options: TestServicesOptions & { container?: Partial<AppContainer> } = {},
): Promise<TestApp> {
  const test = await createTestServices(options);
  const blobs = new MemoryBlobStore({ clock: test.clock });
  await fillBlobs(blobs);
  const container: AppContainer = {
    config: test.deps.config,
    services: test.services,
    blobs,
    rateLimiter: new MemoryRateLimiter({ clock: test.clock }),
    clock: test.clock,
    ids: test.deps.ids,
    logger: test.logger,
    clientIp: (c) => c.req.header("X-Test-Ip") ?? "203.0.113.7",
    ...options.container,
  };
  const app = createApp(container);
  const request = async (path: string, init?: RequestInit) => app.request(path, init);

  const device = (
    userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Firefox/130.0",
  ): Device => {
    const cookies = new Map<string, string>();
    const setCookies: string[] = [];
    const send = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", userAgent);
      if (cookies.size > 0) {
        headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
      }
      const response = await app.request(path, { ...init, headers });
      for (const header of response.headers.getSetCookie()) {
        setCookies.push(header);
        const [pair = ""] = header.split(";");
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (value === "" || /max-age=0/i.test(header)) cookies.delete(name);
        else cookies.set(name, value);
      }
      return response;
    };
    const api = createRouteClient(routes, {
      validateResponses: true,
      fetch: (url, init) => send(url, init),
    });
    return { api, cookies, setCookies, request: send };
  };

  return { ...test, app, blobs, container, device, request };
}

/** Sign up a new account and land on a fresh profile (the onboarding journey). */
export async function onboard(
  t: TestApp,
  options: { email: string; planId?: PlanId; userAgent?: string },
): Promise<{ device: Device; profileId: string }> {
  const device = t.device(options.userAgent);
  await device.api.signup({
    body: {
      email: options.email,
      password: "correct horse battery",
      planId: options.planId ?? "standard",
      payment: APPROVED_CARD,
    },
  });
  const profile = await device.api.createProfile({ body: { name: "Me", avatarId: "av-fox" } });
  await device.api.selectProfile({ body: { profileId: profile.id } });
  return { device, profileId: profile.id };
}

/** Sign in as another device of an existing account. */
export async function signIn(
  t: TestApp,
  email: string,
  password: string,
  userAgent: string,
  profileId?: string,
): Promise<Device> {
  const device = t.device(userAgent);
  await device.api.login({ body: { email, password } });
  if (profileId) await device.api.selectProfile({ body: { profileId } });
  return device;
}

export const DEMO = { email: "demo@webflix.dev", password: "webflix-demo" };
export const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
export const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
