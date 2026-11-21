/**
 * Real user journeys through the typed client against `createApp` on in-memory ports and the
 * fixture catalog. Every response is validated against the contract (`validateResponses`).
 */
import { ApiError, type Row, type TitleCard } from "@webflix/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APPROVED_CARD,
  CHROME_WINDOWS,
  createTestApp,
  DECLINED_CARD,
  DEMO,
  onboard,
  SAFARI_IPHONE,
  SEGMENT_BYTES,
  SEGMENT_PATH,
  signIn,
  type TestApp,
} from "./support.ts";

function cardsOf(row: Row): TitleCard[] {
  switch (row.layout) {
    case "ranked":
      return row.items.map((item) => item.title);
    case "continue":
      return row.items.map((item) => item.title);
    default:
      return row.items;
  }
}

async function expectProblem(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(ApiError.is(error), `expected ${code}, got ${String(error)}`).toBe(true);
  if (ApiError.is(error)) {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  }
  return error as ApiError;
}

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});

describe("sign up → profile → browse → play → heartbeat → continue watching", () => {
  it("runs the whole first-session journey", async () => {
    const device = t.device();

    // A declined card stops sign-up and creates nothing.
    const declined = await expectProblem(
      device.api.signup({
        body: {
          email: "new@example.com",
          password: "correct horse battery",
          planId: "standard",
          payment: DECLINED_CARD,
        },
      }),
      "payment_declined",
      402,
    );
    expect(declined.problem).toMatchObject({ declineReason: "card_declined" });
    expect((await device.api.getEmailStatus({ query: { email: "new@example.com" } })).next).toBe(
      "signup",
    );

    const session = await device.api.signup({
      body: {
        email: " New@Example.com ",
        password: "correct horse battery",
        planId: "standard",
        payment: APPROVED_CARD,
      },
    });
    expect(session).toMatchObject({
      authenticated: true,
      account: { email: "new@example.com" },
      subscription: { planId: "standard", status: "active" },
      plan: { id: "standard", maxStreams: 2 },
      profiles: [],
      activeProfile: null,
    });
    const cookie = device.setCookies.at(-1) ?? "";
    expect(cookie).toMatch(/^webflix_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/i);

    // Browse needs a profile.
    await expectProblem(device.api.getBrowse(), "profile_required", 403);
    const avatars = await device.api.listAvatars();
    expect(avatars.groups.length).toBeGreaterThan(0);
    const profile = await device.api.createProfile({ body: { name: "Ada", avatarId: "av-owl" } });
    expect(profile).toMatchObject({
      name: "Ada",
      isKids: false,
      maturityCeiling: "18+",
      isLocked: false,
    });
    const selected = await device.api.selectProfile({ body: { profileId: profile.id } });
    expect(selected.activeProfile?.id).toBe(profile.id);

    const home = await device.api.getBrowse({ query: { view: "home" } });
    expect(home.billboard).not.toBeNull();
    expect(home.rows.length).toBeGreaterThan(3);
    expect(home.rows.map((row) => row.kind)).toContain("top-10");
    // A brand-new profile has no taste yet: no match scores.
    expect(cardsOf(home.rows[0] as Row).every((card) => card.matchScore === null)).toBe(true);
    if (home.nextCursor) {
      const more = await device.api.getBrowse({ query: { view: "home", cursor: home.nextCursor } });
      expect(more.billboard).toBeNull();
    }
    const firstRow = home.rows[0] as Row;
    const paged = await device.api.getBrowseRow({
      params: { rowId: firstRow.id },
      query: { limit: 2 },
    });
    expect(paged.id).toBe(firstRow.id);

    const detail = await device.api.getTitle({ params: { id: "t-orbit" } });
    expect(detail).toMatchObject({
      id: "t-orbit",
      isPlayable: true,
      playTarget: { action: "play", positionSec: 0 },
      viewer: { inMyList: false, rating: null, progress: null },
    });
    expect(detail.images.card.template).toContain("?v=abc123");

    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    expect(playback.manifestUrl).toMatch(/^\/media\/[^/]+\/vod\/v-pkg\/master\.m3u8$/);
    expect(playback).toMatchObject({
      maxVideoHeight: 1080,
      resumePositionSec: 0,
      heartbeatIntervalSec: 30,
    });
    expect(playback.textTracks[0]?.url).toMatch(/^\/media\/[^/]+\/vod\/v-pkg\/subs\/en\.vtt$/);

    // The player fetches the master playlist and a segment through the same token.
    const master = await device.request(playback.manifestUrl);
    expect(master.status).toBe(200);
    expect(master.headers.get("Content-Type")).toBe("application/vnd.apple.mpegurl");
    expect(await master.text()).toContain("1080p/index.m3u8");
    const segmentUrl = playback.manifestUrl.replace("master.m3u8", SEGMENT_PATH);
    const segment = await device.request(segmentUrl, { headers: { Range: "bytes=0-99" } });
    expect(segment.status).toBe(206);
    expect(new Uint8Array(await segment.arrayBuffer())).toEqual(SEGMENT_BYTES.slice(0, 100));

    t.clock.advance(30_000);
    const ack = await device.api.sendHeartbeat({
      params: { id: playback.id },
      body: { positionSec: 600, durationSec: 5400, state: "playing" },
    });
    expect(ack.heartbeatIntervalSec).toBe(30);

    const continueWatching = await device.api.getContinueWatching();
    expect(continueWatching.items.map((item) => item.title.id)).toEqual(["t-orbit"]);
    expect(continueWatching.items[0]?.progress.positionSec).toBe(600);
    const resumed = await device.api.getTitle({ params: { id: "t-orbit" } });
    expect(resumed.playTarget).toMatchObject({ action: "resume", positionSec: 600 });
    const history = await device.api.getHistory();
    expect(history.items.map((entry) => entry.title.id)).toEqual(["t-orbit"]);

    await device.api.endPlaybackSession({ params: { id: playback.id } });
    await device.api.logout();
    // Only the "known device" note stays: this browser signed in to the account before.
    expect([...device.cookies.keys()]).toEqual(["webflix_device"]);
    expect((await device.api.getSession()).authenticated).toBe(false);
  });

  it("keeps My List, ratings and notifications per profile", async () => {
    const { device } = await onboard(t, { email: "lib@example.com" });
    await device.api.addToMyList({ params: { titleId: "t-orbit" } });
    await device.api.addToMyList({ params: { titleId: "t-orbit" } });
    await device.api.rateTitle({ params: { titleId: "t-grin" }, body: { value: "love" } });
    const list = await device.api.getMyList();
    expect(list.items.map((card) => card.id)).toEqual(["t-orbit"]);
    expect(list.items[0]?.viewer.inMyList).toBe(true);
    expect((await device.api.getTitle({ params: { id: "t-grin" } })).viewer.rating).toBe("love");
    await device.api.clearRating({ params: { titleId: "t-grin" } });
    await device.api.removeFromMyList({ params: { titleId: "t-orbit" } });
    expect((await device.api.getMyList()).items).toEqual([]);
    await expectProblem(
      device.api.addToMyList({ params: { titleId: "t-nope" } }),
      "not_found",
      404,
    );

    const notifications = await device.api.listNotifications();
    expect(notifications.unreadCount).toBeGreaterThan(0);
    await device.api.markNotificationsRead({ body: {} });
    expect((await device.api.listNotifications()).unreadCount).toBe(0);
  });
});

