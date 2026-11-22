import type { PlaybackSession, TitleCard } from "@webflix/contracts";
import type { Environment, TestAccount } from "../env.ts";
import { check, equal, fail, problem, rejects, succeeds } from "../expect.ts";
import type { Agent, HttpResult } from "../http.ts";
import { expectedSpec } from "../limits.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF } from "./util.ts";

/** Sign in `account` on a new device and select its (only) profile. */
async function device(
  env: Environment,
  account: TestAccount,
  profileId: string,
  label: string,
): Promise<Agent> {
  const agent = await env.login(account, label);
  await env.selectProfile(agent, profileId);
  return agent;
}

async function movies(env: Environment, count: number): Promise<TitleCard[]> {
  const { cards } = await env.catalog();
  const list = cards.filter((card) => card.type === "movie").slice(0, count);
  check(list.length === count, `need ${count} movies`, { observed: String(list.length) });
  return list;
}

function start(agent: Agent, titleId: string, what: string): Promise<PlaybackSession> {
  return succeeds(() => agent.api.createPlaybackSession({ body: { titleId } }), what);
}

function beat(agent: Agent, session: PlaybackSession) {
  return agent.api.sendHeartbeat({
    params: { id: session.id },
    body: { positionSec: 10, durationSec: session.durationSec, state: "playing" },
  });
}

