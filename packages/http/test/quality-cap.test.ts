/**
 * The plan's quality cap covers every rendition: the master playlist leaves taller variants
 * out, and their playlists and segments are refused (`media_quality_restricted`) even when a
 * player asks for them by URL. The cap travels in the media token, so segments are checked
 * without a database read.
 */
import { createHmacTokenSigner } from "@webflix/core";
import { FIXTURE_PACKAGED_ASSET } from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import { createTestApp, onboard, type TestApp } from "./support.ts";

const VOD = `vod/${FIXTURE_PACKAGED_ASSET}`;

async function withTallRendition(t: TestApp): Promise<void> {
  await t.blobs.put(
    `${VOD}/1080p/index.m3u8`,
    "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.m4s\n#EXT-X-ENDLIST\n",
  );
  await t.blobs.put(`${VOD}/1080p/seg0.m4s`, new Uint8Array(64));
}

async function codeOf(response: Response): Promise<string | number> {
  return response.ok ? response.status : ((await response.json()) as { code: string }).code;
}

describe("the plan's quality cap", () => {
  it("refuses renditions above a Basic plan's 720p, by playlist and by segment", async () => {
    const t = await createTestApp();
    await withTallRendition(t);
    const { device } = await onboard(t, { email: "basic@example.com", planId: "basic" });
    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const url = (path: string) => playback.manifestUrl.replace("master.m3u8", path);

    const master = await (await t.request(playback.manifestUrl)).text();
    expect(master).toContain("720p/index.m3u8");
    expect(master).not.toContain("1080p");
    expect(await codeOf(await t.request(url("720p/index.m3u8")))).toBe(200);
    expect(await codeOf(await t.request(url("720p/seg0.m4s")))).toBe(200);
    expect(await codeOf(await t.request(url("1080p/index.m3u8")))).toBe("media_quality_restricted");
    const segment = await t.request(url("1080p/seg0.m4s"));
    expect(segment.status).toBe(403);
    expect(await codeOf(segment)).toBe("media_quality_restricted");
    expect((await t.request(url("1080p/seg0.m4s"), { method: "HEAD" })).status).toBe(403);
    // Shared files (subtitles) are not renditions.
    expect(await codeOf(await t.request(url("subs/en.vtt")))).toBe(200);
  });

  it("serves every rendition to a plan that allows it", async () => {
    const t = await createTestApp();
    await withTallRendition(t);
    const { device } = await onboard(t, { email: "premium@example.com", planId: "premium" });
    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const url = (path: string) => playback.manifestUrl.replace("master.m3u8", path);
    expect(await (await t.request(playback.manifestUrl)).text()).toContain("1080p/index.m3u8");
    expect(await codeOf(await t.request(url("1080p/index.m3u8")))).toBe(200);
    expect(await codeOf(await t.request(url("1080p/seg0.m4s")))).toBe(200);
  });

  it("checks segments without the database, from the token's claim", async () => {
    const t = await createTestApp();
    await withTallRendition(t);
    const { device } = await onboard(t, { email: "basic@example.com", planId: "basic" });
    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const url = (path: string) => playback.manifestUrl.replace("master.m3u8", path);
    const get = t.deps.repos.playback.get.bind(t.deps.repos.playback);
    let reads = 0;
    t.deps.repos.playback.get = async (id) => {
      reads += 1;
      return get(id);
    };
    expect(await codeOf(await t.request(url("1080p/seg0.m4s")))).toBe("media_quality_restricted");
    expect(await codeOf(await t.request(url("720p/seg0.m4s")))).toBe(200);
    expect(reads).toBe(0);
  });

  it("leaves tokens minted before the claim uncapped (they expire within the token lifetime)", async () => {
    const t = await createTestApp();
    await withTallRendition(t);
    const { device } = await onboard(t, { email: "legacy@example.com", planId: "basic" });
    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const signer = createHmacTokenSigner({ keys: t.deps.config.media.tokenKeys, clock: t.clock });
    const legacy = await signer.sign({
      purpose: "media",
      exp: Math.floor(t.clock.now() / 1000) + 600,
      a: FIXTURE_PACKAGED_ASSET,
      s: playback.id,
    });
    const response = await t.request(`/media/${legacy}/${VOD}/1080p/seg0.m4s`);
    expect(response.status).toBe(200);
  });
});
