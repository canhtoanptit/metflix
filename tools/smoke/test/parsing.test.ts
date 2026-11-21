import { describe, expect, it } from "vitest";
import { checkIsoBmff, checkMediaBody, checkMpegTs } from "../src/container.ts";
import { CookieJar, isExpiring, parseSetCookie } from "../src/cookies.ts";
import { parseMaster, parseMediaPlaylist, resolveUri } from "../src/hls.ts";
import { admissible } from "../src/limits.ts";
import { parseCli, parseRateLimits, UsageError } from "../src/options.ts";

describe("cookies", () => {
  it("parses attributes and flags", () => {
    const cookie = parseSetCookie(
      "webflix_session=abc; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
    );
    expect(cookie).toEqual({
      name: "webflix_session",
      value: "abc",
      attributes: { "max-age": "2592000", path: "/", httponly: "", samesite: "Lax" },
    });
  });

  it("stores, sends and expires cookies like a browser", () => {
    const jar = new CookieJar();
    jar.store(["a=1; Path=/", "b=2; Max-Age=60"], 1000);
    expect(jar.header(1000)).toBe("a=1; b=2");
    expect(jar.header(1000 + 61_000)).toBe("a=1");
    jar.store(["a=; Max-Age=0"], 2000);
    expect(jar.header(2000)).toBeNull();
    expect(
      isExpiring(
        parseSetCookie("x=; Expires=Thu, 01 Jan 1970 00:00:00 GMT") ?? {
          name: "",
          value: "",
          attributes: {},
        },
      ),
    ).toBe(true);
  });
});

describe("hls", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Original",LANGUAGE="en",URI="audio/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1762713,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x546,AUDIO="aac"',
    "720p/index.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=433223,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=480x204,AUDIO="aac"',
    "270p/index.m3u8",
  ].join("\n");

  it("parses variants with quoted, comma-bearing attributes", () => {
    const parsed = parseMaster(master);
    expect(
      parsed.variants.map((variant) => [variant.uri, variant.height, variant.bandwidth]),
    ).toEqual([
      ["720p/index.m3u8", 546, 1762713],
      ["270p/index.m3u8", 204, 433223],
    ]);
    expect(parsed.variants[0]?.attributes.CODECS).toBe("avc1.64001f,mp4a.40.2");
    expect(parsed.media).toEqual([{ type: "AUDIO", uri: "audio/index.m3u8", language: "en" }]);
  });

  it("parses media playlists", () => {
    const playlist = parseMediaPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nseg_0.m4s\n#EXTINF:2.5,\nseg_1.m4s\n#EXT-X-ENDLIST\n',
    );
    expect(playlist).toEqual({
      segments: [
        { uri: "seg_0.m4s", durationSec: 4 },
        { uri: "seg_1.m4s", durationSec: 2.5 },
      ],
      map: "init.mp4",
      targetDurationSec: 4,
      endList: true,
    });
  });

  it("resolves relative URIs under the signed path (the token is inherited)", () => {
    expect(resolveUri("/media/tok%2Ben/vod/v-a/master.m3u8", "720p/index.m3u8")).toBe(
      "/media/tok%2Ben/vod/v-a/720p/index.m3u8",
    );
    expect(resolveUri("/media/t/vod/v-a/720p/index.m3u8", "../audio/seg.m4s")).toBe(
      "/media/t/vod/v-a/audio/seg.m4s",
    );
    expect(resolveUri("/x/master.m3u8", "https://cdn.example/a.m3u8")).toBe(
      "https://cdn.example/a.m3u8",
    );
  });
});

function box(type: string, payload: number): Uint8Array {
  const bytes = new Uint8Array(8 + payload);
  new DataView(bytes.buffer).setUint32(0, 8 + payload);
  bytes.set(
    [...type].map((char) => char.charCodeAt(0)),
    4,
  );
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("container integrity", () => {
  const segment = concat(box("styp", 8), box("moof", 40), box("mdat", 500));

  it("accepts boxes that tile the body", () => {
    expect(checkIsoBmff(segment)).toEqual({ ok: true, boxes: ["styp", "moof", "mdat"] });
    expect(checkMediaBody("seg_1.m4s", segment)?.ok).toBe(true);
    expect(checkMediaBody("init.mp4", concat(box("ftyp", 12), box("moov", 100)))?.ok).toBe(true);
  });

  it("detects truncation and garbage", () => {
    const truncated = segment.subarray(0, segment.byteLength - 100);
    expect(checkMediaBody("seg_1.m4s", truncated)?.problem).toMatch(/'mdat' .* truncated/);
    expect(
      checkMediaBody("seg_1.m4s", new TextEncoder().encode("<html>not found</html>"))?.ok,
    ).toBe(false);
    expect(checkMediaBody("seg_1.m4s", concat(box("styp", 8), box("free", 4)))?.problem).toMatch(
      /moof\/mdat/,
    );
    expect(checkMpegTs(new Uint8Array(188 * 2).fill(0x47)).ok).toBe(true);
    expect(checkMpegTs(new Uint8Array(300).fill(0x47)).ok).toBe(false);
    expect(checkMediaBody("sub.vtt", new Uint8Array(4))).toBeNull();
  });
});

describe("options", () => {
  it("applies defaults", () => {
    const { options } = parseCli(["--base-url", "http://localhost:4000/"], {});
    expect(options.baseUrl).toBe("http://localhost:4000");
    expect(options.concurrency).toBe(4);
    expect(options.rateLimits).toEqual({ mode: "auto" });
    expect(options.allowIpExhaustion).toBe(true);
  });

  it("parses lists, flags and rate-limit specs", () => {
    const { options } = parseCli(
      [
        "-u",
        "https://x.test",
        "--only",
        "identity,media.*",
        "--only",
        "plans",
        "--no-ip-exhaustion",
        "--rate-limits",
        "profile-pin=10/60,auth=3/30",
      ],
      {},
    );
    expect(options.only).toEqual(["identity", "media.*", "plans"]);
    expect(options.allowIpExhaustion).toBe(false);
    expect(options.rateLimits).toEqual({
      mode: "custom",
      limits: { "profile-pin": { limit: 10, windowSec: 60 }, auth: { limit: 3, windowSec: 30 } },
    });
  });

  it("rejects bad input", () => {
    expect(() => parseCli([], {})).toThrow(UsageError);
    expect(() => parseCli(["-u", "ftp://x"], {})).toThrow(UsageError);
    expect(() => parseCli(["-u", "http://x", "--concurrency", "0"], {})).toThrow(UsageError);
    expect(() => parseRateLimits("bogus=1/2")).toThrow(UsageError);
    expect(parseCli([], { SMOKE_BASE_URL: "http://env.test" }).options.baseUrl).toBe(
      "http://env.test",
    );
  });

  it("computes the admissible burst with refill", () => {
    expect(admissible({ limit: 5, windowSec: 60 }, 500)).toEqual({ min: 5, max: 5 });
    expect(admissible({ limit: 5, windowSec: 60 }, 12_500)).toEqual({ min: 5, max: 6 });
    expect(admissible({ limit: 60, windowSec: 60 }, 2500)).toEqual({ min: 60, max: 62 });
  });
});
