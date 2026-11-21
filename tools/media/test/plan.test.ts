import { catalog, openFilms } from "@webflix/catalog";
import { describe, expect, it } from "vitest";
import { PROFILES } from "../src/profiles.ts";
import { markersFor, planAssets, previewWindow, profileWindow } from "../src/video/plan.ts";

const planned = planAssets(catalog);
const byId = new Map(planned.map((asset) => [asset.seed.id, asset]));
const sintel = openFilms.find((film) => film.key === "sintel");
if (!sintel) throw new Error("missing Sintel");
const facts = { ...sintel };

function asset(id: string) {
  const found = byId.get(id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("video plan", () => {
  it("classifies every seed asset by how titles use it", () => {
    expect(planned).toHaveLength(catalog.videoAssets.length);
    expect(asset("v-sintel").role).toBe("film");
    expect(asset("v-sintel-cut").role).toBe("film");
    expect(asset("v-sintel-ep1").role).toBe("episode");
    const preview = planned.find((entry) => entry.role === "preview");
    expect(preview?.previewed).toBe(true);
  });

  it("gives every title a previewed asset, motion art naming its own title", () => {
    for (const title of catalog.titles) {
      const preview = asset(title.previewAssetId ?? "");
      expect(preview.previewed, title.id).toBe(true);
      if (preview.seed.source.kind === "synthetic") expect(preview.artTitleId).toBe(title.id);
    }
    expect(planned.filter((entry) => entry.artTitleId).length).toBeGreaterThan(50);
  });

  it("clips windows per profile and role", () => {
    expect(profileWindow(asset("v-sintel"), 888, PROFILES.fast)).toEqual({
      startSec: 0,
      durationSec: 150,
    });
    // Feature cuts (what fictional movies play) are long enough to leave in progress.
    expect(asset("v-sintel-cut").feature).toBe(true);
    expect(asset("v-sintel").feature).toBe(false);
    expect(profileWindow(asset("v-sintel-cut"), 888, PROFILES.fast)).toEqual({
      startSec: 101,
      durationSec: 210,
    });
    expect(profileWindow(asset("v-sintel"), 888, PROFILES.full)).toEqual({
      startSec: 0,
      durationSec: 888,
    });
    expect(profileWindow(asset("v-sintel-cut"), 888, PROFILES.full)).toEqual({
      startSec: 101,
      durationSec: 642,
    });
    expect(profileWindow(asset("v-sintel-ep2"), 888, PROFILES.fast)).toEqual({
      startSec: 242,
      durationSec: 75,
    });
  });

  it("previews a window inside the packaged clip", () => {
    const chapter = asset("v-sintel-ep2");
    const window = { startSec: 242, durationSec: 188 };
    const preview = previewWindow({ ...chapter, previewed: true }, window, PROFILES.full);
    expect(preview?.durationSec).toBe(30);
    expect(preview?.startSec).toBeGreaterThan(242);
    expect(previewWindow({ ...chapter, previewed: false }, window, PROFILES.full)).toBeNull();
  });

  it("marks only what is on screen", () => {
    // The real film: its own opening titles and credits.
    expect(markersFor(asset("v-sintel"), { startSec: 0, durationSec: 888 }, facts)).toEqual({
      intro: { startSec: 1, endSec: 25 },
      recap: null,
      creditsStartSec: 743,
    });
    // Fast clips the film before the credits: no credits marker.
    expect(
      markersFor(asset("v-sintel"), { startSec: 0, durationSec: 150 }, facts).creditsStartSec,
    ).toBeNull();
    // The text-free cut has no title sequence and no credits.
    expect(markersFor(asset("v-sintel-cut"), { startSec: 101, durationSec: 642 }, facts)).toEqual({
      intro: null,
      recap: null,
      creditsStartSec: null,
    });
    // A later chapter opens with the last 20 s of the one before: a real recap.
    expect(markersFor(asset("v-sintel-ep2"), { startSec: 242, durationSec: 75 }, facts)).toEqual({
      intro: null,
      recap: { startSec: 0, endSec: 20 },
      creditsStartSec: null,
    });
    expect(
      markersFor(asset("v-sintel-ep1"), { startSec: 101, durationSec: 161 }, facts).recap,
    ).toBeNull();
    // Previews carry no markers.
    const preview = planned.find((entry) => entry.role === "preview");
    if (preview)
      expect(markersFor(preview, { startSec: 0, durationSec: 16 }, facts)).toEqual({
        intro: null,
        recap: null,
        creditsStartSec: null,
      });
  });
});
