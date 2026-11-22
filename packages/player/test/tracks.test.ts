import type { TextTrack } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  languageLabel,
  levelsAboveCap,
  menuTextTracks,
  qualityBadge,
  qualityOptions,
  selectTextTrack,
  sessionQualityLabel,
  titleQualityLimit,
} from "../src/core/tracks.ts";

const track = (id: string, language: string, extra: Partial<TextTrack> = {}): TextTrack => ({
  id,
  language,
  label: id,
  kind: "subtitles",
  url: `/subs/${id}.vtt`,
  default: false,
  forced: false,
  ...extra,
});

const tracks = [
  track("en", "en"),
  track("es", "es", { default: true }),
  track("pt-BR", "pt-BR"),
  track("en-forced", "en", { forced: true }),
];

describe("subtitle selection", () => {
  it("honours a language preference (exact, then primary subtag)", () => {
    expect(selectTextTrack(tracks, "es", "en")?.id).toBe("es");
    expect(selectTextTrack(tracks, "pt", "en")?.id).toBe("pt-BR");
    expect(selectTextTrack(tracks, "en-GB", "en")?.id).toBe("en");
  });
  it("uses the default track without a preference", () => {
    expect(selectTextTrack(tracks, undefined, "en")?.id).toBe("es");
  });
  it("shows forced narratives for the audio language when subtitles are off", () => {
    expect(selectTextTrack(tracks, null, "en")?.id).toBe("en-forced");
    expect(selectTextTrack(tracks, null, "es")).toBeNull();
    expect(selectTextTrack(tracks, "fr", "en")?.id).toBe("en-forced");
  });
  it("never lists forced tracks in the menu", () => {
    expect(menuTextTracks(tracks).map((t) => t.id)).toEqual(["en", "es", "pt-BR"]);
  });
  it("labels languages for humans", () => {
    expect(languageLabel("es", "en")).toBe("Spanish");
    expect(languageLabel("es", "es")).toBe("Español");
    expect(languageLabel("zz-invalid-tag-!!")).toBe("zz-invalid-tag-!!");
  });
});

describe("quality ladder under the plan cap", () => {
  const levels = [
    { id: 0, width: 640, height: 360, bitrate: 700_000 },
    { id: 1, width: 854, height: 480, bitrate: 1_200_000 },
    { id: 2, width: 1280, height: 720, bitrate: 3_000_000 },
    { id: 3, width: 1280, height: 720, bitrate: 2_000_000 },
    { id: 4, width: 1920, height: 1080, bitrate: 5_000_000 },
  ];

  it("offers one option per quality class within the cap, best class first", () => {
    expect(qualityOptions(levels, 720).map((o) => [o.label, o.id, o.quality])).toEqual([
      ["HD", 2, "hd"],
      ["SD", 1, "sd"],
    ]);
    expect(qualityOptions(levels, 2160).map((o) => o.label)).toEqual(["Full HD", "HD", "SD"]);
  });

  it("represents a class by its best rendition: tallest, then highest bitrate", () => {
    // 360p and 480p are both SD: one "SD" choice, the 480p rendition.
    expect(qualityOptions(levels, 480).map((o) => [o.label, o.id])).toEqual([["SD", 1]]);
    // Two 720p encodes are one "HD" choice, the higher bitrate.
    expect(qualityOptions(levels, 720)[0]?.id).toBe(2);
    // Scope renditions join their nominal class: 1920×800 is Full HD next to 1920×1080.
    const scope = [
      { id: 0, width: 1280, height: 536, bitrate: 2_500_000 },
      { id: 1, width: 1920, height: 800, bitrate: 4_500_000 },
    ];
    expect(qualityOptions(scope, 1080).map((o) => [o.label, o.id])).toEqual([
      ["Full HD", 1],
      ["HD", 0],
    ]);
  });

  it("never offers a class above the plan's", () => {
    // 1920×800 fits under a 900-line cap by height, but it is Full HD and the plan is HD.
    const scope = [
      { id: 0, width: 1280, height: 536, bitrate: 2_500_000 },
      { id: 1, width: 1920, height: 800, bitrate: 4_500_000 },
    ];
    expect(qualityOptions(scope, 900).map((o) => o.label)).toEqual(["HD"]);
  });

  it("names renditions in the shared vocabulary, by their nominal 16:9 height", () => {
    expect(qualityBadge({ width: 3840, height: 2160 })).toBe("4K");
    expect(qualityBadge({ width: 1920, height: 1080 })).toBe("Full HD");
    // Scope (2.39:1) renditions are shorter than their name: 1920×800 is 1080, 1280×536 is 720.
    expect(qualityBadge({ width: 1920, height: 800 })).toBe("Full HD");
    expect(qualityBadge({ width: 1280, height: 536 })).toBe("HD");
    expect(qualityBadge({ width: 854, height: 480 })).toBe("SD");
  });

  it("labels a session by the lower of the title's best quality and the plan's cap", () => {
    expect(sessionQualityLabel({ bestVideoQuality: "4k", maxVideoHeight: 2160 })).toBe("4K");
    expect(sessionQualityLabel({ bestVideoQuality: "4k", maxVideoHeight: 720 })).toBe("HD");
    expect(sessionQualityLabel({ bestVideoQuality: "hd", maxVideoHeight: 2160 })).toBe("HD");
    // External media: quality unknown, so no label rather than a guess.
    expect(sessionQualityLabel({ maxVideoHeight: 2160 })).toBeNull();
  });

  it("names the title's limit only when the title, not the plan, tops out lower", () => {
    expect(titleQualityLimit({ bestVideoQuality: "hd", maxVideoHeight: 2160 })).toBe("HD");
    expect(titleQualityLimit({ bestVideoQuality: "full-hd", maxVideoHeight: 2160 })).toBe(
      "Full HD",
    );
    expect(titleQualityLimit({ bestVideoQuality: "4k", maxVideoHeight: 720 })).toBeNull();
    expect(titleQualityLimit({ bestVideoQuality: "hd", maxVideoHeight: 720 })).toBeNull();
    expect(titleQualityLimit({ maxVideoHeight: 2160 })).toBeNull();
  });

  it("removes levels above the cap, highest index first", () => {
    expect(levelsAboveCap(levels, 720)).toEqual([4]);
    expect(levelsAboveCap(levels, 480)).toEqual([4, 3, 2]);
    expect(levelsAboveCap(levels, 4320)).toEqual([]);
  });

  it("never removes every level", () => {
    expect(levelsAboveCap(levels, 240)).toEqual([4, 3, 2, 1]);
  });
});
