import type { PlaybackState } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import type { Viewer } from "../../src/index.ts";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  type TestServices,
} from "../../src/testing/index.ts";
import { demoViewer } from "./helpers.ts";

/**
 * The Continue Watching rule set (docs/RECOMMENDATIONS.md, "Continue Watching and play
 * targets"), branch by branch. Every case also checks that `GET /continue-watching`, the home
 * `continue` row, the title detail's play target and Play itself agree.
 *
 * Fixture series used here (nothing in the demo profile's seeded history), whose episodes play
 * the fixture's 600 s external stream:
 * - The Starlings: S1E1, S1E2, S2E1, S2E2 (the finale).
 * - Wild Coasts: S1E1..S1E3.
 */
const S1E1 = "t-starlings-s1e1";
const S1E2 = "t-starlings-s1e2";
const S2E1 = "t-starlings-s2e1";
const FINALE = "t-starlings-s2e2";

interface Watch {
  episodeId?: string;
  /** Where the member stopped; "end" for the end of the stream. */
  positionSec: number | "end";
  state?: PlaybackState;
}

/** Start, watch up to `positionSec` (one heartbeat a minute of real time later), stop. */
async function watch(t: TestServices, viewer: Viewer, titleId: string, step: Watch) {
  const session = await t.services.playback.start(viewer, {
    titleId,
    ...(step.episodeId ? { episodeId: step.episodeId } : {}),
  });
  t.clock.advance(60_000);
  await t.services.playback.heartbeat(viewer, session.id, {
    positionSec: step.positionSec === "end" ? session.durationSec : step.positionSec,
    durationSec: session.durationSec,
    state: step.state ?? "playing",
  });
  await t.services.playback.end(viewer, session.id);
  t.clock.advance(60_000);
}

const finish = (episodeId: string): Watch => ({ episodeId, positionSec: "end", state: "ended" });

async function continueItem(t: TestServices, viewer: Viewer, titleId: string) {
  const list = await t.services.library.continueWatching(viewer);
  return list.items.find((item) => item.title.id === titleId) ?? null;
}

/**
 * `GET /continue-watching`, the home `continue` row, every listed title's play target and Play
 * itself describe the same episode and position.
 */
async function expectAgreement(t: TestServices, viewer: Viewer): Promise<void> {
  const list = await t.services.library.continueWatching(viewer);
  const home = await t.services.browse.getBrowse(viewer, "home", undefined);
  const row = home.rows.find((candidate) => candidate.layout === "continue");
  if (list.items.length === 0) {
    expect(row).toBeUndefined();
    return;
  }
  expect(row?.layout).toBe("continue");
  if (row?.layout !== "continue") return;
  expect(row.items).toEqual(list.items.slice(0, row.items.length));

  for (const item of list.items) {
    const detail = await t.services.browse.getTitle(viewer, item.title.id);
    expect(detail.playTarget?.episode?.id ?? null, `${item.title.id} play target episode`).toBe(
      item.episode?.id ?? null,
    );
    expect(detail.playTarget?.positionSec, `${item.title.id} play target position`).toBe(
      item.progress.positionSec,
    );
    expect(detail.playTarget?.action).toBe(item.progress.positionSec > 0 ? "resume" : "play");
    const session = await t.services.playback.start(viewer, { titleId: item.title.id });
    expect(session.episodeId, `${item.title.id} Play episode`).toBe(item.episode?.id ?? null);
    expect(session.resumePositionSec, `${item.title.id} Play position`).toBe(
      item.progress.positionSec,
    );
    await t.services.playback.end(viewer, session.id);
  }
}

