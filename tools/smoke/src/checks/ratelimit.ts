import type { RateLimitPolicyName } from "@webflix/contracts";
import { check, header, problem } from "../expect.ts";
import type { HttpResult } from "../http.ts";
import {
  admissible,
  burst,
  DOCUMENTED_LIMITS,
  lockedProfile,
  SMOKE_PIN,
  selectProfileRaw,
} from "../limits.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF, tallyStatuses } from "./util.ts";

/** Not `SMOKE_PIN`. */
const WRONG_PIN = "0000";

export const rateLimitChecks: CheckDefinition[] = [
  {
    id: "ratelimit.profile-pin.recovery",
    area: "ratelimit",
    title:
      "PIN guessing is limited per account (every locked profile, every device) and recovers after Retry-After",
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("ratelimit-recovery");
      const locked = await lockedProfile(ctx.env, account, "Recover");
      const sibling = await lockedProfile(ctx.env, account, "Sibling");
      const open = await ctx.env.createProfile(account.agent, { name: "Open" });
      const agent = ctx.agent("ratelimit-recovery", { retryOn429: false });
      for (const [name, value] of account.agent.jar.snapshot()) agent.jar.set(name, value);
      // Wrong PINs, one at a time, until the account's budget runs out.
      let limited: HttpResult | null = null;
      let attempts = 0;
      while (!limited && attempts < ctx.options.burst + 60) {
        attempts += 1;
        const result = await selectProfileRaw(agent, locked.id, WRONG_PIN);
        if (result.status === 429) limited = result;
        else problem(result, "profile_pin_invalid", `wrong PIN attempt ${attempts}`);
      }
      check(limited, "PIN attempts are never rate limited", {
        expected: "429 within the documented limit (5/min strict, 60/min dev)",
        observed: `${attempts} wrong PINs answered profile_pin_invalid`,
      });
      const body = problem(limited, "rate_limited", "PIN attempts over the limit");
      header(
        limited,
        "Retry-After",
        String(body.retryAfterSec),
        "Retry-After equals retryAfterSec",
      );
      // The limit is the account's: another locked profile, from another device, is limited too.
      const device = ctx.agent("ratelimit-recovery-2", { retryOn429: false });
      for (const [name, value] of account.agent.jar.snapshot()) device.jar.set(name, value);
      const elsewhere = await selectProfileRaw(device, sibling.id, SMOKE_PIN);
      check(
        elsewhere.status === 429,
        "switching to another locked profile resets the PIN budget (it must be per account)",
        { expected: "429", observed: String(elsewhere.status), exchange: elsewhere.exchange },
      );
      // Unlocked profiles stay available: the limit is about PINs, not profiles.
      const unlocked = await selectProfileRaw(agent, open.id);
      check(
        unlocked.status === 200,
        "an unlocked profile cannot be selected while PINs are limited",
        {
          expected: "200",
          observed: String(unlocked.status),
          exchange: unlocked.exchange,
        },
      );
      // Another account is not affected: the bucket is per account. The shared browse viewer
      // re-selects its own unlocked profile.
      const other = await ctx.env.browseViewer();
      const neighbour = await selectProfileRaw(other.agent, other.profile.id);
      check(
        neighbour.status === 200,
        "another account was limited too (the bucket must be per account)",
        {
          observed: String(neighbour.status),
          exchange: neighbour.exchange,
        },
      );
      await ctx.sleep(body.retryAfterSec * 1000 + 300);
      const recovered = await selectProfileRaw(agent, locked.id, SMOKE_PIN);
      check(
        recovered.status === 200,
        `still limited ${body.retryAfterSec}s after a 429 (Retry-After)`,
        {
          expected: "200",
          observed: `${recovered.status} ${recovered.exchange.responseBody ?? ""}`,
          exchange: recovered.exchange,
        },
      );
      ctx.note(`limited after ${attempts} wrong PINs; recovered after ${body.retryAfterSec}s`);
    },
  },
  {
    id: "ratelimit.profile-pin.unlocked-free",
    area: "ratelimit",
    title:
      "Selecting unlocked profiles, or a locked one without a PIN, never spends the PIN budget",
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("ratelimit-free");
      const locked = await lockedProfile(ctx.env, account, "Locked");
      const open = await ctx.env.createProfile(account.agent, { name: "Open" });
      const agent = ctx.agent("ratelimit-free", { retryOn429: false });
      for (const [name, value] of account.agent.jar.snapshot()) agent.jar.set(name, value);
      // More switches than any documented PIN limit (60/min in dev), concurrently.
      const switches = await burst(Math.max(ctx.options.burst, 70), () =>
        selectProfileRaw(agent, open.id),
      );
      check(switches.allowed === switches.sent, "switching to an unlocked profile is limited", {
        expected: `${switches.sent}× 200`,
        observed: tallyStatuses(switches.results),
        exchange: switches.results.find((result) => result.status !== 200)?.exchange,
      });
      const withoutPin = await burst(10, () => selectProfileRaw(agent, locked.id));
      const required = withoutPin.results.filter(
        (result) =>
          result.status === 403 && result.json<{ code?: string }>().code === "profile_pin_required",
      );
      check(
        required.length === withoutPin.sent,
        "a locked profile without a PIN answered otherwise",
        {
          expected: `${withoutPin.sent}× 403 profile_pin_required`,
          observed: tallyStatuses(withoutPin.results),
        },
      );
      // The PIN budget is untouched: the right PIN is admitted at once.
      const first = await selectProfileRaw(agent, locked.id, SMOKE_PIN);
      check(first.status === 200, "the first PIN attempt was refused after free switches", {
        expected: "200 (nothing above may count against the PIN limit)",
        observed: `${first.status} ${first.exchange.responseBody ?? ""}`,
        exchange: first.exchange,
      });
      ctx.note(
        `${switches.sent} unlocked switches and ${withoutPin.sent} PIN-less requests admitted; the PIN budget was untouched`,
      );
    },
  },
  {
    id: "ratelimit.strict-defaults",
    area: "ratelimit",
    title: "Strict targets enforce the documented sign-in, sign-up and email-lookup limits",
    tags: ["exclusive", "ip-limit"],
    timeoutMs: 180_000,
    needs: [needs.strictLimits, needs.ipExhaustion],
    async run(ctx: CheckContext) {
      const account = await ctx.env.sharedAccount("identity", { member: false });
      // A browser the account knows: the per-client limits are measured here, not the per-email
      // one (ratelimit.auth-email).
      const agent = ctx.env.knownDevice(account, ctx.agent("strict-limits", { retryOn429: false }));
      const policies: { policy: RateLimitPolicyName; send: () => Promise<HttpResult> }[] = [
        {
          policy: "email-lookup",
          send: () =>
            agent.fetch(
              `${API}/auth/email-status?email=${encodeURIComponent(ctx.env.email("lookup"))}`,
              { retryOn429: false },
            ),
        },
        {
          policy: "auth",
          send: () =>
            agent.fetch(`${API}/auth/login`, {
              method: "POST",
              headers: CSRF,
              body: { email: account.email, password: "definitely-wrong-password" },
              retryOn429: false,
            }),
        },
        {
          // An invalid body: admitted requests answer 400 and create nothing.
          policy: "signup",
          send: () =>
            agent.fetch(`${API}/auth/signup`, {
              method: "POST",
              headers: CSRF,
              body: {},
              retryOn429: false,
            }),
        },
      ];
      for (const { policy, send } of policies) {
        const spec = DOCUMENTED_LIMITS.strict[policy];
        const result = await burst(spec.limit * 2 + 5, send);
        const range = admissible(spec, result.durationMs);
        const admitted = result.sent - result.limited;
        check(result.limited > 0, `${policy} is not limited at the strict default`, {
          expected: `≤ ${range.max} admitted (${spec.limit}/${spec.windowSec}s)`,
          observed: `${admitted} of ${result.sent} admitted: ${tallyStatuses(result.results)}`,
        });
        check(admitted <= range.max, `${policy} admits more than the strict default`, {
          expected: `≤ ${range.max} admitted (${spec.limit}/${spec.windowSec}s; earlier requests this minute only lower it)`,
          observed: `${admitted} of ${result.sent}: ${tallyStatuses(result.results)}`,
        });
        ctx.note(
          `${policy}: ${admitted}/${result.sent} admitted (strict ${spec.limit}/${spec.windowSec}s)`,
        );
      }
    },
  },
];
