import type { TitleCard } from "@webflix/contracts";
import type { TestAccount } from "../env.ts";
import { check, equal, fail, problem, status, succeeds } from "../expect.ts";
import { parseMaster, parseMediaPlaylist, resolveUri } from "../hls.ts";
import type { Agent, HttpResult } from "../http.ts";
import { admissible, burst, expectedSpec } from "../limits.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, browseAll, CSRF, tallyStatuses } from "./util.ts";

/**
 * Behaviour that used to fail open: a quality cap that only filtered the master playlist,
 * path parsers that let a blob store answer 500, search that broke on long non-Latin words or
 * ignored a tampered cursor, an over-long password charged before it failed, browse batches
 * that skipped rows when the plan changed, an optional body that was not optional, and limits
 * that did not exist (playback starts, sign-ins per email address).
 */

/** The first packaged title with a rendition taller than `height`, as a Premium profile sees it. */
async function tallRendition(
  ctx: CheckContext,
  agent: Agent,
  height: number,
): Promise<{ card: TitleCard; playlist: string; segment: string } | null> {
  const { cards } = await ctx.env.catalog();
  const candidates = [...cards].sort(
    (a, b) => Number(b.type === "movie") - Number(a.type === "movie") || a.id.localeCompare(b.id),
  );
  for (const card of candidates.slice(0, 40)) {
    const session = await succeeds(
      () => agent.api.createPlaybackSession({ body: { titleId: card.id } }),
      `start ${card.id} (Premium)`,
    );
    try {
      if (!session.manifestUrl.startsWith("/media/")) continue;
      const master = parseMaster((await agent.fetch(session.manifestUrl)).text());
      const tall = master.variants.find((variant) => (variant.height ?? 0) > height);
      if (!tall) continue;
      const playlistUrl = resolveUri(session.manifestUrl, tall.uri);
      const media = parseMediaPlaylist((await agent.fetch(playlistUrl)).text());
      const first = media.map ?? media.segments[0]?.uri;
      if (!first) continue;
      const base = session.manifestUrl.slice(0, session.manifestUrl.lastIndexOf("/") + 1);
      const relative = (url: string) => url.slice(base.length);
      return {
        card,
        playlist: relative(playlistUrl),
        segment: relative(resolveUri(playlistUrl, first)),
      };
    } finally {
      await agent.api.endPlaybackSession({ params: { id: session.id } });
    }
  }
  return null;
}

/** A packaged title of `type`, its card, and a playback session of it (ended by the caller). */
async function packagedTitle(
  ctx: CheckContext,
  agent: Agent,
  type: TitleCard["type"],
): Promise<TitleCard | null> {
  const { cards } = await ctx.env.catalog();
  for (const card of cards.filter((candidate) => candidate.type === type).slice(0, 30)) {
    const session = await succeeds(
      () => agent.api.createPlaybackSession({ body: { titleId: card.id } }),
      `start ${card.id}`,
    );
    await agent.api.endPlaybackSession({ params: { id: session.id } });
    if (session.manifestUrl.startsWith("/media/")) return card;
  }
  return null;
}

