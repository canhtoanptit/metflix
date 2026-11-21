import { parseMediaPath } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { capMasterPlaylist, dayStart, renditionsAboveCap, utcDay } from "../../src/index.ts";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_EXTERNAL_URL,
  FIXTURE_MASTER_PLAYLIST,
} from "../../src/testing/index.ts";
import {
  APPROVED_CARD,
  authOf,
  demoViewer,
  memberViewer,
  openLogin,
  uncharged,
} from "./helpers.ts";

describe("playback sessions", () => {
  it("starts a packaged movie with a signed manifest, tracks, trick-play and markers", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-orbit" });
    const media = parseMediaPath(session.manifestUrl);
    expect(media).toMatchObject({ assetId: "v-pkg", key: "vod/v-pkg/master.m3u8" });
    expect(session.textTracks).toHaveLength(1);
    expect(parseMediaPath(session.textTracks[0]?.url ?? "")?.key).toBe("vod/v-pkg/subs/en.vtt");
    expect(session.trickPlay?.sheets).toHaveLength(1);
    expect(session.markers).toEqual({
      intro: { startSec: 5, endSec: 35 },
      recap: null,
      creditsStartSec: 5200,
    });
    expect(session).toMatchObject({
      titleId: "t-orbit",
      episodeId: null,
      durationSec: 5400,
      // Finished before: starts over.
      resumePositionSec: 0,
      maxVideoHeight: 2160,
      heartbeatIntervalSec: 30,
      nextEpisode: null,
      display: { titleName: "The Quiet Orbit", titleType: "movie", maturity: "13+" },
    });
    expect(Date.parse(session.expiresAt)).toBe(
      t.clock.now() + t.deps.config.media.tokenTtlSec * 1000,
    );
  });

  it("resumes series where the profile left off and announces the next episode", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-kestrel" });
    expect(session.episodeId).toBe("t-kestrel-s1e2");
    // Seeded at 30% of the packaged stream (90 min).
    expect(session.resumePositionSec).toBe(1620);
    expect(session.nextEpisode?.episode).toMatchObject({ seasonNumber: 1, number: 3 });
    expect(session.nextEpisode?.synopsis).toContain("Season 1, episode 3");
    const fromStart = await t.services.playback.start(viewer, {
      titleId: "t-kestrel",
      episodeId: "t-kestrel-s1e2",
      startPositionSec: 0,
    });
    expect(fromStart.resumePositionSec).toBe(0);
  });

  it("falls back to external HLS and refuses unplayable media", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const external = await t.services.playback.start(viewer, { titleId: "t-harvest" });
    expect(external.manifestUrl).toBe(FIXTURE_EXTERNAL_URL);
    expect(external.textTracks).toEqual([]);
    expect(external.trickPlay).toBeNull();
    await expect(t.services.playback.start(viewer, { titleId: "t-nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      t.services.playback.start(viewer, { titleId: "t-kestrel", episodeId: "t-signal-s1e1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const kids = await demoViewer(t, "pr-kids");
    await expect(t.services.playback.start(kids, { titleId: "t-ferry" })).rejects.toMatchObject({
      code: "maturity_restricted",
    });
  });

  it("answers media_unavailable when nothing can be streamed", async () => {
    const t = await createTestServices({
      seed: {
        catalog: {
          ...FIXTURE_CATALOG,
          videoAssets: FIXTURE_CATALOG.videoAssets.map((asset) => ({
            ...asset,
            externalHlsUrl: null,
          })),
        },
        demoAccount: FIXTURE_DEMO_ACCOUNT,
        manifest: null,
      },
    });
    const viewer = await demoViewer(t);
    await expect(t.services.playback.start(viewer, { titleId: "t-harvest" })).rejects.toMatchObject(
      {
        code: "media_unavailable",
      },
    );
    expect((await t.services.browse.getTitle(viewer, "t-harvest")).playTarget).toBeNull();
  });

  it("enforces the plan's stream limit per device and lists active streams", async () => {
    const t = await createTestServices();
    const issued = await t.services.auth.signup(
      {
        email: "basic@example.com",
        password: "long-enough",
        planId: "basic",
        payment: APPROVED_CARD,
      },
      { userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/130.0" },
    );
    const auth = await authOf(t, issued.token);
    const profile = await t.services.profiles.create(
      auth,
      { name: "Me", avatarId: "av-fox" },
      uncharged,
    );
    await t.services.auth.selectProfile(auth, { profileId: profile.id }, uncharged);
    const viewerA = await authOf(t, issued.token);
    if (!viewerA.profile) throw new Error("no profile");
    const a = { session: viewerA.session, profile: viewerA.profile };

    const second = await t.services.auth.login(
      { email: "basic@example.com", password: "long-enough" },
      { userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0) Safari/604.1" },
      openLogin,
    );
    const authB = await authOf(t, second.token);
    await t.services.auth.selectProfile(authB, { profileId: profile.id }, uncharged);
    const viewerB = await authOf(t, second.token);
    if (!viewerB.profile) throw new Error("no profile");
    const b = { session: viewerB.session, profile: viewerB.profile };

    const first = await t.services.playback.start(a, { titleId: "t-orbit" });
    // The same device may switch titles: its previous stream is replaced, not counted twice.
    const switched = await t.services.playback.start(a, { titleId: "t-glasshouse" });
    await expect(
      t.services.playback.heartbeat(a, first.id, {
        positionSec: 10,
        durationSec: 5400,
        state: "playing",
      }),
    ).rejects.toMatchObject({ code: "playback_session_ended" });

    await expect(t.services.playback.start(b, { titleId: "t-orbit" })).rejects.toMatchObject({
      code: "stream_limit_reached",
      extensions: {
        limit: 1,
        activeStreams: [
          {
            playbackSessionId: switched.id,
            deviceLabel: "Firefox on Windows",
            titleName: "Glasshouse",
          },
        ],
      },
    });

    // Stopping frees the slot.
    await t.services.playback.end(a, switched.id);
    await t.services.playback.start(b, { titleId: "t-orbit" });
  });

  it("keeps the slot alive with heartbeats, records progress and ends revoked sessions", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-glasshouse" });
    t.clock.advance(30_000);
    const ack = await t.services.playback.heartbeat(viewer, session.id, {
      positionSec: 30,
      durationSec: 5400,
      state: "playing",
    });
    expect(ack.heartbeatIntervalSec).toBe(30);
    const cw = await t.services.library.continueWatching(viewer);
    expect(cw.items[0]?.title.id).toBe("t-glasshouse");
    expect(cw.items[0]?.progress.positionSec).toBe(30);

    // Missing heartbeats past the lease TTL frees the slot; the next heartbeat ends playback.
    t.clock.advance((t.deps.config.playback.leaseTtlSec + 1) * 1000);
    await expect(
      t.services.playback.heartbeat(viewer, session.id, {
        positionSec: 60,
        durationSec: 5400,
        state: "playing",
      }),
    ).rejects.toMatchObject({ code: "playback_session_ended" });
    await expect(
      t.services.playback.heartbeat(viewer, "ps-unknown", {
        positionSec: 1,
        durationSec: 1,
        state: "playing",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("marks an item completed at the end, which moves a series on to the next episode", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-kestrel" });
    await t.services.playback.heartbeat(viewer, session.id, {
      positionSec: 1800,
      durationSec: 1800,
      state: "ended",
    });
    const cw = await t.services.library.continueWatching(viewer);
    const kestrel = cw.items.find((item) => item.title.id === "t-kestrel");
    expect(kestrel?.episode).toMatchObject({ seasonNumber: 1, number: 3 });
    expect(kestrel?.progress.positionSec).toBe(0);
  });

  it("authorises media: stateless segments, playlists only while the slot is held", async () => {
    const t = await createTestServices();
    const viewer = await demoViewer(t);
    const session = await t.services.playback.start(viewer, { titleId: "t-orbit" });
    const media = parseMediaPath(session.manifestUrl);
    if (!media) throw new Error("unsigned manifest");

    const playlist = await t.services.playback.authorizeMedia(
      media.token,
      "v-pkg",
      "vod/v-pkg/master.m3u8",
    );
    expect(playlist.maxVideoHeight).toBe(2160);
    const segment = await t.services.playback.authorizeMedia(
      media.token,
      "v-pkg",
      "vod/v-pkg/720p/seg-1.m4s",
    );
    // The plan's cap travels in the token: segments are checked against it without a lookup.
    expect(segment.maxVideoHeight).toBe(2160);
    await expect(
      t.services.playback.authorizeMedia(media.token, "v-other", "vod/v-other/master.m3u8"),
    ).rejects.toMatchObject({ code: "media_token_invalid" });
    await expect(
      t.services.playback.authorizeMedia(`${media.token}x`, "v-pkg", "vod/v-pkg/master.m3u8"),
    ).rejects.toMatchObject({ code: "media_token_invalid" });

    await t.services.auth.logout(await authOf(t, viewer.token));
    await expect(
      t.services.playback.authorizeMedia(media.token, "v-pkg", "vod/v-pkg/master.m3u8"),
    ).rejects.toMatchObject({ code: "playback_session_ended" });
    // Segments stay valid until the token expires (FOUNDATION §6 decision).
    await t.services.playback.authorizeMedia(media.token, "v-pkg", "vod/v-pkg/720p/seg-2.m4s");
    t.clock.advance(t.deps.config.media.tokenTtlSec * 1000 + 1);
    await expect(
      t.services.playback.authorizeMedia(media.token, "v-pkg", "vod/v-pkg/720p/seg-2.m4s"),
    ).rejects.toMatchObject({ code: "media_token_expired" });
  });

  it("caps the master playlist at the plan's height", () => {
    const capped = capMasterPlaylist(FIXTURE_MASTER_PLAYLIST, 720);
    expect(capped).toContain("480p/index.m3u8");
    expect(capped).toContain("720p/index.m3u8");
    expect(capped).not.toContain("1080p");
    expect(capMasterPlaylist(FIXTURE_MASTER_PLAYLIST, 2160)).toBe(FIXTURE_MASTER_PLAYLIST);
    // Never empty: if every variant is too tall, the shortest survives.
    const lowest = capMasterPlaylist(FIXTURE_MASTER_PLAYLIST, 240);
    expect(lowest).toContain("480p/index.m3u8");
    expect(lowest).not.toContain("720p");
    const media = "#EXTM3U\n#EXTINF:4,\nseg-1.m4s\n";
    expect(capMasterPlaylist(media, 240)).toBe(media);
  });

  it("lists the rendition directories above the cap, the ones the capped master leaves out", () => {
    expect(renditionsAboveCap(FIXTURE_MASTER_PLAYLIST, 720)).toEqual(["1080p/"]);
    expect(renditionsAboveCap(FIXTURE_MASTER_PLAYLIST, 2160)).toEqual([]);
    expect(renditionsAboveCap(FIXTURE_MASTER_PLAYLIST, 240)).toEqual(["720p/", "1080p/"]);
    const mixed = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",URI="audio/index.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x818",
      "video/1080.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x546",
      "video/720.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=3840x1634",
      "2160p/index.m3u8",
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,RESOLUTION=3840x1634,URI="trick/2160/iframes.m3u8"',
    ].join("\n");
    // A directory that also holds an allowed rendition cannot be refused as a whole.
    expect(renditionsAboveCap(mixed, 1080)).toEqual(["2160p/", "trick/2160/"]);
    expect(renditionsAboveCap("#EXTM3U\n#EXTINF:4,\nseg-1.m4s\n", 240)).toEqual([]);
  });

  it("refuses playback once the membership has ended", async () => {
    const t = await createTestServices();
    const viewer = await memberViewer(t);
    await t.services.account.cancel(viewer.session.accountId);
    t.clock.advance(31 * 24 * 3600_000);
    await expect(t.services.playback.start(viewer, { titleId: "t-orbit" })).rejects.toMatchObject({
      code: "subscription_required",
      extensions: { subscriptionStatus: "ended" },
    });
  });
});

describe("stats jobs", () => {
  it("rolls real playback into daily stats through the job queue", async () => {
    const t = await createTestServices({ seed: undefined });
    const viewer = await demoViewer(t);
    const before =
      (await t.deps.repos.stats.dailyViews(utcDay(t.clock.now()))).find(
        (row) => row.titleId === "t-wild",
      )?.views ?? 0;

    const session = await t.services.playback.start(viewer, { titleId: "t-wild" });
    for (let beat = 1; beat <= 3; beat += 1) {
      t.clock.advance(30_000);
      await t.services.playback.heartbeat(viewer, session.id, {
        positionSec: 30 * beat,
        durationSec: 1800,
        state: "playing",
      });
    }
    await t.services.playback.end(viewer, session.id);
    t.clock.advance(10_000);
    await t.queue.drain();
    expect(t.queue.deadLetters).toEqual([]);

    const after = (await t.deps.repos.stats.dailyViews(utcDay(t.clock.now()))).find(
      (row) => row.titleId === "t-wild",
    )?.views;
    expect(after).toBe(before + 1);
  });

  it("rolls up a session replaced by the same device starting another title", async () => {
    const t = await createTestServices({ seed: undefined });
    const viewer = await demoViewer(t);
    const viewsOf = async (titleId: string) =>
      (await t.deps.repos.stats.dailyViews(utcDay(t.clock.now()))).find(
        (row) => row.titleId === titleId,
      )?.views ?? 0;
    const before = await viewsOf("t-wild");
    const first = await t.services.playback.start(viewer, { titleId: "t-wild" });
    for (let beat = 1; beat <= 3; beat += 1) {
      t.clock.advance(30_000);
      await t.services.playback.heartbeat(viewer, first.id, {
        positionSec: 30 * beat,
        durationSec: 1800,
        state: "playing",
      });
    }
    // The same device moves on: the first session ends without a release of its own.
    await t.services.playback.start(viewer, { titleId: "t-orbit" });
    t.clock.advance(10_000);
    await t.queue.drain();
    expect(t.queue.deadLetters).toEqual([]);
    expect(await viewsOf("t-wild")).toBe(before + 1);
  });

  it("schedules baseline, rollups and cleanup idempotently", async () => {
    const t = await createTestServices();
    t.clock.set(dayStart(utcDay(t.clock.now())) + 2 * 24 * 3600_000 + 60_000);
    const today = utcDay(t.clock.now());
    expect(await t.deps.repos.stats.hasBaseline(today)).toBe(false);
    await t.services.scheduler.tick();
    await t.services.scheduler.tick();
    await t.queue.drain();
    expect(t.queue.deadLetters).toEqual([]);
    expect(await t.deps.repos.stats.hasBaseline(today)).toBe(true);
    const rows = (await t.deps.repos.stats.dailyViews(today)).filter((row) => row.day === today);
    expect(rows.length).toBeGreaterThan(10);
  });
});
