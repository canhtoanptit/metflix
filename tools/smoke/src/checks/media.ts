import { imageUrl, type TitleCard, trickPlayTile } from "@webflix/contracts";
import { checkMediaBody } from "../container.ts";
import type { PackagedPlayback } from "../env.ts";
import { check, equal, fail, header, problem, rejects, status, succeeds } from "../expect.ts";
import { isPlaylist, parseMaster, parseMediaPlaylist, resolveUri } from "../hls.ts";
import type { Agent, HttpResult } from "../http.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { fanOut, tallyStatuses } from "./util.ts";

async function packaged(ctx: CheckContext): Promise<PackagedPlayback> {
  const fixture = await ctx.env.packagedPlayback();
  if (!fixture) ctx.skip("no packaged title (external HLS fallback only)");
  if (fixture.lost)
    ctx.note(`the shared session lost its slot at ${fixture.lost.at}: ${fixture.lost.detail}`);
  return fixture;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function expectBytes(result: HttpResult, expected: Uint8Array, what: string): void {
  if (!bytesEqual(result.bytes, expected)) {
    fail(`${what}: body differs from the requested bytes`, {
      expected: `${expected.byteLength} bytes`,
      observed: `${result.bytes.byteLength} bytes (different content)`,
      exchange: result.exchange,
    });
  }
}

/** `/media/{token}/vod/{asset}/{rest}` → parts. */
function mediaParts(url: string): { token: string; assetId: string; rest: string } {
  const match = /^\/media\/([^/]+)\/vod\/([^/]+)\/(.+)$/.exec(url);
  if (!match) fail("not a signed media URL", { observed: url });
  return { token: match[1] ?? "", assetId: match[2] ?? "", rest: match[3] ?? "" };
}

/** Flip one character in the middle of the token (still URL-safe). */
function tamper(token: string): string {
  const index = Math.floor(token.length / 2);
  const char = token[index] === "A" ? "B" : "A";
  return `${token.slice(0, index)}${char}${token.slice(index + 1)}`;
}

async function playable(agent: Agent, card: TitleCard): Promise<boolean> {
  const detail = await agent.api.getTitle({ params: { id: card.id } });
  return detail.isPlayable;
}

export const mediaChecks: CheckDefinition[] = [
  {
    id: "playback.session",
    area: "playback",
    title: "Playback sessions: shape, episode choice, one stream per device, stop and errors",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("playback");
      const api = viewer.agent.api;
      const { cards } = await ctx.env.catalog();
      const movie = cards.find((card) => card.type === "movie");
      const series = cards.find((card) => card.type === "series");
      check(movie, "the catalog has no movie");
      check(await playable(viewer.agent, movie), `${movie.id} is not playable`);
      const session = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: movie.id } }),
        "POST /playback/sessions",
      );
      equal(session.titleId, movie.id, "titleId");
      equal(session.episodeId, null, "episodeId of a movie");
      equal(session.display.titleName, movie.name, "display.titleName");
      equal(session.display.titleType, "movie", "display.titleType");
      equal(
        session.maxVideoHeight,
        viewer.account.session.plan?.maxVideoHeight,
        "maxVideoHeight (plan cap)",
      );
      check(
        session.heartbeatIntervalSec > 0 && session.durationSec > 0,
        "heartbeat interval and duration must be positive",
      );
      check(Date.parse(session.expiresAt) > Date.now(), "expiresAt is not in the future", {
        observed: session.expiresAt,
      });
      check(
        /^\/media\/[^/]+\/vod\/[^/]+\/.+\.m3u8$/.test(session.manifestUrl) ||
          /^https?:\/\//.test(session.manifestUrl),
        "manifestUrl is neither a signed /media URL nor an absolute HLS URL",
        { observed: session.manifestUrl },
      );
      const ack = await succeeds(
        () =>
          api.sendHeartbeat({
            params: { id: session.id },
            body: { positionSec: 5, durationSec: session.durationSec, state: "playing" },
          }),
        "heartbeat",
      );
      check(ack.heartbeatIntervalSec > 0, "heartbeat ack interval");
      if (series) {
        const detail = await succeeds(
          () => api.getTitle({ params: { id: series.id } }),
          "series detail",
        );
        const episodes = await succeeds(
          () =>
            api.listEpisodes({
              params: { id: series.id, seasonNumber: detail.seasons[0]?.number ?? 1 },
            }),
          "episodes",
        );
        const replaced = await succeeds(
          () => api.createPlaybackSession({ body: { titleId: series.id } }),
          "series without episodeId",
        );
        equal(
          replaced.episodeId,
          episodes.items[0]?.id ?? null,
          "series starts at its play target (first episode)",
        );
        check(replaced.display.episode, "series session has no display.episode");
        if (episodes.items.length > 1 && episodes.items[1]?.isPlayable) {
          equal(replaced.nextEpisode?.episode.id, episodes.items[1]?.id, "nextEpisode");
        }
        // One stream per device: the new session replaced the movie's.
        await rejects(
          () =>
            api.sendHeartbeat({
              params: { id: session.id },
              body: { positionSec: 6, durationSec: session.durationSec, state: "playing" },
            }),
          "playback_session_ended",
          "heartbeat of the session replaced on the same device",
        );
        await rejects(
          () =>
            api.createPlaybackSession({
              body: { titleId: movie.id, episodeId: episodes.items[0]?.id ?? "e-x" },
            }),
          "not_found",
          "a movie with an episodeId",
        );
        const otherSeries = cards.find((card) => card.type === "series" && card.id !== series.id);
        if (otherSeries) {
          await rejects(
            () =>
              api.createPlaybackSession({
                body: { titleId: otherSeries.id, episodeId: episodes.items[0]?.id ?? "e-x" },
              }),
            "not_found",
            "an episode of another series",
          );
        }
        await succeeds(() => api.endPlaybackSession({ params: { id: replaced.id } }), "stop");
      } else {
        await succeeds(() => api.endPlaybackSession({ params: { id: session.id } }), "stop");
      }
      await rejects(
        () => api.createPlaybackSession({ body: { titleId: "t-smoke-no-such-title" } }),
        "not_found",
        "unknown title",
      );
      await rejects(
        () =>
          api.sendHeartbeat({
            params: { id: "smoke-no-such-session" },
            body: { positionSec: 1, durationSec: 10, state: "playing" },
          }),
        "not_found",
        "heartbeat of an unknown session",
      );
      const last = await succeeds(
        () => api.createPlaybackSession({ body: { titleId: movie.id } }),
        "start again",
      );
      await succeeds(
        () => api.endPlaybackSession({ params: { id: last.id } }),
        "DELETE /playback/sessions/:id",
      );
      await succeeds(
        () => api.endPlaybackSession({ params: { id: last.id } }),
        "DELETE again (idempotent)",
      );
      await rejects(
        () =>
          api.sendHeartbeat({
            params: { id: last.id },
            body: { positionSec: 1, durationSec: last.durationSec, state: "playing" },
          }),
        "playback_session_ended",
        "heartbeat after stop",
      );
    },
  },
  {
    id: "media.manifest",
    area: "media",
    title:
      "Master and variant playlists: signed, relative URIs, plan cap, consistent across instances",
    tags: ["consistency"],
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const fixture = await packaged(ctx);
      const agent = fixture.viewer.agent;
      const master = await agent.fetch(fixture.masterUrl);
      status(master, 200, "master playlist");
      header(master, "Content-Type", /mpegurl/i, "master playlist");
      header(master, "Cache-Control", /private/, "master playlist");
      header(
        master,
        "Cache-Control",
        /no-cache|no-store|max-age=0/,
        "master playlist (playlists are not cached)",
      );
      check(isPlaylist(master.text()), "master playlist does not start with #EXTM3U", {
        exchange: master.exchange,
      });
      const parsed = parseMaster(master.text());
      check(parsed.variants.length > 0, "master playlist lists no variant", {
        exchange: master.exchange,
      });
      const absolute = [
        ...parsed.variants.map((variant) => variant.uri),
        ...parsed.media.map((media) => media.uri),
      ].filter((uri) => /^(https?:)?\/\//.test(uri) || uri.startsWith("/"));
      check(absolute.length === 0, "playlist URIs must be relative so they inherit the token", {
        observed: absolute.join(", "),
      });
      const tall = parsed.variants.filter(
        (variant) => (variant.height ?? 0) > fixture.session.maxVideoHeight,
      );
      check(tall.length === 0, "master playlist offers variants above the plan cap", {
        expected: `heights ≤ ${fixture.session.maxVideoHeight}`,
        observed: tall.map((variant) => variant.height).join(", "),
      });
      check(
        fixture.variant.segments.length > 0 && fixture.variant.endList,
        "variant playlist is not a complete VOD playlist",
      );
      // Playlists check the stream slot (DECISIONS D1): every instance must see it.
      const rounds = ctx.options.repeat;
      const results: HttpResult[] = [];
      for (let round = 0; round < rounds; round += 1) {
        results.push(
          ...(await fanOut(ctx.options.parallelism, () => agent.fetch(fixture.masterUrl))),
        );
      }
      const bad = results.filter((result) => result.status !== 200);
      check(
        bad.length === 0,
        "the master playlist is not served consistently while the slot is held",
        {
          expected: `${results.length}× 200`,
          observed: tallyStatuses(results),
          exchange: bad[0]?.exchange,
        },
      );
      ctx.note(
        `${parsed.variants.length} variants (${parsed.variants.map((variant) => variant.height).join("/")}p), ${fixture.variant.segments.length} segments; ${results.length} concurrent master fetches all 200`,
      );
    },
  },
  {
    id: "media.range-requests",
    area: "media",
    title: "Segments: full, partial, open-ended, suffix, clamped and unsatisfiable ranges; HEAD",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const fixture = await packaged(ctx);
      const agent = fixture.viewer.agent;
      const url = fixture.segmentUrl;
      const full = await agent.fetch(url);
      status(full, 200, "segment");
      header(full, "Accept-Ranges", "bytes", "segment");
      header(full, "ETag", /^(W\/)?"[^"]+"$/, "segment");
      header(full, "Cache-Control", /private/, "segment (protected media is private)");
      const maxAge = Number(
        /max-age=(\d+)/.exec(full.headers.get("Cache-Control") ?? "")?.[1] ?? Number.NaN,
      );
      check(
        Number.isFinite(maxAge) && maxAge <= 3600,
        "segment max-age exceeds an hour or the token",
        {
          observed: full.headers.get("Cache-Control") ?? "",
        },
      );
      header(
        full,
        "Content-Type",
        (value) => value !== null && !/html|json/.test(value),
        "segment content type",
      );
      const size = full.bytes.byteLength;
      equal(full.headers.get("Content-Length"), String(size), "Content-Length", full.exchange);
      check(size > 200, "segment is too small to test ranges", { observed: `${size} bytes` });
      const range = async (value: string, expectStatus: number, start: number, end: number) => {
        const result = await agent.fetch(url, { headers: { Range: value } });
        status(result, expectStatus, `Range: ${value}`);
        header(result, "Content-Range", `bytes ${start}-${end}/${size}`, `Range: ${value}`);
        equal(
          result.headers.get("Content-Length"),
          String(end - start + 1),
          `Content-Length for ${value}`,
          result.exchange,
        );
        expectBytes(result, full.bytes.subarray(start, end + 1), `Range: ${value}`);
      };
      await range("bytes=0-99", 206, 0, 99);
      await range("bytes=100-", 206, 100, size - 1);
      await range("bytes=-50", 206, size - 50, size - 1);
      await range(`bytes=${size - 10}-${size + 100}`, 206, size - 10, size - 1);
      for (const value of [`bytes=${size}-`, `bytes=${size + 10}-${size + 20}`]) {
        const result = await agent.fetch(url, { headers: { Range: value } });
        const body = problem(result, "range_not_satisfiable", `Range: ${value}`);
        equal(body.size, size, `range_not_satisfiable.size for ${value}`, result.exchange);
        header(result, "Content-Range", `bytes */${size}`, `Range: ${value}`);
      }
      const reversed = await agent.fetch(url, { headers: { Range: "bytes=50-10" } });
      status(reversed, 200, "an invalid Range is ignored (full body)");
      expectBytes(reversed, full.bytes, "invalid Range");
      const head = await agent.fetch(url, { method: "HEAD" });
      status(head, 200, "HEAD segment");
      equal(head.headers.get("Content-Length"), String(size), "HEAD Content-Length", head.exchange);
      equal(head.bytes.byteLength, 0, "HEAD body length", head.exchange);
      const etag = full.headers.get("ETag") ?? "";
      const ifRange = await agent.fetch(url, { headers: { Range: "bytes=0-9", "If-Range": etag } });
      status(ifRange, 206, "If-Range with the current ETag");
      const stale = await agent.fetch(url, {
        headers: { Range: "bytes=0-9", "If-Range": '"smoke-stale-etag"' },
      });
      status(stale, 200, "If-Range with a stale ETag (full object)");
      expectBytes(stale, full.bytes, "If-Range stale");
      if (fixture.initUrl)
        status(await agent.fetch(fixture.initUrl), 200, "init segment (EXT-X-MAP)");
      ctx.note(`segment of ${size} bytes`);
    },
  },
  {
    id: "media.segment-integrity",
    area: "media",
    title: "Init and media segments of every rendition are complete containers (not truncated)",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const fixture = await packaged(ctx);
      const agent = fixture.viewer.agent;
      const playlists = [
        ...fixture.master.variants.map((variant) => ({
          kind: `video ${variant.height ?? "?"}p`,
          uri: variant.uri,
        })),
        ...fixture.master.media
          .filter((media) => media.type === "AUDIO")
          .map((media) => ({ kind: `audio ${media.language ?? ""}`, uri: media.uri })),
      ];
      let verified = 0;
      for (const { kind, uri } of playlists) {
        const playlistUrl = resolveUri(fixture.masterUrl, uri);
        const result = await agent.fetch(playlistUrl);
        status(result, 200, `${kind} playlist`);
        const playlist = parseMediaPlaylist(result.text());
        check(playlist.segments.length > 0, `${kind} playlist lists no segment`, {
          exchange: result.exchange,
        });
        // A sample, not every segment: first, second (what the range checks use), middle, last.
        const picks = new Set([
          0,
          Math.min(1, playlist.segments.length - 1),
          Math.floor(playlist.segments.length / 2),
          playlist.segments.length - 1,
        ]);
        const uris = [
          ...(playlist.map ? [playlist.map] : []),
          ...[...picks].flatMap((index) =>
            playlist.segments[index] ? [playlist.segments[index].uri] : [],
          ),
        ];
        for (const segmentUri of uris) {
          const url = resolveUri(playlistUrl, segmentUri);
          const body = await agent.fetch(url);
          status(body, 200, `${kind} ${segmentUri}`);
          check(body.bytes.byteLength > 0, `${kind} ${segmentUri} is empty`, {
            exchange: body.exchange,
          });
          const integrity = checkMediaBody(segmentUri, body.bytes);
          if (integrity && !integrity.ok) {
            fail(`${kind} ${segmentUri} is not a complete container`, {
              expected: "top-level boxes that exactly tile the body",
              observed: `${integrity.problem ?? ""} (${body.bytes.byteLength} bytes; boxes ${integrity.boxes.join(" ")})`,
              exchange: body.exchange,
            });
          }
          if (integrity) verified += 1;
        }
      }
      if (verified === 0)
        ctx.skip("no segment in a container format the suite can verify (fMP4 or MPEG-TS)");
      ctx.note(`${verified} init/media segments across ${playlists.length} renditions verified`);
    },
  },
  {
    id: "media.conditional-requests",
    area: "media",
    title: "If-None-Match answers 304 on segments and playlists (strong and weak tags)",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const fixture = await packaged(ctx);
      const agent = fixture.viewer.agent;
      const full = await agent.fetch(fixture.segmentUrl);
      status(full, 200, "segment");
      const etag = header(full, "ETag", /"/, "segment") ?? "";
      for (const tag of [etag, `W/${etag.replace(/^W\//, "")}`, `"smoke-other", ${etag}`]) {
        const result = await agent.fetch(fixture.segmentUrl, { headers: { "If-None-Match": tag } });
        status(result, 304, `If-None-Match: ${tag}`);
        equal(result.bytes.byteLength, 0, "304 body", result.exchange);
        header(result, "ETag", etag, `ETag on 304 (${tag})`);
      }
      status(
        await agent.fetch(fixture.segmentUrl, { headers: { "If-None-Match": '"smoke-other"' } }),
        200,
        "If-None-Match mismatch",
      );
      const master = await agent.fetch(fixture.masterUrl);
      const masterTag = header(master, "ETag", /"/, "master playlist") ?? "";
      const again = await agent.fetch(fixture.masterUrl, {
        headers: { "If-None-Match": masterTag },
      });
      status(again, 304, "master playlist If-None-Match");
    },
  },
  {
    id: "media.token-tampering",
    area: "media",
    title: "Tampered, truncated and wrong-asset media tokens are refused",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const fixture = await packaged(ctx);
      const agent = ctx.agent("token-tamperer");
      const { token, assetId, rest } = mediaParts(fixture.segmentUrl);
      const master = mediaParts(fixture.masterUrl);
      const cases = [
        {
          what: "tampered token (segment)",
          path: `/media/${tamper(token)}/vod/${assetId}/${rest}`,
        },
        {
          what: "tampered token (playlist)",
          path: `/media/${tamper(master.token)}/vod/${master.assetId}/${master.rest}`,
        },
        {
          what: "truncated token",
          path: `/media/${token.slice(0, Math.floor(token.length / 2))}/vod/${assetId}/${rest}`,
        },
        {
          what: "token of another asset",
          path: `/media/${token}/vod/${assetId}-smoke-other/${rest}`,
        },
      ];
      for (const { what, path } of cases) {
        const result = await agent.fetch(path);
        problem(result, "media_token_invalid", what);
        header(result, "Cache-Control", /no-store/, `${what} (errors are not cached)`);
      }
      // Stateless: the untampered URL works from any client (no cookie needed for segments).
      status(
        await agent.fetch(fixture.segmentUrl),
        200,
        "the genuine segment URL from another client",
      );
    },
  },
  {
    id: "media.subtitles",
    area: "media",
    title: "Advertised WebVTT text tracks are served with their signed URLs",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const fixture = await packaged(ctx);
      const tracks = fixture.session.textTracks;
      if (tracks.length === 0)
        ctx.skip(`the packaged session (${fixture.card.id}) advertises no text tracks`);
      check(
        tracks.filter((track) => track.default).length <= 1,
        "more than one default text track",
      );
      for (const track of tracks.slice(0, 4)) {
        check(
          track.url.startsWith("/media/"),
          `text track ${track.language} is not a signed same-origin URL`,
          { observed: track.url },
        );
        const result = await fixture.viewer.agent.fetch(track.url);
        status(result, 200, `subtitles ${track.language}`);
        header(result, "Content-Type", /text\/vtt/, `subtitles ${track.language}`);
        check(
          result.text().replace(/^﻿/, "").startsWith("WEBVTT"),
          `subtitles ${track.language} are not WebVTT`,
          {
            exchange: result.exchange,
          },
        );
      }
      ctx.note(`${tracks.length} tracks: ${tracks.map((track) => track.language).join(", ")}`);
    },
  },
  {
    id: "media.trick-play",
    area: "media",
    title: "Advertised trick-play sheets are served and match their geometry",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const fixture = await packaged(ctx);
      const trick = fixture.session.trickPlay;
      if (!trick) ctx.skip(`the packaged session (${fixture.card.id}) advertises no trick-play`);
      check(
        trick.sheets.length >= Math.ceil(trick.count / (trick.columns * trick.rows)),
        "fewer sheets than the thumbnail count needs",
        {
          observed: `${trick.sheets.length} sheets for ${trick.count} thumbnails of ${trick.columns}×${trick.rows}`,
        },
      );
      const tile = trickPlayTile(trick, 0);
      check(tile, "no tile for position 0");
      const result = await fixture.viewer.agent.fetch(tile.sheetUrl);
      status(result, 200, "trick-play sheet");
      header(result, "Content-Type", /^image\//, "trick-play sheet");
      check(result.bytes.byteLength > 0, "empty trick-play sheet", { exchange: result.exchange });
    },
  },
  {
    id: "media.cdn",
    area: "media",
    title: "/cdn artwork and previews: immutable caching, conditional and range requests",
    async run(ctx: CheckContext) {
      const { cards } = await ctx.env.catalog();
      const agent = ctx.agent("cdn");
      const previews = cards.flatMap((card) => (card.preview ? [card.preview.url] : []));
      const images = cards.flatMap((card) => {
        const set = card.images.card;
        // A null ThumbHash marks a placeholder template: real artwork is not packaged yet.
        return set.thumbhash ? [imageUrl(set, set.widths[0] ?? 0, set.formats[0] ?? "webp")] : [];
      });
      if (previews.length === 0 && images.length === 0) {
        ctx.skip("the catalog advertises no packaged artwork or preview clips (placeholders only)");
      }
      for (const url of [images[0], previews[0]].filter(
        (value): value is string => value !== undefined,
      )) {
        const result = await agent.fetch(url);
        status(result, 200, `GET ${url}`);
        header(result, "Cache-Control", /public/, url);
        header(result, "Cache-Control", /max-age=31536000/, url);
        header(result, "Cache-Control", /immutable/, url);
        header(result, "Content-Type", /^(image|video)\//, url);
        const etag = header(result, "ETag", /"/, url) ?? "";
        status(
          await agent.fetch(url, { headers: { "If-None-Match": etag } }),
          304,
          `${url} If-None-Match`,
        );
        const ranged = await agent.fetch(url, { headers: { Range: "bytes=0-15" } });
        status(ranged, 206, `${url} Range`);
        expectBytes(ranged, result.bytes.subarray(0, 16), `${url} Range`);
        if (/\.mp4(\?|$)/.test(url)) {
          const integrity = checkMediaBody(url, result.bytes);
          if (integrity && !integrity.ok) {
            fail(`${url} is not a complete MP4`, {
              observed: integrity.problem ?? "",
              exchange: result.exchange,
            });
          }
        }
        const bust = url.includes("?")
          ? url.replace(/\?.*$/, "?v=smoke-other")
          : `${url}?v=smoke-other`;
        const busted = await agent.fetch(bust);
        status(busted, 200, `${bust} (the query string is not part of the key)`);
        expectBytes(busted, result.bytes, "query string ignored");
      }
      ctx.note(`${images.length} packaged images, ${previews.length} preview clips advertised`);
    },
  },
  {
    id: "media.external-fallback",
    area: "media",
    title: "External HLS fallback: absolute third-party URL, no signed side files (not fetched)",
    needs: [needs.externalMedia],
    async run(ctx: CheckContext) {
      const discovery = await ctx.env.media();
      const external = discovery.external;
      check(external, "no external title");
      const { session } = external;
      const url = new URL(session.manifestUrl);
      check(
        url.protocol === "https:" || url.protocol === "http:",
        "external manifest is not http(s)",
        { observed: session.manifestUrl },
      );
      check(
        url.origin !== new URL(ctx.options.baseUrl).origin,
        "an external manifest points at the target itself",
        {
          observed: session.manifestUrl,
        },
      );
      check(/\.m3u8$/i.test(url.pathname), "external manifest is not an HLS playlist URL", {
        observed: session.manifestUrl,
      });
      equal(
        session.textTracks.length,
        0,
        "text tracks of an external stream (only packaged media is signed)",
      );
      equal(session.trickPlay, null, "trick-play of an external stream");
      ctx.note(`${external.card.id} → ${url.origin} (not fetched)`);
    },
  },
  {
    id: "media.playlist-after-stop",
    area: "media",
    title: "After stop, playlists answer 410 while segments stay valid until the token expires",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const discovery = await ctx.env.media();
      const card = discovery.packaged?.card;
      check(card, "no packaged title");
      const viewer = await ctx.env.isolatedViewer("after-stop");
      const session = await succeeds(
        () => viewer.agent.api.createPlaybackSession({ body: { titleId: card.id } }),
        "start",
      );
      status(await viewer.agent.fetch(session.manifestUrl), 200, "master playlist while playing");
      const shared = await packaged(ctx);
      const { rest } = mediaParts(shared.segmentUrl);
      const { token, assetId } = mediaParts(session.manifestUrl);
      const segment = `/media/${token}/vod/${assetId}/${rest}`;
      status(await viewer.agent.fetch(segment), 200, "segment while playing");
      await succeeds(
        () => viewer.agent.api.endPlaybackSession({ params: { id: session.id } }),
        "stop",
      );
      problem(
        await viewer.agent.fetch(session.manifestUrl),
        "playback_session_ended",
        "master playlist after stop",
      );
      status(
        await viewer.agent.fetch(segment),
        200,
        "segment after stop (stateless until expiry, DECISIONS D1)",
      );
    },
  },
  {
    id: "plans.quality-cap",
    area: "plans",
    title: "Basic plan: session and master playlist are capped at 720p",
    needs: [needs.packagedMedia],
    async run(ctx: CheckContext) {
      const discovery = await ctx.env.media();
      const card = discovery.packaged?.card;
      check(card, "no packaged title");
      const premium = await packaged(ctx);
      const tallest = Math.max(0, ...premium.master.variants.map((variant) => variant.height ?? 0));
      const basic = await ctx.env.viewer("quality-cap", { plan: "basic" });
      const session = await succeeds(
        () => basic.agent.api.createPlaybackSession({ body: { titleId: card.id } }),
        "start on Basic",
      );
      equal(session.maxVideoHeight, 720, "Basic maxVideoHeight");
      const master = await basic.agent.fetch(session.manifestUrl);
      status(master, 200, "Basic master playlist");
      const heights = parseMaster(master.text()).variants.map((variant) => variant.height ?? 0);
      check(
        heights.length > 0 && heights.every((height) => height <= 720),
        "Basic master playlist offers variants above 720p",
        {
          observed: heights.join(", "),
          exchange: master.exchange,
        },
      );
      await succeeds(
        () => basic.agent.api.endPlaybackSession({ params: { id: session.id } }),
        "stop",
      );
      if (tallest <= 720)
        ctx.skip(
          `the packaged asset has no variant above 720p (tallest ${tallest}p): the cap cannot be observed`,
        );
      ctx.note(`premium offers up to ${tallest}p; Basic ${Math.max(...heights)}p`);
    },
  },
];
