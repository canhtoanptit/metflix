/**
 * What the API says about a title's media is what plays: durations of packaged titles and
 * episodes are their stream's (cards, detail, episode lists, playback sessions agree), the
 * catalogue runtime only stands in for external fallback media; previews say what they are.
 */
import { describe, expect, it } from "vitest";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  FIXTURE_PACKAGED_ASSET,
} from "../../src/testing/index.ts";
import { demoViewer } from "./helpers.ts";

const PLAYABLE_SEC = 183.4;

/** The fixture manifest with a short packaged stream whose preview is silent motion art. */
const manifest = {
  ...FIXTURE_MANIFEST,
  videoAssets: FIXTURE_MANIFEST.videoAssets.map((asset) =>
    asset.assetId === FIXTURE_PACKAGED_ASSET
      ? {
          ...asset,
          durationSec: PLAYABLE_SEC,
          preview: asset.preview
            ? { ...asset.preview, kind: "motion" as const, hasAudio: false }
            : null,
        }
      : asset,
  ),
};

async function services(withManifest = manifest) {
  return createTestServices({
    seed: { catalog: FIXTURE_CATALOG, demoAccount: FIXTURE_DEMO_ACCOUNT, manifest: withManifest },
  });
}

describe("durations", () => {
  it("are the playable stream's for a packaged movie, on every surface", async () => {
    const t = await services();
    const viewer = await demoViewer(t);
    const detail = await t.services.browse.getTitle(viewer, "t-orbit");
    expect(detail.runtimeSec).toBe(183);
    const genre = await t.services.browse.getGenrePage(viewer, "sci-fi", { limit: 50 });
    const card = genre.items.find((item) => item.id === "t-orbit");
    expect(card?.runtimeSec).toBe(183);
    const session = await t.services.playback.start(viewer, { titleId: "t-orbit" });
    expect(Math.abs(session.durationSec - (detail.runtimeSec ?? 0))).toBeLessThan(1);
  });

  it("are the playable stream's for a packaged episode; series cards carry no minutes", async () => {
    const t = await services();
    const viewer = await demoViewer(t);
    const detail = await t.services.browse.getTitle(viewer, "t-kestrel");
    expect(detail.runtimeSec).toBeNull();
    const episodes = await t.services.browse.listEpisodes(viewer, "t-kestrel", 1);
    const first = episodes.items[0];
    expect(first?.runtimeSec).toBe(183);
    const session = await t.services.playback.start(viewer, {
      titleId: "t-kestrel",
      episodeId: first?.id,
    });
    expect(Math.abs(session.durationSec - (first?.runtimeSec ?? 0))).toBeLessThan(1);
  });

  it("keep the catalogue runtime for external fallback media", async () => {
    const t = await services();
    const viewer = await demoViewer(t);
    const external = FIXTURE_CATALOG.titles.find((title) => title.id === "t-harvest");
    if (external?.type !== "movie") throw new Error("fixture");
    expect((await t.services.browse.getTitle(viewer, "t-harvest")).runtimeSec).toBe(
      external.runtimeSec,
    );
  });
});

describe("previews", () => {
  it("say whether they are footage or motion art, and whether they have sound", async () => {
    const t = await services();
    const viewer = await demoViewer(t);
    const preview = (await t.services.browse.getTitle(viewer, "t-orbit")).preview;
    expect(preview).toMatchObject({ kind: "motion", hasAudio: false });
  });

  it("are footage with sound when the manifest does not say", async () => {
    const t = await services(FIXTURE_MANIFEST);
    const viewer = await demoViewer(t);
    const preview = (await t.services.browse.getTitle(viewer, "t-orbit")).preview;
    expect(preview).toMatchObject({ kind: "footage", hasAudio: true });
  });
});
