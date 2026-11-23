/**
 * Behaviour that depends on state shared by every replica/isolate: stream slots, sessions,
 * active profiles, library writes, the profile cap and rate limits. Each check fans out
 * concurrent requests and repeats, so a deployment that keeps any of this per process (or in
 * an eventually consistent store) fails here.
 */
import { MAX_PROFILES_PER_ACCOUNT } from "@webflix/contracts";
import { check, equal, fail, header, problem, succeeds } from "../expect.ts";
import type { Agent, HttpResult } from "../http.ts";
import {
  admissible,
  lockedProfile,
  measureProfilePinLimit,
  SMOKE_PIN,
  selectProfileRaw,
} from "../limits.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF, fanOut, tallyStatuses } from "./util.ts";

function startRaw(agent: Agent, titleId: string): Promise<HttpResult> {
  return agent.fetch(`${API}/playback/sessions`, {
    method: "POST",
    headers: CSRF,
    body: { titleId },
  });
}

export const consistencyChecks: CheckDefinition[] = [
  {
    id: "consistency.stream-limit",
    area: "consistency",
    title:
      "Concurrent starts from separate devices admit exactly the plan's one stream, every round",
    tags: ["consistency"],
    timeoutMs: 240_000,
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.viewer("streams", { plan: "basic" });
      const { cards } = await ctx.env.catalog();
      const title = cards.find((card) => card.type === "movie");
      check(title, "need a movie");
      const devices: Agent[] = [viewer.agent];
      const count = Math.max(2, Math.min(ctx.options.parallelism, 4));
      for (let index = 1; index < count; index += 1) {
        const agent = await ctx.env.login(viewer.account, `streams-${index + 1}`);
        await ctx.env.selectProfile(agent, viewer.profile.id);
        devices.push(agent);
      }
      for (let round = 1; round <= ctx.options.repeat; round += 1) {
        const results = await Promise.all(devices.map((agent) => startRaw(agent, title.id)));
        const winners = results.filter((result) => result.status === 201);
        if (winners.length !== 1) {
          fail(
            `round ${round}: ${winners.length} of ${devices.length} concurrent devices got a stream on a 1-stream plan`,
            {
              expected: `exactly 1× 201 and ${devices.length - 1}× 409 stream_limit_reached`,
              observed: tallyStatuses(results),
              exchange: (winners[1] ?? results.find((result) => result.status !== 409))?.exchange,
            },
          );
        }
        const winner = winners[0] as HttpResult;
        const winnerId = winner.json<{ id: string }>().id;
        for (const result of results.filter((item) => item !== winner)) {
          const body = problem(result, "stream_limit_reached", `round ${round}: a losing device`);
          equal(
            body.activeStreams.map((stream) => stream.playbackSessionId).join(","),
            winnerId,
            `round ${round}: active streams listed to the loser`,
            result.exchange,
          );
        }
        // While the slot is held, every later attempt from any device is refused.
        const owner = devices[results.indexOf(winner)] as Agent;
        const others = devices.filter((agent) => agent !== owner);
        const retries = await fanOut(ctx.options.parallelism, (index) =>
          startRaw(others[index % others.length] as Agent, title.id),
        );
        const admitted = retries.filter((result) => result.status !== 409);
        check(admitted.length === 0, `round ${round}: a held slot was handed out again`, {
          expected: `${retries.length}× 409`,
          observed: tallyStatuses(retries),
          exchange: admitted[0]?.exchange,
        });
        const beats = await fanOut(ctx.options.parallelism, () =>
          owner.fetch(`${API}/playback/sessions/${winnerId}/heartbeat`, {
            method: "POST",
            headers: CSRF,
            body: { positionSec: 1, durationSec: 100, state: "playing" },
          }),
        );
        const lost = beats.filter((result) => result.status !== 200);
        check(lost.length === 0, `round ${round}: heartbeats of the held slot were refused`, {
          expected: `${beats.length}× 200`,
          observed: tallyStatuses(beats),
          exchange: lost[0]?.exchange,
        });
        await succeeds(
          () => owner.api.endPlaybackSession({ params: { id: winnerId } }),
          `round ${round}: stop`,
        );
      }
      ctx.note(`${ctx.options.repeat} rounds × ${devices.length} devices: one winner each`);
    },
  },
  {
    id: "consistency.session-and-profile",
    area: "consistency",
    title: "A new session and a profile switch are visible to every following request",
    tags: ["consistency"],
    timeoutMs: 240_000,
    async run(ctx: CheckContext) {
      // Its own account: every round switches profiles from every instance.
      const viewer = await ctx.env.viewer("session-consistency", { member: false });
      const fan = ctx.options.parallelism;
      const fresh = await ctx.env.login(viewer.account, "session-consistency-new");
      const sessions = await fanOut(fan, () => fresh.fetch(`${API}/profiles`));
      check(
        sessions.every((result) => result.status === 200),
        "a just-created session is not recognised everywhere",
        {
          observed: tallyStatuses(sessions),
          exchange: sessions.find((result) => result.status !== 200)?.exchange,
        },
      );
      for (let round = 1; round <= ctx.options.repeat; round += 1) {
        await succeeds(() => viewer.agent.api.clearProfile(), `round ${round}: leave the profile`);
        const without = await fanOut(fan, () => viewer.agent.fetch(`${API}/my-list`));
        check(
          without.every((result) => result.status === 403),
          `round ${round}: requests still see the old profile`,
          {
            expected: `${fan}× 403 profile_required`,
            observed: tallyStatuses(without),
            exchange: without.find((result) => result.status !== 403)?.exchange,
          },
        );
        await ctx.env.selectProfile(viewer.agent, viewer.profile.id);
        const withProfile = await fanOut(fan, () => viewer.agent.fetch(`${API}/my-list`));
        check(
          withProfile.every((result) => result.status === 200),
          `round ${round}: requests do not see the selected profile`,
          {
            expected: `${fan}× 200`,
            observed: tallyStatuses(withProfile),
            exchange: withProfile.find((result) => result.status !== 200)?.exchange,
          },
        );
      }
    },
  },
  {
    id: "consistency.library-read-after-write",
    area: "consistency",
    title: "My List and ratings writes are read back by every following request",
    tags: ["consistency"],
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("library-consistency", { member: false });
      const { cards } = await ctx.env.catalog();
      const title = cards[cards.length - 1];
      check(title, "empty catalog");
      const fan = ctx.options.parallelism;
      const read = () => fanOut(fan, () => viewer.agent.api.getTitle({ params: { id: title.id } }));
      for (let round = 1; round <= ctx.options.repeat; round += 1) {
        await succeeds(
          () => viewer.agent.api.addToMyList({ params: { titleId: title.id } }),
          "add to My List",
        );
        const added = await read();
        check(
          added.every((detail) => detail.viewer.inMyList),
          `round ${round}: a read after adding to My List missed it`,
          {
            observed: added.map((detail) => detail.viewer.inMyList).join(","),
          },
        );
        await succeeds(
          () =>
            viewer.agent.api.rateTitle({
              params: { titleId: title.id },
              body: { value: round % 2 ? "love" : "like" },
            }),
          "rate",
        );
        const rated = await read();
        const expected = round % 2 ? "love" : "like";
        check(
          rated.every((detail) => detail.viewer.rating === expected),
          `round ${round}: a read after rating missed it`,
          {
            expected,
            observed: rated.map((detail) => detail.viewer.rating).join(","),
          },
        );
        await succeeds(
          () => viewer.agent.api.removeFromMyList({ params: { titleId: title.id } }),
          "remove from My List",
        );
        const removed = await read();
        check(
          removed.every((detail) => !detail.viewer.inMyList),
          `round ${round}: a read after removing from My List still had it`,
          {
            observed: removed.map((detail) => detail.viewer.inMyList).join(","),
          },
        );
      }
    },
  },
  {
    id: "consistency.profile-cap-race",
    area: "consistency",
    title: "Concurrent profile creation never exceeds five",
    tags: ["consistency"],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("cap-race");
      const avatarId = await ctx.env.avatarId(account.agent);
      const attempts = Math.max(MAX_PROFILES_PER_ACCOUNT + 3, ctx.options.parallelism);
      const results = await fanOut(attempts, (index) =>
        account.agent.fetch(`${API}/profiles`, {
          method: "POST",
          headers: CSRF,
          body: { name: `Race ${index}`, avatarId },
        }),
      );
      const created = results.filter((result) => result.status === 201).length;
      equal(
        created,
        MAX_PROFILES_PER_ACCOUNT,
        `profiles created by ${attempts} concurrent requests`,
      );
      for (const result of results.filter((item) => item.status !== 201)) {
        problem(result, "profile_limit_reached", "a request over the cap");
      }
      const listed = await succeeds(() => account.agent.api.listProfiles(), "GET /profiles");
      equal(listed.items.length, MAX_PROFILES_PER_ACCOUNT, "profiles stored");
    },
  },
  {
    id: "consistency.rate-limit-exact",
    area: "consistency",
    title:
      "A concurrent burst of PIN attempts admits exactly the documented limit (shared, atomic limiter)",
    tags: ["consistency"],
    async run(ctx: CheckContext) {
      const measured = await measureProfilePinLimit(ctx.env);
      const { burst } = measured;
      ctx.note(`profile-pin burst: ${measured.verdict}`);
      if (burst.other.size > 0) {
        fail("the burst got answers other than success or 429", {
          observed: tallyStatuses(burst.results),
          exchange: burst.results.find((result) => result.status !== 200 && result.status !== 429)
            ?.exchange,
        });
      }
      if (measured.classification === "none") {
        if (
          ctx.options.rateLimits.mode === "custom" &&
          (ctx.options.rateLimits.limits["profile-pin"]?.limit ?? 0) >= burst.sent
        ) {
          ctx.skip(
            `the configured profile-pin limit is not below the burst size (${burst.sent}); raise --burst`,
          );
        }
        fail("PIN attempts are not rate limited", {
          expected: "429 rate_limited after the documented limit (5/min strict, 60/min dev)",
          observed: `${burst.sent} PIN attempts in concurrent bursts of ${ctx.options.burst}, all admitted`,
        });
      }
      const limited = burst.results.filter((result) => result.status === 429);
      for (const result of limited.slice(0, 3)) {
        const body = problem(result, "rate_limited", "a request over the limit");
        header(
          result,
          "Retry-After",
          String(body.retryAfterSec),
          "Retry-After equals retryAfterSec",
        );
      }
      const expected = measured.expected;
      if (!expected) {
        fail("the observed limit matches neither documented profile", {
          expected:
            "5 per minute (strict default) or 60 per minute (dev); pin custom limits with --rate-limits profile-pin=N/60",
          observed: `${measured.allowed} of ${burst.sent} admitted in ${burst.durationMs} ms. A per-instance limiter behind k replicas admits about k × the limit.`,
        });
      }
      if (!measured.matchesExpected) {
        const range = admissible(expected, burst.durationMs);
        fail("the burst admitted a different number of requests than the limit", {
          expected: `${range.min}..${range.max} admitted (limit ${expected.limit}/${expected.windowSec}s plus refill during ${burst.durationMs} ms)`,
          observed: `${measured.allowed} of ${burst.sent} admitted. More means per-instance or non-atomic counting; fewer means a stricter or shared bucket.`,
        });
      }
    },
  },
  {
    id: "consistency.rate-limit-monotonic",
    area: "consistency",
    title: "Once limited, a client stays limited until Retry-After on every instance",
    tags: ["consistency"],
    async run(ctx: CheckContext) {
      // A fresh bucket of PIN attempts drained one request at a time: with per-instance
      // limiters behind a balancer, one instance runs dry while another still admits, so a 429
      // is followed by a success long before its Retry-After. An even split hides it, hence a
      // few rounds.
      const rounds = Math.min(ctx.options.repeat, 3);
      for (let round = 1; round <= rounds; round += 1) {
        const account = await ctx.env.bareSignup("ratelimit-monotonic");
        const profile = await lockedProfile(ctx.env, account, "Monotonic");
        const agent = ctx.agent("ratelimit-monotonic", { retryOn429: false });
        for (const [name, value] of account.agent.jar.snapshot()) agent.jar.set(name, value);
        const sequence: { at: number; result: HttpResult }[] = [];
        let firstLimited: { at: number; retryAfter: number } | null = null;
        const cap = ctx.options.burst * 5;
        while (sequence.length < cap) {
          const result = await selectProfileRaw(agent, profile.id, SMOKE_PIN);
          const at = performance.now();
          sequence.push({ at, result });
          if (result.status === 429 && !firstLimited) {
            firstLimited = { at, retryAfter: Number(result.headers.get("Retry-After")) };
          }
          // Keep going after the first 429 to see whether anything slips through.
          if (
            firstLimited &&
            at - firstLimited.at > Math.max(0, (firstLimited.retryAfter - 2) * 1000)
          )
            break;
        }
        if (!firstLimited) {
          ctx.skip(
            `no 429 within ${cap} sequential PIN attempts (see consistency.rate-limit-exact)`,
          );
        }
        if (!(firstLimited.retryAfter >= 3)) {
          ctx.skip(
            `Retry-After is ${firstLimited.retryAfter}s (a fast refill): too short to tell a refill from another instance admitting`,
          );
        }
        // A correct limiter admits nothing until (Retry-After − 1) s after a 429.
        const limitedAt = firstLimited.at;
        const window = (firstLimited.retryAfter - 1) * 1000;
        const slipped = sequence.filter(
          ({ at, result }) => at > limitedAt && at - limitedAt < window && result.status !== 429,
        );
        const after = sequence.filter(({ at }) => at > limitedAt).map(({ result }) => result);
        const before = sequence.findIndex(({ result }) => result.status === 429);
        check(
          slipped.length === 0,
          `round ${round}: requests were admitted after a 429, long before its Retry-After`,
          {
            expected: `after the first 429 (Retry-After ${firstLimited.retryAfter}s), only 429s for ${firstLimited.retryAfter - 1}s`,
            observed: `${before} admitted before the first 429, then ${tallyStatuses(after)}: per-instance counting behind a balancer`,
            exchange: slipped[0]?.result.exchange,
          },
        );
        ctx.note(
          `round ${round}: ${before} admitted, then ${after.length} sequential follow-ups all refused`,
        );
      }
    },
  },
];
