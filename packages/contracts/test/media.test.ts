import { describe, expect, it } from "vitest";
import { makeImageSet, makePlaybackSession } from "../src/fixtures/index.ts";
import {
  ArtworkImage,
  artworkToImageSet,
  BlobKey,
  blobKeyForCdnPath,
  blobKeyProblem,
  blobKeys,
  cdnUrlForBlobKey,
  effectiveVideoQuality,
  fillImageTemplate,
  ImageSet,
  imageSrcSet,
  imageUrl,
  MAX_BLOB_KEY_BYTES,
  mediaUrlForBlobKey,
  nominalVideoHeight,
  parseMediaPath,
  pickImageWidth,
  trickPlayTile,
  VIDEO_QUALITY_TIERS,
  videoQualityForHeight,
  videoQualityLabel,
} from "../src/index.ts";

describe("image sets", () => {
  const set = makeImageSet({
    template: "/cdn/img/titles/t1/card-{width}.{format}",
    widths: [320, 640],
  });

  it("builds variant URLs and srcset", () => {
    expect(imageUrl(set, 640, "webp")).toBe("/cdn/img/titles/t1/card-640.webp");
    expect(imageSrcSet(set, "avif")).toBe(
      "/cdn/img/titles/t1/card-320.avif 320w, /cdn/img/titles/t1/card-640.avif 640w",
    );
  });

  it("picks the smallest sufficient width", () => {
    expect(pickImageWidth(set, 300, 1)).toBe(320);
    expect(pickImageWidth(set, 300, 2)).toBe(640);
    expect(pickImageWidth(set, 2000, 2)).toBe(640);
  });

  it("rejects templates without placeholders and unsorted widths", () => {
    expect(ImageSet.safeParse({ ...set, template: "/cdn/a.webp" }).success).toBe(false);
    expect(ImageSet.safeParse({ ...set, widths: [640, 320] }).success).toBe(false);
  });
});

describe("blob layout", () => {
  it("maps public keys to CDN URLs and back", () => {
    const key = fillImageTemplate(blobKeys.titleImageTemplate("t1", "poster"), 400, "avif");
    expect(key).toBe("public/img/titles/t1/poster-400.avif");
    expect(cdnUrlForBlobKey(key)).toBe("/cdn/img/titles/t1/poster-400.avif");
    expect(blobKeyForCdnPath("/cdn/img/titles/t1/poster-400.avif")).toBe(key);
    expect(blobKeyForCdnPath("/api/v1/session")).toBeNull();
    for (const bad of ["/cdn/", "/cdn//a", "/cdn/a//b", "/cdn/a/../b", "/cdn/./a"]) {
      expect(blobKeyForCdnPath(bad), bad).toBeNull();
    }
    expect(() => cdnUrlForBlobKey("vod/a/master.m3u8")).toThrow();
  });

  it("round-trips protected media paths", () => {
    const url = mediaUrlForBlobKey("tok.sig", "vod/a1/720p/seg-001.m4s");
    expect(url).toBe("/media/tok.sig/vod/a1/720p/seg-001.m4s");
    expect(parseMediaPath(url)).toEqual({
      token: "tok.sig",
      assetId: "a1",
      key: "vod/a1/720p/seg-001.m4s",
    });
  });

  it("refuses traversal and malformed media paths", () => {
    expect(parseMediaPath("/media/t/vod/a1/../b2/master.m3u8")).toBeNull();
    expect(parseMediaPath("/media/t/vod/a1//x")).toBeNull();
    expect(parseMediaPath("/media/t/public/a1/x")).toBeNull();
    expect(parseMediaPath("/media/%E0%A4%A/vod/a1/x")).toBeNull();
  });

  it("refuses every path a blob store would refuse as a key (404, never a 500)", () => {
    const tooLong = `a/${"x".repeat(MAX_BLOB_KEY_BYTES)}`;
    const bad = ["x/", "a\\b", "a\u0000b", "a\u001fb", "a\u007fb", tooLong, `${"é".repeat(520)}`];
    for (const rest of bad) {
      expect(blobKeyForCdnPath(`/cdn/${rest}`), JSON.stringify(rest)).toBeNull();
      expect(parseMediaPath(`/media/t/vod/a1/${rest}`), JSON.stringify(rest)).toBeNull();
      expect(blobKeyProblem(`public/${rest}`), JSON.stringify(rest)).not.toBeNull();
    }
    expect(
      blobKeyForCdnPath(`/cdn/${"x".repeat(MAX_BLOB_KEY_BYTES - "public/".length)}`),
    ).not.toBeNull();
    expect(blobKeyProblem("public/img/a.webp")).toBeNull();
  });

  it("validates blob keys", () => {
    expect(BlobKey.safeParse("vod/a1/master.m3u8").success).toBe(true);
    expect(BlobKey.safeParse("vod/../secret").success).toBe(false);
    expect(BlobKey.safeParse("/public/x").success).toBe(false);
    expect(BlobKey.safeParse("other/x").success).toBe(false);
  });

  it("turns packaged artwork into a cache-busted ImageSet", () => {
    const artwork = ArtworkImage.parse({
      keyTemplate: blobKeys.titleImageTemplate("t1", "card"),
      widths: [320, 640],
      formats: ["avif", "webp"],
      aspectRatio: 16 / 9,
      dominantColor: "#102030",
      thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
      version: "a1b2c3d4",
    });
    const set = ImageSet.parse(artworkToImageSet(artwork));
    expect(imageUrl(set, 320, "avif")).toBe("/cdn/img/titles/t1/card-320.avif?v=a1b2c3d4");
  });
});

