/**
 * Inside workerd: a media request whose read of the asset's master playlist never completes (the
 * request was cancelled mid-read) leaves later requests unaffected. Nothing in flight is shared
 * between requests; a Worker must never await a promise another request created.
 */
import { createRouteClient, routes } from "@webflix/contracts";
import { MemoryBlobStore, MemoryRateLimiter } from "@webflix/core/memory";
import { createTestServices, FIXTURE_MASTER_PLAYLIST } from "@webflix/core/testing";
import { createApp } from "@webflix/http";
import { expect, it } from "vitest";

it("serves a segment while an earlier request's master read hangs", async () => {
  const t = await createTestServices();
  const blobs = new MemoryBlobStore({ clock: t.clock });
  await blobs.put("vod/v-pkg/master.m3u8", FIXTURE_MASTER_PLAYLIST);
  await blobs.put("vod/v-pkg/720p/seg-1.m4s", new Uint8Array(4096).fill(7));
  const read = blobs.get.bind(blobs);
  let masterReads = 0;
  blobs.get = async (key, options) => {
    // The first read of the master never completes: its request is gone.
    if (key === "vod/v-pkg/master.m3u8" && ++masterReads === 1) return new Promise(() => {});
    return read(key, options);
  };
  const app = createApp({
    config: t.deps.config,
    services: t.services,
    blobs,
    rateLimiter: new MemoryRateLimiter({ clock: t.clock }),
    clock: t.clock,
    ids: t.deps.ids,
    logger: t.logger,
  });
  let cookie = "";
  const api = createRouteClient(routes, {
    headers: () => new Headers(cookie ? { Cookie: cookie } : {}),
    fetch: async (url, init) => {
      const response = await app.request(url, init);
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";")[0] ?? "";
        if (pair.startsWith("webflix_session=")) cookie = pair;
      }
      return response;
    },
  });
  await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
  await api.selectProfile({ body: { profileId: "pr-demo" } });
  const session = await api.createPlaybackSession({ body: { titleId: "t-orbit" } });
  const segment = session.manifestUrl.replace("master.m3u8", "720p/seg-1.m4s");

  const controller = new AbortController();
  const abandoned = app.request(segment, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const second = await Promise.race([
    app.request(segment),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
  ]);
  expect(second).not.toBe("hung");
  expect((second as Response).status).toBe(200);
  expect(masterReads).toBe(2);
  void Promise.resolve(abandoned).catch(() => undefined);
});