describe("stream limits", () => {
  it("enforces the plan's screens and revokes slots on sign-out and downgrade", async () => {
    const { device: phone, profileId } = await onboard(t, {
      email: "streams@example.com",
      planId: "basic",
      userAgent: SAFARI_IPHONE,
    });
    const laptop = await signIn(
      t,
      "streams@example.com",
      "correct horse battery",
      CHROME_WINDOWS,
      profileId,
    );

    const onPhone = await phone.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const blocked = await expectProblem(
      laptop.api.createPlaybackSession({ body: { titleId: "t-harvest" } }),
      "stream_limit_reached",
      409,
    );
    expect(blocked.problem).toMatchObject({
      limit: 1,
      activeStreams: [
        {
          playbackSessionId: onPhone.id,
          deviceLabel: "Safari on iPhone",
          titleName: "The Quiet Orbit",
        },
      ],
    });

    // The same device starting something else replaces its own stream.
    const replacement = await phone.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    await expectProblem(
      phone.api.sendHeartbeat({
        params: { id: onPhone.id },
        body: { positionSec: 10, durationSec: 5400, state: "playing" },
      }),
      "playback_session_ended",
      410,
    );

    // Signing out frees the slot; the old manifest URL stops working for new players.
    await phone.api.logout();
    const stale = await t.request(replacement.manifestUrl);
    expect(stale.status).toBe(410);
    expect((await stale.json()).code).toBe("playback_session_ended");
    const onLaptop = await laptop.api.createPlaybackSession({ body: { titleId: "t-harvest" } });
    expect(onLaptop.manifestUrl).toMatch(/^https:\/\//);

    // Upgrade to two screens, add a second stream, then downgrade: the newest one ends.
    await laptop.api.changePlan({ body: { planId: "standard" } });
    const tablet = await signIn(
      t,
      "streams@example.com",
      "correct horse battery",
      "Mozilla/5.0 (iPad; CPU OS 18_0) Safari/604.1",
      profileId,
    );
    const onTablet = await tablet.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const membership = await laptop.api.changePlan({ body: { planId: "basic" } });
    expect(membership.plan.maxStreams).toBe(1);
    await expectProblem(
      tablet.api.sendHeartbeat({
        params: { id: onTablet.id },
        body: { positionSec: 5, durationSec: 5400, state: "playing" },
      }),
      "playback_session_ended",
      410,
    );
    expect((await t.request(onTablet.manifestUrl)).status).toBe(410);
    const ack = await laptop.api.sendHeartbeat({
      params: { id: onLaptop.id },
      body: { positionSec: 5, durationSec: 600, state: "playing" },
    });
    expect(ack.heartbeatIntervalSec).toBe(30);
  });

  it("caps the master playlist at the plan's quality", async () => {
    const { device } = await onboard(t, { email: "basic@example.com", planId: "basic" });
    const playback = await device.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    expect(playback.maxVideoHeight).toBe(720);
    const master = await device.request(playback.manifestUrl);
    const text = await master.text();
    expect(text).toContain("720p/index.m3u8");
    expect(text).not.toContain("1080p");
    expect(master.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(master.headers.get("ETag")).toMatch(/^W\/".+-h720"$/);
  });
});

describe("profiles", () => {
  it("filters every surface for a kids profile", async () => {
    const device = await signIn(t, DEMO.email, DEMO.password, SAFARI_IPHONE, "pr-kids");
    const allowed = new Set(["ALL", "7+"]);
    let cursor: string | undefined;
    const seen: TitleCard[] = [];
    do {
      const page = await device.api.getBrowse({ query: { view: "home", cursor } });
      if (page.billboard) seen.push(page.billboard.title);
      for (const row of page.rows) seen.push(...cardsOf(row));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((card) => !allowed.has(card.maturity))).toEqual([]);

    const search = await device.api.search({ query: { q: "a" } });
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.filter((card) => !allowed.has(card.maturity))).toEqual([]);
    const restricted = await expectProblem(
      device.api.getTitle({ params: { id: "t-copper" } }),
      "maturity_restricted",
      403,
    );
    expect(restricted.problem).toMatchObject({ maturity: "18+", profileMaturityCeiling: "7+" });
    await expectProblem(
      device.api.createPlaybackSession({ body: { titleId: "t-hollow" } }),
      "maturity_restricted",
      403,
    );
  });

  it("guards PIN-locked profiles", async () => {
    const device = await signIn(t, DEMO.email, DEMO.password, SAFARI_IPHONE);
    const session = await device.api.getSession();
    expect(
      session.authenticated && session.profiles.find((p) => p.id === "pr-locked")?.isLocked,
    ).toBe(true);
    await expectProblem(
      device.api.selectProfile({ body: { profileId: "pr-locked" } }),
      "profile_pin_required",
      403,
    );
    await expectProblem(
      device.api.selectProfile({ body: { profileId: "pr-locked", pin: "0000" } }),
      "profile_pin_invalid",
      403,
    );
    const selected = await device.api.selectProfile({
      body: { profileId: "pr-locked", pin: "1234" },
    });
    expect(selected.activeProfile?.id).toBe("pr-locked");
    const cleared = await device.api.clearProfile();
    expect(cleared.activeProfile).toBeNull();
  });
});

describe("membership", () => {
  it("changes plans, keeping the old one when the card is declined", async () => {
    const { device } = await onboard(t, { email: "plans@example.com", planId: "basic" });
    const upgraded = await device.api.changePlan({ body: { planId: "standard" } });
    expect(upgraded.plan.id).toBe("standard");
    const declined = await expectProblem(
      device.api.changePlan({
        body: { planId: "premium", payment: { ...DECLINED_CARD, cardNumber: "4000000000009995" } },
      }),
      "payment_declined",
      402,
    );
    expect(declined.problem).toMatchObject({ declineReason: "insufficient_funds" });
    const account = await device.api.getAccount();
    expect(account.plan.id).toBe("standard");
    expect(account.paymentMethod).toMatchObject({ brand: "visa", last4: "4242" });

    const canceled = await device.api.cancelMembership();
    expect(canceled.subscription.status).toBe("canceling");
    const resumed = await device.api.resumeMembership();
    expect(resumed.subscription.status).toBe("active");
    const devices = await device.api.listDevices();
    expect(devices.items).toHaveLength(1);
    expect(devices.items[0]?.current).toBe(true);
  });
});

describe("guards", () => {
  it("requires the CSRF header on mutations", async () => {
    const response = await t.request("/api/v1/auth/logout", { method: "POST" });
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("csrf_check_failed");
  });

  it("requires a session on account routes", async () => {
    await expectProblem(t.device().api.getAccount(), "unauthenticated", 401);
  });

  it("clears a cookie that no longer maps to a session", async () => {
    const response = await t.request("/api/v1/session", {
      headers: { Cookie: `webflix_session=${"x".repeat(43)}` },
    });
    expect(await response.json()).toEqual({ authenticated: false });
    expect(response.headers.getSetCookie().join()).toMatch(/webflix_session=;.*Max-Age=0/);
  });

  it("rate limits email lookups per client address", async () => {
    const device = t.device();
    for (let index = 0; index < 20; index += 1) {
      await device.api.getEmailStatus({ query: { email: `x${index}@example.com` } });
    }
    const limited = await expectProblem(
      device.api.getEmailStatus({ query: { email: "y@example.com" } }),
      "rate_limited",
      429,
    );
    expect(limited.problem).toMatchObject({ retryAfterSec: expect.any(Number) });
    const raw = await t.request("/api/v1/auth/email-status?email=z@example.com");
    expect(raw.status).toBe(429);
    expect(Number(raw.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another address has its own budget.
    const other = await t.request("/api/v1/auth/email-status?email=z@example.com", {
      headers: { "X-Test-Ip": "198.51.100.1" },
    });
    expect(other.status).toBe(200);
  });

  it("signs in without remember-me as a browser-session cookie", async () => {
    const device = t.device();
    await device.api.login({ body: { ...DEMO, rememberMe: false } });
    expect(device.setCookies.at(-1)).not.toMatch(/Max-Age/i);
    await expectProblem(
      t.device().api.login({ body: { email: DEMO.email, password: "wrong-password" } }),
      "invalid_credentials",
      401,
    );
  });
});