describe("Continue Watching rules", () => {
  it("keeps a series whose next episode was barely started, pointing at that episode", async () => {
    // The reported defect: S1E1 watched to the end, autoplay starts S1E2, the member leaves 2 s in.
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await watch(t, viewer, "t-starlings", finish(S1E1));
    await watch(t, viewer, "t-starlings", { episodeId: S1E2, positionSec: 2 });

    const item = await continueItem(t, viewer, "t-starlings");
    expect(item?.episode?.id).toBe(S1E2);
    expect(item?.progress.positionSec).toBe(0);
    // Ordered by the latest activity on the title: it was watched a moment ago.
    expect((await t.services.library.continueWatching(viewer)).items[0]?.title.id).toBe(
      "t-starlings",
    );
    await expectAgreement(t, viewer);
  });

  it("offers the next episode from the start after a finished episode", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await watch(t, viewer, "t-wild", finish("t-wild-s1e1"));
    const item = await continueItem(t, viewer, "t-wild");
    expect(item?.episode?.id).toBe("t-wild-s1e2");
    expect(item?.progress).toMatchObject({ positionSec: 0, completed: false });
    await expectAgreement(t, viewer);
  });

  it("leaves out a title that was only sampled, and plays it from the start", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    // A few seconds of a brand new series and of a movie are not "watching" yet.
    await watch(t, viewer, "t-wild", { episodeId: "t-wild-s1e1", positionSec: 12 });
    await watch(t, viewer, "t-lowlands", { positionSec: 20 });

    expect(await continueItem(t, viewer, "t-wild")).toBeNull();
    expect(await continueItem(t, viewer, "t-lowlands")).toBeNull();
    const series = await t.services.browse.getTitle(viewer, "t-wild");
    expect(series.playTarget).toMatchObject({
      action: "play",
      episode: { id: "t-wild-s1e1" },
      positionSec: 0,
    });
    const movie = await t.services.browse.getTitle(viewer, "t-lowlands");
    expect(movie.playTarget).toMatchObject({ action: "play", positionSec: 0, progress: null });
    expect(movie.viewer.progress).toBeNull();
    const session = await t.services.playback.start(viewer, { titleId: "t-lowlands" });
    expect(session.resumePositionSec).toBe(0);
    await t.services.playback.end(viewer, session.id);

    // Thirty seconds in, it is in progress.
    await watch(t, viewer, "t-wild", { episodeId: "t-wild-s1e1", positionSec: 30 });
    expect((await continueItem(t, viewer, "t-wild"))?.progress.positionSec).toBe(30);
    await expectAgreement(t, viewer);
  });

  it("drops a series once its finale is finished and offers it in Watch It Again", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await watch(t, viewer, "t-starlings", { episodeId: S2E1, positionSec: 240 });
    expect((await continueItem(t, viewer, "t-starlings"))?.episode?.id).toBe(S2E1);
    await watch(t, viewer, "t-starlings", finish(FINALE));

    expect(await continueItem(t, viewer, "t-starlings")).toBeNull();
    const home = await t.services.browse.getBrowse(viewer, "home", undefined);
    const rows = [...home.rows];
    let cursor = home.nextCursor;
    while (cursor) {
      const next = await t.services.browse.getBrowse(viewer, "home", cursor);
      rows.push(...next.rows);
      cursor = next.nextCursor;
    }
    const again = rows.find((row) => row.kind === "watch-again");
    expect(again?.items.map((card) => ("id" in card ? card.id : null))).toContain("t-starlings");
    // Play starts the series over.
    const detail = await t.services.browse.getTitle(viewer, "t-starlings");
    expect(detail.playTarget).toMatchObject({
      action: "play",
      episode: { id: S1E1 },
      positionSec: 0,
    });
    await expectAgreement(t, viewer);
  });

  it("follows a rewatch of an earlier episode", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await watch(t, viewer, "t-starlings", finish(S1E1));
    await watch(t, viewer, "t-starlings", { episodeId: S1E2, positionSec: 240 });

    // A few seconds of S1E1 again changes nothing: still S1E2 where it was left.
    await watch(t, viewer, "t-starlings", { episodeId: S1E1, positionSec: 3 });
    let item = await continueItem(t, viewer, "t-starlings");
    expect(item?.episode?.id).toBe(S1E2);
    expect(item?.progress.positionSec).toBe(240);
    await expectAgreement(t, viewer);

    // Really rewatching S1E1: that is what the member is in the middle of now.
    await watch(t, viewer, "t-starlings", { episodeId: S1E1, positionSec: 150 });
    item = await continueItem(t, viewer, "t-starlings");
    expect(item?.episode?.id).toBe(S1E1);
    expect(item?.progress.positionSec).toBe(150);
    await expectAgreement(t, viewer);

    // Rewatched to the end: back to S1E2 where it was left.
    await watch(t, viewer, "t-starlings", finish(S1E1));
    item = await continueItem(t, viewer, "t-starlings");
    expect(item?.episode?.id).toBe(S1E2);
    expect(item?.progress.positionSec).toBe(240);
    await expectAgreement(t, viewer);
  });

  it("recomputes the resume point when an episode is removed from viewing activity", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await watch(t, viewer, "t-starlings", finish(S1E1));
    await watch(t, viewer, "t-starlings", { episodeId: S1E2, positionSec: 240 });
    const history = await t.services.library.history(viewer, undefined, 50);
    const entry = (episodeId: string) =>
      history.items.find((candidate) => candidate.episode?.id === episodeId)?.id ?? "";

    await t.services.library.removeHistoryEntry(viewer, entry(S1E2));
    const item = await continueItem(t, viewer, "t-starlings");
    expect(item?.episode?.id).toBe(S1E2);
    expect(item?.progress.positionSec).toBe(0);
    await expectAgreement(t, viewer);

    await t.services.library.removeHistoryEntry(viewer, entry(S1E1));
    expect(await continueItem(t, viewer, "t-starlings")).toBeNull();
    expect((await t.services.browse.getTitle(viewer, "t-starlings")).playTarget).toMatchObject({
      action: "play",
      episode: { id: S1E1 },
      positionSec: 0,
    });
    await expectAgreement(t, viewer);
  });

  it("brings a removed title back only when it is watched again for real", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    await watch(t, viewer, "t-starlings", finish(S1E1));
    await watch(t, viewer, "t-starlings", { episodeId: S1E2, positionSec: 240 });
    await t.services.library.removeFromContinueWatching(viewer, "t-starlings");
    expect(await continueItem(t, viewer, "t-starlings")).toBeNull();
    await expectAgreement(t, viewer);

    // A few seconds of playback is not "watching again".
    await watch(t, viewer, "t-starlings", { episodeId: S2E1, positionSec: 4 });
    expect(await continueItem(t, viewer, "t-starlings")).toBeNull();

    await watch(t, viewer, "t-starlings", { episodeId: S1E2, positionSec: 360 });
    const item = await continueItem(t, viewer, "t-starlings");
    expect(item?.episode?.id).toBe(S1E2);
    expect(item?.progress.positionSec).toBe(360);
    await expectAgreement(t, viewer);
  });

  it("agrees on the seeded demo profile (movies, series in progress, next episodes)", async () => {
    const t = await createTestServices();
    await expectAgreement(t, await demoViewer(t));
  });

  it("resumes short items exactly where Continue Watching says, up to the credits", async () => {
    // Fast-profile media is a few minutes long: the resume point must not depend on a fixed
    // tail that is longer than the part counted as "finished".
    const t = await createTestServices({
      seed: {
        catalog: FIXTURE_CATALOG,
        demoAccount: FIXTURE_DEMO_ACCOUNT,
        manifest: {
          ...FIXTURE_MANIFEST,
          videoAssets: FIXTURE_MANIFEST.videoAssets.map((asset) => ({
            ...asset,
            durationSec: 150,
          })),
        },
      },
    });
    const viewer = await demoViewer(t);
    // The Quiet Orbit plays the packaged fixture asset (finished in the seeded history).
    await watch(t, viewer, "t-orbit", { positionSec: 130 });
    const item = await continueItem(t, viewer, "t-orbit");
    expect(item?.progress).toMatchObject({ positionSec: 130, durationSec: 150 });
    await expectAgreement(t, viewer);
  });
});
