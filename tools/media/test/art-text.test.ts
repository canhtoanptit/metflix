import { catalog, openFilms } from "@webflix/catalog";
import type { TitleSeed } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { stillCandidateTimes } from "../src/art/run.ts";
import { checkArtFrames } from "../src/review/art-text.ts";

describe("text-free key art", () => {
  it("passes the catalog's real-film frames", () => {
    const report = checkArtFrames(catalog.titles, catalog.videoAssets, openFilms);
    expect(report.problems).toEqual([]);
    expect(report.checked).toBeGreaterThanOrEqual(22);
  });

  it("flags a key frame on a title card, or on on-screen story text", () => {
    const tears = catalog.titles.find((title) => title.id === "t-tears-of-steel") as TitleSeed;
    const at = (key: number) => ({ ...tears, art: { frames: { key, poster: 342 } } }) as TitleSeed;
    expect(checkArtFrames([at(67)], catalog.videoAssets, openFilms).problems[0]).toMatch(
      /key frame at 67 s/,
    );
    // 296 s: the PLAYBACK console of the old key art.
    expect(checkArtFrames([at(296)], catalog.videoAssets, openFilms).problems).toHaveLength(1);
    expect(checkArtFrames([at(287)], catalog.videoAssets, openFilms).problems).toEqual([]);
  });

  it("picks episode stills of real films only among text-free candidates", () => {
    const film = openFilms.find((entry) => entry.key === "tears-of-steel");
    const times = stillCandidateTimes(0, 734, film);
    expect(times.length).toBeGreaterThan(0);
    // 0.2 of the film is 146.8 s (clean); 0.44 is 323 s, on the 322–324 s holographic caption.
    expect(times).toContain(734 * 0.2);
    expect(times).not.toContain(734 * 0.44);
  });
});
