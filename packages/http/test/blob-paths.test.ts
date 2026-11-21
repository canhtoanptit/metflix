/**
 * Media and CDN paths that no blob store would accept as a key answer 404 (never a 500 from the
 * store), and no log line carries a media token.
 */
import { describe, expect, it } from "vitest";
import { createTestApp, onboard } from "./support.ts";

describe("paths a blob store would refuse", () => {
  it("answer 404 under /cdn and /media", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "paths@example.com", planId: "premium" });
    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const media = (rest: string) => playback.manifestUrl.replace("master.m3u8", rest);
    const bad = ["a%5Cb.webp", "a%00b.webp", "a%1Fb.webp", "a%7Fb.webp", "x".repeat(1100)];
    for (const rest of bad) {
      const cdn = await t.request(`/cdn/img/${rest}`);
      expect(cdn.status, `/cdn/img/${rest.slice(0, 20)}`).toBe(404);
      expect(((await cdn.json()) as { code: string }).code).toBe("not_found");
      const protectedPath = await t.request(media(`720p/${rest}`));
      expect(protectedPath.status, `/media/…/720p/${rest.slice(0, 20)}`).toBe(404);
    }
    expect(t.logger.records.filter((record) => record.level === "error")).toEqual([]);
  });

  it("never log a media token, even for an unexpected failure", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "logs@example.com", planId: "premium" });
    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const token = playback.manifestUrl.split("/")[2] ?? "";
    expect(token.length).toBeGreaterThan(20);
    t.blobs.get = async () => {
      throw new Error("storage unavailable");
    };
    const response = await t.request(playback.manifestUrl.replace("master.m3u8", "720p/seg0.m4s"));
    expect(response.status).toBe(500);
    const logged = JSON.stringify(t.logger.records);
    expect(logged).toContain("http.unhandled_error");
    expect(logged).toContain("/media/:token/vod/");
    expect(logged).not.toContain(token);
  });
});