describe("trick-play", () => {
  const trickPlay = makePlaybackSession().trickPlay;
  if (!trickPlay) throw new Error("fixture has trick-play");

  it("locates the tile for a position", () => {
    // 10 columns x 10 rows per sheet, 10 s interval: 1234 s → index 123 → sheet 1, cell 23.
    expect(trickPlayTile(trickPlay, 1234)).toEqual({
      sheetUrl: trickPlay.sheets[1],
      x: 3 * 240,
      y: 2 * 135,
      width: 240,
      height: 135,
    });
  });

  it("clamps past the last thumbnail and rejects negatives", () => {
    expect(trickPlayTile(trickPlay, 99_999)?.sheetUrl).toBe(trickPlay.sheets[2]);
    expect(trickPlayTile(trickPlay, -1)).toBeNull();
  });
});

describe("video quality", () => {
  it("names renditions after the 16:9 frame they fill", () => {
    expect(nominalVideoHeight(1920, 1080)).toBe(1080);
    expect(nominalVideoHeight(1920, 800)).toBe(1080);
    expect(nominalVideoHeight(1280, 536)).toBe(720);
    expect(nominalVideoHeight(1440, 1080)).toBe(1080);
    expect(nominalVideoHeight(3840, 1600)).toBe(2160);
    expect(nominalVideoHeight(960, 540)).toBe(540);
  });

  it("uses exact height thresholds and one set of labels", () => {
    const cases = [
      [0, "sd", "SD"],
      [719, "sd", "SD"],
      [720, "hd", "HD"],
      [1079, "hd", "HD"],
      [1080, "full-hd", "Full HD"],
      [2159, "full-hd", "Full HD"],
      [2160, "4k", "4K"],
      [4320, "4k", "4K"],
    ] as const;
    for (const [height, tier, label] of cases) {
      expect(videoQualityForHeight(height), String(height)).toBe(tier);
      expect(videoQualityLabel(tier)).toBe(label);
    }
    expect(VIDEO_QUALITY_TIERS).toEqual(["sd", "hd", "full-hd", "4k"]);
  });

  it("shows the lower of the title's best quality and the plan's cap", () => {
    expect(effectiveVideoQuality("4k", 720)).toBe("hd");
    expect(effectiveVideoQuality("4k", 1080)).toBe("full-hd");
    expect(effectiveVideoQuality("4k", 2160)).toBe("4k");
    expect(effectiveVideoQuality("hd", 2160)).toBe("hd");
    expect(effectiveVideoQuality("sd", 720)).toBe("sd");
    // Unknown (external media): nothing to promise.
    expect(effectiveVideoQuality(undefined, 2160)).toBeNull();
    expect(effectiveVideoQuality(null, 720)).toBeNull();
  });
});
