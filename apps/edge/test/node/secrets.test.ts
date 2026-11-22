/**
 * The Worker's secrets (lib/secrets.ts): the per-clone `.dev.vars`, what a production deploy
 * may set, and the throwaway values Node tooling composes the config with. Each assertion is a
 * mistake that would otherwise surface as a 503 on a real account, or a replaced key.
 */
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { MEDIA_KEYS_SECRET, parseKeys } from "../../scripts/lib/media-keys.ts";
import { WRANGLER_CONFIG } from "../../scripts/lib/platform.ts";
import {
  assignedNames,
  completeDevVars,
  GENERATED_SECRETS,
  PSEUDONYM_KEY_SECRET,
  planSecrets,
  toolingSecrets,
} from "../../scripts/lib/secrets.ts";
import { type Env, loadEdgeConfig } from "../../src/env.ts";

const read = (env?: string) =>
  unstable_readConfig({ config: WRANGLER_CONFIG, ...(env ? { env } : {}) }, { hideWarnings: true });
const required = read().secrets?.required ?? [];

describe(".dev.vars", () => {
  it("assigns every required secret: random keys generated, provider credentials empty", () => {
    const { text, added } = completeDevVars("", required);
    expect(added).toEqual(required);
    expect([...assignedNames(text)].sort()).toEqual([...required].sort());
    const values = Object.fromEntries(
      text
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(parseKeys(values[MEDIA_KEYS_SECRET] ?? "")).toHaveLength(1);
    expect(values[PSEUDONYM_KEY_SECRET]?.length).toBeGreaterThanOrEqual(32);
    for (const name of required.filter((name) => !(name in GENERATED_SECRETS))) {
      expect(values[name], name).toBe("");
    }
    // The local Worker composes from exactly that file: outbox, fake provider, real local keys.
    const config = loadEdgeConfig({
      ...(read().vars as Record<string, string>),
      ...values,
    } as unknown as Env);
    expect(config.core.events.pseudonymKey).toBe(values[PSEUDONYM_KEY_SECRET]);
    expect(config.core.billing.paymentProvider).toBe("fake");
  });

  it("keeps what a clone already has and only appends what the list gained", () => {
    const existing =
      "WEBFLIX_MEDIA_TOKEN_KEYS=local:keep-me-keep-me-keep-me-keep-me-keep\nSTRIPE_SECRET_KEY=sk_test_mine";
    const { text, added } = completeDevVars(existing, required);
    expect(text.startsWith(`${existing}\n`)).toBe(true);
    expect(added).not.toContain(MEDIA_KEYS_SECRET);
    expect(added).not.toContain("STRIPE_SECRET_KEY");
    expect(completeDevVars(text, required)).toEqual({ text, added: [] });
  });
});

describe("production secrets on deploy", () => {
  const productionRequired = read("production").secrets?.required ?? [];

  it("keeps everything already on the Worker, generates only keys, takes credentials from the environment", () => {
    const plan = planSecrets(
      { kind: "listed", names: [MEDIA_KEYS_SECRET, "STRIPE_SECRET_KEY"] },
      productionRequired,
      {
        STRIPE_SECRET_KEY: "sk_live_ignored",
        STRIPE_PUBLISHABLE_KEY: "pk_live_x",
        WEBFLIX_EMAIL_HTTP_API_KEY: "re_x",
      },
    );
    expect(plan.keep).toEqual([MEDIA_KEYS_SECRET, "STRIPE_SECRET_KEY"]);
    expect(plan.generate).toEqual([PSEUDONYM_KEY_SECRET]);
    expect(plan.fromEnvironment.sort()).toEqual([
      "STRIPE_PUBLISHABLE_KEY",
      "WEBFLIX_EMAIL_HTTP_API_KEY",
    ]);
    expect(plan.missing.sort()).toEqual(["STRIPE_WEBHOOK_SECRET", "WEBFLIX_EMAIL_WEBHOOK_SECRET"]);
  });

  it("on a first deploy (no Worker yet) sets every required secret", () => {
    const plan = planSecrets({ kind: "new-worker" }, productionRequired, {});
    expect([...plan.generate, ...plan.missing].sort()).toEqual([...productionRequired].sort());
    expect(plan.keep).toEqual([]);
  });

  it("gives the tooling throwaway values for every secret, enough to compose production", () => {
    const stubs = toolingSecrets();
    expect(Object.keys(stubs).sort()).toEqual([...productionRequired].sort());
    // What `ops.ts seed --target production` and `recs import --target production` do.
    const config = loadEdgeConfig({
      ...(read("production").vars as Record<string, string>),
      ...stubs,
    } as unknown as Env);
    expect(config.core.billing.paymentProvider).toBe("stripe");
    expect(toolingSecrets()[PSEUDONYM_KEY_SECRET]).not.toBe(stubs[PSEUDONYM_KEY_SECRET]);
  });
});
