/** Media delivery: ranges, validators, HEAD, token checks and caching (blueprint §2.4). */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createTestApp,
  type Device,
  onboard,
  SEGMENT_BYTES,
  SEGMENT_PATH,
  type TestApp,
} from "./support.ts";

let t: TestApp;
let device: Device;
let manifestUrl: string;
let segmentUrl: string;

beforeEach(async () => {
  t = await createTestApp();
  ({ device } = await onboard(t, { email: "media@example.com", planId: "premium" }));
  const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
  manifestUrl = playback.manifestUrl;
  segmentUrl = manifestUrl.replace("master.m3u8", SEGMENT_PATH);
});

const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

describe("/media/{token}/vod/...", () => {
  it("serves whole segments with validators and private caching bounded by the token", async () => {
    const response = await t.request(segmentUrl);
    expect(response.status).toBe(200);
    expect(await bytes(response)).toEqual(SEGMENT_BYTES);
    expect(response.headers.get("Content-Length")).toBe("10000");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("video/iso.segment");
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
    expect(response.headers.get("Last-Modified")).toMatch(/GMT$/);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("answers byte ranges: bounded, open-ended and suffix", async () => {
    const bounded = await t.request(segmentUrl, { headers: { Range: "bytes=100-199" } });
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get("Content-Range")).toBe("bytes 100-199/10000");
    expect(bounded.headers.get("Content-Length")).toBe("100");
    expect(await bytes(bounded)).toEqual(SEGMENT_BYTES.slice(100, 200));

    const open = await t.request(segmentUrl, { headers: { Range: "bytes=9990-" } });
    expect(open.headers.get("Content-Range")).toBe("bytes 9990-9999/10000");
    expect(await bytes(open)).toEqual(SEGMENT_BYTES.slice(9990));

    const suffix = await t.request(segmentUrl, { headers: { Range: "bytes=-5" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe("bytes 9995-9999/10000");
    expect(await bytes(suffix)).toEqual(SEGMENT_BYTES.slice(9995));

    const past = await t.request(segmentUrl, { headers: { Range: "bytes=10000-" } });
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */10000");
    expect(await past.json()).toMatchObject({ code: "range_not_satisfiable", size: 10000 });

    // Multi-range and malformed headers are ignored: the whole object.
    const multi = await t.request(segmentUrl, { headers: { Range: "bytes=0-1,5-6" } });
    expect(multi.status).toBe(200);
  });

  it("revalidates with If-None-Match and honours If-Range", async () => {
    const first = await t.request(segmentUrl);
    const etag = first.headers.get("ETag") ?? "";
    await first.body?.cancel();

    const cached = await t.request(segmentUrl, { headers: { "If-None-Match": etag } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("ETag")).toBe(etag);
    expect(await cached.text()).toBe("");
    expect(
      (await t.request(segmentUrl, { headers: { "If-None-Match": `"other", W/${etag}` } })).status,
    ).toBe(304);
    expect((await t.request(segmentUrl, { headers: { "If-None-Match": "*" } })).status).toBe(304);
    expect((await t.request(segmentUrl, { headers: { "If-None-Match": '"stale"' } })).status).toBe(
      200,
    );

    const sameVersion = await t.request(segmentUrl, {
      headers: { Range: "bytes=0-9", "If-Range": etag },
    });
    expect(sameVersion.status).toBe(206);
    const changed = await t.request(segmentUrl, {
      headers: { Range: "bytes=0-9", "If-Range": '"old"' },
    });
    expect(changed.status).toBe(200);
    expect(await bytes(changed)).toEqual(SEGMENT_BYTES);
  });

  it("answers HEAD with headers only", async () => {
    const response = await t.request(segmentUrl, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10000");
    expect(await response.text()).toBe("");
  });

  it("rejects bad, foreign and expired tokens", async () => {
    const tampered = manifestUrl.replace(
      /\/media\/([^/]+)\//,
      (_, token: string) => `/media/${token.slice(0, -2)}xx/`,
    );
    const bad = await t.request(tampered);
    expect(bad.status).toBe(403);
    expect((await bad.json()).code).toBe("media_token_invalid");

    // A token is bound to its asset.
    const otherAsset = segmentUrl.replace("/vod/v-pkg/", "/vod/v-ext/");
    expect((await (await t.request(otherAsset)).json()).code).toBe("media_token_invalid");

    expect((await t.request("/media/x/vod/../../etc/passwd")).status).toBe(404);

    t.clock.advance(t.deps.config.media.tokenTtlSec * 1000 + 1000);
    const expired = await t.request(segmentUrl);
    expect(expired.status).toBe(403);
    expect((await expired.json()).code).toBe("media_token_expired");
  });

  it("never logs the token", async () => {
    await t.request(segmentUrl, { headers: { Range: "bytes=0-0" } });
    const token = manifestUrl.split("/")[2] ?? "";
    expect(token.length).toBeGreaterThan(20);
    const logged = JSON.stringify(t.logger.records);
    expect(logged).toContain("/media/:token/vod/v-pkg/720p/seg0.m4s");
    expect(logged).not.toContain(token);
  });
});

describe("/cdn/*", () => {
  it("serves public blobs with immutable caching, ignoring the query string", async () => {
    const response = await t.request("/cdn/img/titles/t-orbit/card-320.webp?v=abc123");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("ETag")).toMatch(/^".+"$/);
    expect((await bytes(response)).byteLength).toBe(2000);

    const ranged = await t.request("/cdn/img/titles/t-orbit/card-320.webp", {
      headers: { Range: "bytes=0-9" },
    });
    expect(ranged.status).toBe(206);
  });

  it("answers 404 problems for missing and unsafe paths, without caching them", async () => {
    const missing = await t.request("/cdn/img/titles/nope.webp");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toBe("application/problem+json");
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect((await t.request("/cdn/../vod/v-pkg/master.m3u8")).status).toBe(404);
    expect((await t.request("/cdn/")).status).toBe(404);
  });
});