export const hardeningChecks: CheckDefinition[] = [
  {
    id: "browse.durations-agree",
    area: "browse",
    title:
      "A packaged title's duration is its stream's everywhere: card, detail, episode list and playback session agree within a second",
    needs: [needs.packagedMedia],
    timeoutMs: 120_000,
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("durations");
      const api = viewer.agent.api;
      const near = (a: number | null | undefined, b: number, what: string) =>
        check(a !== null && a !== undefined && Math.abs(a - b) < 1, `${what} disagrees`, {
          expected: `${b} s (the playback session's duration)`,
          observed: `${a ?? "none"} s`,
        });
      const movie = await packagedTitle(ctx, viewer.agent, "movie");
      if (movie) {
        const session = await succeeds(
          () => api.createPlaybackSession({ body: { titleId: movie.id } }),
          `start ${movie.id}`,
        );
        await api.endPlaybackSession({ params: { id: session.id } });
        const detail = await succeeds(() => api.getTitle({ params: { id: movie.id } }), "detail");
        near(movie.runtimeSec, session.durationSec, `the card runtime of ${movie.id}`);
        near(detail.runtimeSec, session.durationSec, `the detail runtime of ${movie.id}`);
      }
      const series = await packagedTitle(ctx, viewer.agent, "series");
      if (series) {
        equal(series.runtimeSec, null, `the card runtime of series ${series.id}`);
        const detail = await succeeds(() => api.getTitle({ params: { id: series.id } }), "detail");
        equal(detail.runtimeSec, null, `the detail runtime of series ${series.id}`);
        const episodes = await succeeds(
          () => api.listEpisodes({ params: { id: series.id, seasonNumber: 1 } }),
          "episodes",
        );
        const episode = episodes.items.find((item) => item.isPlayable);
        check(episode, `${series.id} season 1 has no playable episode`);
        const session = await succeeds(
          () => api.createPlaybackSession({ body: { titleId: series.id, episodeId: episode.id } }),
          `start ${episode.id}`,
        );
        await api.endPlaybackSession({ params: { id: session.id } });
        if (session.manifestUrl.startsWith("/media/")) {
          near(episode.runtimeSec, session.durationSec, `the episode runtime of ${episode.id}`);
        }
      }
      if (!movie && !series) ctx.skip("no packaged movie or series found");
      ctx.note(`movie: ${movie?.id ?? "none"}; series: ${series?.id ?? "none"}`);
    },
  },
  {
    id: "playback.signout-stops-playback",
    area: "playback",
    title:
      "Signing out everywhere stops a device that is playing: its next heartbeat, playlist and start are refused, and its screen is free",
    async run(ctx: CheckContext) {
      const holder = await ctx.env.viewer("signout-playback", { plan: "basic" });
      const tv = await ctx.env.login(holder.account, "signout-tv");
      await ctx.env.selectProfile(tv, holder.profile.id);
      const fixture = await ctx.env.packagedPlayback();
      const titleId = fixture?.card.id ?? (await ctx.env.catalog()).cards[0]?.id;
      check(titleId, "the catalog is empty");
      const session = await succeeds(
        () => tv.api.createPlaybackSession({ body: { titleId } }),
        "the TV starts playing",
      );
      await succeeds(
        () =>
          tv.api.sendHeartbeat({
            params: { id: session.id },
            body: { positionSec: 5, durationSec: session.durationSec, state: "playing" },
          }),
        "a heartbeat while playing",
      );
      const packaged = session.manifestUrl.startsWith("/media/");
      if (packaged) status(await tv.fetch(session.manifestUrl), 200, "the master playlist");
      await succeeds(() => holder.agent.api.logoutAll(), "POST /auth/logout-all");
      const heartbeat = await tv.fetch(`${API}/playback/sessions/${session.id}/heartbeat`, {
        method: "POST",
        headers: CSRF,
        body: { positionSec: 10, durationSec: session.durationSec, state: "playing" },
      });
      problem(heartbeat, "unauthenticated", "the TV's next heartbeat");
      if (packaged) {
        problem(
          await tv.fetch(session.manifestUrl),
          "playback_session_ended",
          "the TV's next playlist",
        );
      }
      problem(
        await tv.fetch(`${API}/playback/sessions`, {
          method: "POST",
          headers: CSRF,
          body: { titleId },
        }),
        "unauthenticated",
        "the TV starting again",
      );
      // The plan's one screen is free: another device starts at once.
      const phone = await ctx.env.login(holder.account, "signout-phone");
      await ctx.env.selectProfile(phone, holder.profile.id);
      const next = await succeeds(
        () => phone.api.createPlaybackSession({ body: { titleId } }),
        "another device starting on the freed screen",
      );
      await phone.api.endPlaybackSession({ params: { id: next.id } });
    },
  },
  {
    id: "media.quality-cap",
    area: "media",
    title:
      "A plan's quality cap covers every rendition: taller playlists and segments are refused, not only left out of the master",
    needs: [needs.packagedMedia],
    timeoutMs: 120_000,
    async run(ctx: CheckContext) {
      const premium = await ctx.env.isolatedViewer("quality-premium");
      const found = await tallRendition(ctx, premium.agent, 720);
      if (!found) {
        ctx.skip(
          "no packaged title has a rendition above 720p, so the Basic cap cannot be crossed",
        );
      }
      const basic = await ctx.env.viewer("quality-basic", { plan: "basic" });
      const session = await succeeds(
        () => basic.agent.api.createPlaybackSession({ body: { titleId: found.card.id } }),
        `start ${found.card.id} (Basic)`,
      );
      try {
        const base = session.manifestUrl.slice(0, session.manifestUrl.lastIndexOf("/") + 1);
        const master = parseMaster((await basic.agent.fetch(session.manifestUrl)).text());
        check(
          master.variants.every((variant) => (variant.height ?? 0) <= 720),
          "the Basic master playlist lists a rendition above 720p",
          { observed: master.variants.map((variant) => variant.height).join(", ") },
        );
        const allowed = master.variants[0];
        if (allowed) {
          status(
            await basic.agent.fetch(resolveUri(session.manifestUrl, allowed.uri)),
            200,
            "a rendition within the cap",
          );
        }
        for (const path of [found.playlist, found.segment]) {
          const refused = await basic.agent.fetch(`${base}${path}`);
          problem(refused, "media_quality_restricted", `GET ${path} on a Basic plan`);
        }
        ctx.note(`${found.card.id}: ${found.playlist} and its first segment refused on Basic`);
      } finally {
        await basic.agent.api.endPlaybackSession({ params: { id: session.id } });
      }
    },
  },
  {
    id: "media.invalid-key-paths",
    area: "media",
    title:
      "Paths no blob store accepts as a key never reach one: the API answers 404 (a gateway may refuse control characters first), never a 5xx or content",
    async run(ctx: CheckContext) {
      // A backslash (a gateway may redirect to the unescaped path first: the redirect is
      // followed and the final answer must still be the API's 404), control characters (a
      // gateway may refuse them itself: Envoy answers an empty 400 for a NUL) and a key longer
      // than any store allows.
      const bad = [
        "a%5Cb.webp",
        "a%00b.webp",
        "a%1Fb.webp",
        "a%7Fb.webp",
        `${"x".repeat(1100)}.webp`,
      ];
      const control = (rest: string) => /%(?:[01][0-9A-F]|7F)/i.test(rest);
      const expectRefused = (result: HttpResult, rest: string, where: string) => {
        const what = `${where}${rest.slice(0, 16)}…`;
        check(result.status < 500, `${what} answered a server error`, {
          expected: "404 from the API (or a 4xx from a gateway for control characters)",
          observed: String(result.status),
          exchange: result.exchange,
        });
        const fromApi = (result.headers.get("Content-Type") ?? "").includes("problem+json");
        if (fromApi || !control(rest)) {
          problem(result, "not_found", what);
          return;
        }
        // The gateway's own refusal: a 4xx without content.
        check(
          result.status >= 400 && result.bytes.length < 1024,
          `${what} was answered with content`,
          {
            expected: "a 4xx without a body (refused before the API)",
            observed: `${result.status} ${result.headers.get("Content-Type") ?? ""}, ${result.bytes.length} bytes`,
            exchange: result.exchange,
          },
        );
        ctx.note(`${what}: refused by a gateway (${result.status})`);
      };
      const agent = ctx.agent("invalid-keys");
      for (const rest of bad)
        expectRefused(await agent.fetch(`/cdn/img/${rest}`), rest, "/cdn/img/");
      const fixture = await ctx.env.packagedPlayback();
      if (!fixture) {
        ctx.note("no packaged title: only /cdn paths were tried");
        return;
      }
      const base = fixture.masterUrl.slice(0, fixture.masterUrl.lastIndexOf("/") + 1);
      for (const rest of bad) {
        expectRefused(await fixture.viewer.agent.fetch(`${base}${rest}`), rest, "/media/…/");
      }
    },
  },
  {
    id: "browse.search-any-script",
    area: "browse",
    title: "Search answers long queries in any script (CJK, Cyrillic, astral letters, emoji)",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const queries = [
        "東京湾岸警備隊東京湾岸警備隊東京湾岸警備隊",
        "Достопримечательностидостопримечательности",
        "𠀀𠀁𠀂𠀃𠀄𠀅𠀆𠀇𠀈𠀉𠀊𠀋𠀌𠀍",
        "🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉🐉",
        "Amélié́́ Gàrden",
      ];
      for (const q of queries) {
        const result = await viewer.agent.fetch(`${API}/search?q=${encodeURIComponent(q)}`);
        status(result, 200, `search for ${JSON.stringify(q.slice(0, 8))}…`);
      }
    },
  },
  {
    id: "browse.search-cursor-invalid",
    area: "browse",
    title:
      "A search cursor the server did not issue is refused (validation_failed), never page one",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      for (const cursor of ["not-a-cursor", "eyJ4IjoxfQ"]) {
        const result = await viewer.agent.fetch(`${API}/search?q=a&cursor=${cursor}`);
        problem(result, "validation_failed", `search with cursor ${cursor}`);
      }
    },
  },
  {
    id: "browse.batches-stable",
    area: "browse",
    title: "Browse batches serve every row once when the plan changes between them",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("batches-stable");
      const api = viewer.agent.api;
      const first = await succeeds(() => api.getBrowse({ query: { view: "home" } }), "batch 1");
      const picks = first.rows
        .flatMap((row) => row.items as Array<{ id?: string; title?: { id: string } }>)
        .map((item) => item.title?.id ?? item.id)
        .filter((id): id is string => typeof id === "string")
        .slice(0, 3);
      for (const titleId of picks) {
        await succeeds(() => api.addToMyList({ params: { titleId } }), `add ${titleId}`);
      }
      // My List is in the first batch now; emptying it after batch 1 moves every later row up.
      const withList = await succeeds(() => api.getBrowse({ query: { view: "home" } }), "batch 1");
      const served = withList.rows.map((row) => row.id);
      check(
        served.some((id) => id.endsWith(":my-list")) && withList.nextCursor,
        "My List is not in the first batch of a home page with more batches",
        { observed: served.join(", ") },
      );
      for (const titleId of picks) {
        await succeeds(() => api.removeFromMyList({ params: { titleId } }), `remove ${titleId}`);
      }
      let cursor: string | null = withList.nextCursor;
      while (cursor) {
        const current: string = cursor;
        const next = await succeeds(
          () => api.getBrowse({ query: { view: "home", cursor: current } }),
          "next batch",
        );
        served.push(...next.rows.map((row) => row.id));
        cursor = next.nextCursor;
      }
      const plan = (await browseAll(viewer.agent, "home")).rows.map((row) => row.id);
      const skipped = plan.filter((id) => !served.includes(id));
      const repeated = served.filter((id, index) => served.indexOf(id) !== index);
      check(skipped.length === 0 && repeated.length === 0, "rows were skipped or repeated", {
        expected: "every row of the current plan served once",
        observed: `skipped: ${skipped.join(", ") || "none"}; repeated: ${repeated.join(", ") || "none"}`,
      });
    },
  },
  {
    id: "playback.release-empty-body",
    area: "playback",
    title:
      "Ending a session with an empty body is the same as with none, whatever Content-Type says",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("release-empty");
      const { cards } = await ctx.env.catalog();
      const card = cards[0];
      check(card, "the catalog is empty");
      for (const body of ["", " \n"]) {
        const session = await succeeds(
          () => viewer.agent.api.createPlaybackSession({ body: { titleId: card.id } }),
          "start",
        );
        const result = await viewer.agent.fetch(`${API}/playback/sessions/${session.id}`, {
          method: "DELETE",
          headers: { ...CSRF, "Content-Type": "application/json" },
          body,
        });
        status(
          result,
          204,
          `DELETE with Content-Type: application/json and ${JSON.stringify(body)}`,
        );
      }
    },
  },
  {
    id: "identity.password-byte-limit",
    area: "identity",
    title: "A password over the byte limit after NFKC is refused at validation, before any charge",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("password-limit");
      const email = ctx.env.email("long-password");
      // 40 characters that NFKC expands to 18 each (more than 1024 bytes of UTF-8).
      const password = "ﷺ".repeat(40);
      const result = await agent.fetch(`${API}/auth/signup`, {
        method: "POST",
        headers: CSRF,
        body: { email, password },
      });
      const body = problem(result, "validation_failed", "sign-up with an over-long password");
      check(
        body.issues.some((issue) => issue.path === "password"),
        "the refusal does not name the password",
        { observed: JSON.stringify(body.issues) },
      );
      const lookup = await agent.api.getEmailStatus({ query: { email } });
      equal(lookup.next, "signup", "the email after the refused sign-up");
    },
  },
  {
    id: "ratelimit.playback-start",
    area: "ratelimit",
    title: "Starting playback sessions is limited per account, well above what watching needs",
    timeoutMs: 120_000,
    async run(ctx: CheckContext) {
      const spec = expectedSpec(ctx.env, "playback-start", "strict");
      if (!spec) ctx.skip("custom --rate-limits without a playback-start limit");
      const viewer = await ctx.env.viewer("playback-start", { plan: "premium" });
      const { cards } = await ctx.env.catalog();
      const card = cards[0];
      check(card, "the catalog is empty");
      const agent = ctx.agent("playback-start-burst", { retryOn429: false });
      for (const [name, value] of viewer.agent.jar.snapshot()) agent.jar.set(name, value);
      const result = await burst(spec.limit + 10, () =>
        agent.fetch(`${API}/playback/sessions`, {
          method: "POST",
          headers: CSRF,
          body: { titleId: card.id },
          retryOn429: false,
        }),
      );
      const range = admissible(spec, result.durationMs);
      const admitted = result.sent - result.limited;
      check(result.limited > 0, "starting playback is never rate limited", {
        expected: `429 after ${spec.limit} per ${spec.windowSec}s per account`,
        observed: `${admitted} of ${result.sent} admitted: ${tallyStatuses(result.results)}`,
      });
      check(admitted <= range.max, "more playback starts admitted than documented", {
        expected: `≤ ${range.max}`,
        observed: `${admitted}: ${tallyStatuses(result.results)}`,
      });
      ctx.note(`${admitted}/${result.sent} admitted (${spec.limit}/${spec.windowSec}s)`);
    },
  },
  {
    id: "ratelimit.auth-email",
    area: "ratelimit",
    title:
      "Sign-ins are limited per email address from any browser it does not know; the owner's browser is never locked out",
    tags: ["exclusive", "ip-limit"],
    needs: [needs.ipExhaustion],
    timeoutMs: 300_000,
    async run(ctx: CheckContext) {
      const spec = expectedSpec(ctx.env, "auth-email", "strict");
      if (!spec) ctx.skip("custom --rate-limits without an auth-email limit");
      const owner: TestAccount = await ctx.env.bareSignup("auth-email");
      const login = (agent: Agent, password: string) =>
        agent.fetch(`${API}/auth/login`, {
          method: "POST",
          headers: CSRF,
          body: { email: owner.email, password },
          retryOn429: false,
        });
      const retryAfter = (result: HttpResult) => Number(result.headers.get("Retry-After") ?? "0");
      // Paced below the per-address limit (strict: 10/min, one every 6 s), so once that limit
      // has recovered every attempt reaches the per-email one: a 429 after the documented number
      // of admitted guesses can only be the per-email limit.
      const paced = async (send: () => Promise<HttpResult>): Promise<HttpResult> => {
        await ctx.sleep(7_000);
        return send();
      };
      const stranger = ctx.agent("auth-email-stranger", { retryOn429: false });
      let admitted = 0;
      let attempts = 0;
      while (admitted < spec.limit && attempts < spec.limit * 4) {
        attempts += 1;
        const result = await paced(() => login(stranger, `wrong-${attempts}`));
        if (result.status === 429) {
          // Before the documented number of guesses only the per-address limit can refuse
          // (another check may have spent it): wait it out.
          await ctx.sleep(retryAfter(result) * 1000 + 300);
          continue;
        }
        problem(result, "invalid_credentials", `wrong guess ${admitted + 1}`);
        admitted += 1;
      }
      const over = await paced(() => login(stranger, `wrong-${attempts + 1}`));
      if (over.status !== 429) {
        fail("sign-in guesses at one account are not limited per email address", {
          expected: `429 after ${spec.limit} guesses per ${spec.windowSec}s from any address`,
          observed: `${admitted + 1} paced guesses admitted (${over.status})`,
          exchange: over.exchange,
        });
      }
      problem(over, "rate_limited", "a guess over the per-email limit");
      const newBrowser = await paced(() =>
        login(ctx.agent("auth-email-new", { retryOn429: false }), owner.password),
      );
      status(newBrowser, 429, "a new browser with the right password during the limit");
      // The owner's own browser (it signed up there) is exempt.
      const own = await paced(() => login(owner.agent, owner.password));
      status(own, 200, "the account's own browser signing in during the limit");
      ctx.note(`limited after ${admitted} paced guesses; the owner's browser still signed in`);
    },
  },
];
