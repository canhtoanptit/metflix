import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { avcCodecString, PROFILES } from "../src/profiles.ts";
import { buildMasterPlaylist, measurePlaylist } from "../src/video/hls.ts";
import { ladderFor, trickPlayInterval } from "../src/video/package.ts";

describe("HLS", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webflix-media-hls-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("measures peak and average bandwidth from segment sizes", async () => {
    await writeFile(join(dir, "seg_0.m4s"), new Uint8Array(500_000));
    await writeFile(join(dir, "seg_1.m4s"), new Uint8Array(250_000));
    await writeFile(
      join(dir, "index.m3u8"),
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000000,\nseg_0.m4s\n#EXTINF:2.000000,\nseg_1.m4s\n#EXT-X-ENDLIST\n',
    );
    const stats = await measurePlaylist(join(dir, "index.m3u8"));
    expect(stats).toEqual({
      durationSec: 6,
      peakBps: 1_000_000,
      averageBps: 1_000_000,
      bytes: 750_000,
      segments: 2,
    });
  });

  it("writes a master with a demuxed audio group and sorted variants", () => {
    const stats = { durationSec: 10, peakBps: 1000, averageBps: 800, bytes: 1000, segments: 3 };
    const master = buildMasterPlaylist(
      [
        {
          uri: "480p/index.m3u8",
          width: 854,
          height: 364,
          frameRate: 24,
          videoCodec: "avc1.64001e",
          stats,
        },
        {
          uri: "720p/index.m3u8",
          width: 1280,
          height: 546,
          frameRate: 24,
          videoCodec: "avc1.64001f",
          stats: { ...stats, peakBps: 3000 },
        },
      ],
      {
        uri: "audio/index.m3u8",
        language: "en",
        name: "Original",
        codec: "mp4a.40.2",
        channels: 2,
        stats,
      },
      null,
    );
    const lines = master.split("\n");
    expect(lines).toContain(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Original",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/index.m3u8"',
    );
    const variants = lines.filter((line) => line.startsWith("#EXT-X-STREAM-INF"));
    expect(variants[0]).toContain("BANDWIDTH=4000,");
    expect(variants[0]).toContain('CODECS="avc1.64001f,mp4a.40.2"');
    expect(variants[0]).toContain('AUDIO="aac"');
    expect(variants[1]).toContain("RESOLUTION=854x364");
    expect(master).not.toContain("SUBTITLES");
  });

  it("derives codec strings, ladders and trick-play intervals", () => {
    expect(avcCodecString("4.0")).toBe("avc1.640028");
    expect(avcCodecString("3.1")).toBe("avc1.64001f");
    // Never upscale: a 1024-wide source (Elephants Dream) tops out at the 960-wide rung.
    expect(ladderFor(PROFILES.full.ladder, 1024).map((rung) => rung.id)).toEqual([
      "540p",
      "360p",
      "240p",
    ]);
    expect(ladderFor(PROFILES.fast.ladder, 320).map((rung) => rung.id)).toEqual(["270p"]);
    expect(trickPlayInterval(150)).toBe(2);
    expect(trickPlayInterval(888)).toBe(9);
    expect(trickPlayInterval(3600)).toBe(10);
  });
});