export const planChecks: CheckDefinition[] = [
  {
    id: "plans.catalogue",
    area: "plans",
    title: "Plans: Basic 1 stream/720p, Standard 2/1080p, Premium 4/2160p",
    async run(ctx: CheckContext) {
      const plans = await succeeds(() => ctx.agent("plans").api.listPlans(), "GET /plans");
      equal(plans.items.map((plan) => plan.id).join(","), "basic,standard,premium", "plan ids");
      equal(plans.items.map((plan) => plan.maxStreams).join(","), "1,2,4", "maxStreams");
      equal(
        plans.items.map((plan) => plan.maxVideoHeight).join(","),
        "720,1080,2160",
        "maxVideoHeight",
      );
      const prices = plans.items.map((plan) => plan.monthlyPrice.amountMinor);
      check(
        prices.every((price, index) => index === 0 || price > (prices[index - 1] ?? 0)),
        "prices do not increase with the plan",
        {
          observed: prices.join(","),
        },
      );
      equal(plans.items.filter((plan) => plan.highlighted).length, 1, "highlighted plans");
    },
  },
  {
    id: "plans.stream-limit",
    area: "plans",
    title: "Basic allows one stream across devices; stopping or signing out releases it",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.viewer("stream-limit", { plan: "basic" });
      const [first, second] = await movies(ctx.env, 2);
      check(first && second, "need two movies");
      const a = viewer.agent;
      const b = await device(ctx.env, viewer.account, viewer.profile.id, "stream-limit-b");
      const playing = await start(a, first.id, "device A starts");
      const blocked = await rejects(
        () => b.api.createPlaybackSession({ body: { titleId: first.id } }),
        "stream_limit_reached",
        "device B starts while A plays (Basic: 1 stream)",
      );
      equal(blocked.problem.limit, 1, "stream_limit_reached.limit");
      equal(
        blocked.problem.activeStreams.map((stream) => stream.playbackSessionId).join(","),
        playing.id,
        "active streams listed",
      );
      const active = blocked.problem.activeStreams[0];
      check(
        active?.deviceLabel === "Chrome on macOS" && active.titleName === first.name,
        "active stream lacks device or title",
        {
          observed: JSON.stringify(active),
        },
      );
      const switched = await start(
        a,
        second.id,
        "device A switches title (replaces its own stream)",
      );
      await rejects(
        () => beat(a, playing),
        "playback_session_ended",
        "heartbeat of A's replaced session",
      );
      await rejects(
        () => b.api.createPlaybackSession({ body: { titleId: first.id } }),
        "stream_limit_reached",
        "B while A plays its second title",
      );
      await succeeds(() => a.api.endPlaybackSession({ params: { id: switched.id } }), "A stops");
      const bPlaying = await start(b, first.id, "B starts right after A stopped");
      await rejects(
        () => a.api.createPlaybackSession({ body: { titleId: first.id } }),
        "stream_limit_reached",
        "A while B plays",
      );
      await succeeds(() => b.api.logout(), "B signs out");
      const again = await start(a, first.id, "A starts right after B signed out");
      await rejects(
        () =>
          b.api.sendHeartbeat({
            params: { id: bPlaying.id },
            body: { positionSec: 1, durationSec: 1, state: "playing" },
          }),
        "unauthenticated",
        "B after sign-out",
      );
      await succeeds(() => a.api.endPlaybackSession({ params: { id: again.id } }), "cleanup");
    },
  },
  {
    id: "plans.change-effects",
    area: "plans",
    title: "Downgrade ends the newest extra stream and lowers quality; upgrade adds screens",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.viewer("plan-change", { plan: "standard" });
      const [title] = await movies(ctx.env, 1);
      check(title, "need a movie");
      const a = viewer.agent;
      const b = await device(ctx.env, viewer.account, viewer.profile.id, "plan-change-b");
      const c = await device(ctx.env, viewer.account, viewer.profile.id, "plan-change-c");
      const older = await start(a, title.id, "A starts");
      await ctx.sleep(20);
      const newer = await start(b, title.id, "B starts");
      const blocked = await rejects(
        () => c.api.createPlaybackSession({ body: { titleId: title.id } }),
        "stream_limit_reached",
        "C on Standard (2 streams)",
      );
      equal(blocked.problem.limit, 2, "Standard stream limit");
      const downgraded = await succeeds(
        () => a.api.changePlan({ body: { planId: "basic" } }),
        "downgrade to Basic",
      );
      equal(downgraded.plan.id, "basic", "plan after downgrade");
      equal(downgraded.subscription.status, "active", "status after downgrade");
      await rejects(
        () => beat(b, newer),
        "playback_session_ended",
        "heartbeat of the newest stream after the downgrade",
      );
      await succeeds(() => beat(a, older), "heartbeat of the oldest stream after the downgrade");
      const session = await succeeds(() => a.api.getSession(), "GET /session");
      equal(session.authenticated && session.plan?.id, "basic", "plan in the session bootstrap");
      const capped = await start(a, title.id, "A restarts on Basic");
      equal(capped.maxVideoHeight, 720, "maxVideoHeight on Basic");
      const upgraded = await succeeds(
        () => a.api.changePlan({ body: { planId: "premium" } }),
        "upgrade to Premium (prorated, stored card)",
      );
      equal(upgraded.plan.id, "premium", "plan after upgrade");
      const bAgain = await start(b, title.id, "B starts on Premium");
      const cNow = await start(c, title.id, "C starts on Premium");
      // Card data is refused before anything changes (a card goes to the provider only).
      const withCard = await a.fetch(`${API}/account/subscription`, {
        method: "PUT",
        headers: CSRF,
        body: {
          planId: "standard",
          payment: {
            method: "card",
            cardNumber: "4000 0000 0000 0002",
            expMonth: 12,
            expYear: new Date().getUTCFullYear() + 3,
            cvc: "123",
            nameOnCard: "Smoke Test",
          },
        },
      });
      problem(withCard, "validation_failed", "a plan change carrying a card");
      const account = await succeeds(() => a.api.getAccount(), "GET /account");
      equal(account.plan?.id, "premium", "plan after the refused change (unchanged)");
      for (const [agent, item] of [
        [a, capped],
        [b, bAgain],
        [c, cNow],
      ] as const) {
        await succeeds(() => agent.api.endPlaybackSession({ params: { id: item.id } }), "cleanup");
      }
    },
  },
  {
    id: "plans.cancel-resume",
    area: "plans",
    title: "Cancel keeps access until the period ends; resume reactivates",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.viewer("cancel", { plan: "standard" });
      const api = viewer.agent.api;
      const canceled = await succeeds(() => api.cancelMembership(), "DELETE /account/subscription");
      equal(canceled.subscription.status, "canceling", "status after cancel");
      check(canceled.subscription.canceledAt, "canceledAt after cancel");
      check(
        Date.parse(canceled.subscription.currentPeriodEnd) > Date.now(),
        "the paid period must still run",
      );
      equal(canceled.plan.id, "standard", "plan after cancel");
      const again = await succeeds(() => api.cancelMembership(), "cancel again (idempotent)");
      equal(
        again.subscription.canceledAt,
        canceled.subscription.canceledAt,
        "canceledAt after a second cancel",
      );
      const state = await succeeds(() => api.getSession(), "GET /session");
      equal(
        state.authenticated && state.subscription?.status,
        "canceling",
        "session subscription status",
      );
      const [title] = await movies(ctx.env, 1);
      check(title, "need a movie");
      const session = await start(viewer.agent, title.id, "playback while canceling");
      await succeeds(() => api.endPlaybackSession({ params: { id: session.id } }), "stop");
      const resumed = await succeeds(
        () => api.resumeMembership(),
        "POST /account/subscription/resume",
      );
      equal(resumed.subscription.status, "active", "status after resume");
      equal(resumed.subscription.canceledAt, null, "canceledAt after resume");
      const account = await succeeds(() => api.getAccount(), "GET /account");
      equal(account.subscription?.status, "active", "account status after resume");
    },
  },
  {
    id: "plans.payment-budget",
    area: "plans",
    title:
      "Money-moving requests are limited per account (`payment`): the checkout's confirmation and every plan change count; another account is unaffected",
    async run(ctx: CheckContext) {
      // Dev keeps the production budget here, so both documented profiles agree.
      const spec = expectedSpec(ctx.env, "payment", "strict");
      if (!spec) ctx.skip("custom --rate-limits without a payment limit: nothing to compare with");
      const account = await ctx.env.signup("payment-budget", { plan: "standard" });
      await ctx.env.holder(account);
      const agent = ctx.agent("payment-budget", { retryOn429: false });
      for (const [name, value] of account.agent.jar.snapshot()) agent.jar.set(name, value);
      const change = (planId: "basic" | "standard") =>
        agent.fetch(`${API}/account/subscription`, {
          method: "PUT",
          headers: CSRF,
          body: { planId },
          retryOn429: false,
        });
      // The checkout's confirmation already spent one.
      let admitted = 1;
      let limited: HttpResult | null = null;
      while (!limited && admitted < spec.limit + 5) {
        const result = await change(admitted % 2 === 1 ? "basic" : "standard");
        if (result.status === 429) limited = result;
        else {
          equal(result.status, 200, "a plan change within the limit", result.exchange);
          admitted += 1;
        }
      }
      check(limited, "plan changes are never rate limited", {
        expected: `429 after ${spec.limit} per ${spec.windowSec}s`,
        observed: `${admitted} admitted`,
      });
      if (admitted !== spec.limit) {
        fail("the account's money-moving requests were limited at a different count", {
          expected: `${spec.limit} admitted (payment ${spec.limit}/${spec.windowSec}s, per account)`,
          observed: `${admitted} admitted (the checkout's confirmation included)`,
        });
      }
      problem(limited, "rate_limited", "a plan change over the limit");
      // Per account: another account's plan change still goes through.
      const other = await ctx.env.viewer("payment-budget-other", { plan: "standard" });
      await succeeds(
        () => other.agent.api.changePlan({ body: { planId: "basic" } }),
        "another account's plan change",
      );
    },
  },
];
