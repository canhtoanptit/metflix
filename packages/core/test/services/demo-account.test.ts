/**
 * The shared demo account outlives tampering: what the API refuses to change (sign-in details,
 * membership, profiles) is put back by the next seed run even when the seed itself is unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
} from "../../src/testing/index.ts";
import { DEMO_ACCOUNT, openLogin } from "./helpers.ts";

const INPUT = {
  catalog: FIXTURE_CATALOG,
  demoAccount: FIXTURE_DEMO_ACCOUNT,
  manifest: FIXTURE_MANIFEST,
};
const client = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0" };

describe("the demo account across seed runs", () => {
  it("is restored when its protected state drifted, and left alone otherwise", async () => {
    const t = await createTestServices();
    const { repos, passwords } = t.deps;
    // A takeover from before the API protected it, plus a cancelled membership and a renamed,
    // locked profile.
    await repos.accounts.updateEmail(DEMO_ACCOUNT, "thief@example.com", t.clock.now());
    await repos.accounts.updatePasswordHash(
      DEMO_ACCOUNT,
      await passwords.hash("stolen-password"),
      t.clock.now(),
    );
    const loaded = await repos.accounts.get(DEMO_ACCOUNT);
    if (!loaded) throw new Error("no demo account");
    await repos.accounts.saveSubscription({ ...loaded.subscription, canceledAt: t.clock.now() });
    await repos.profiles.update(DEMO_ACCOUNT, "pr-demo", {
      name: "Owned",
      pinHash: await passwords.hash("0000"),
      updatedAt: t.clock.now(),
    });
    const thief = await t.services.auth.login(
      { email: "thief@example.com", password: "stolen-password" },
      client,
      openLogin,
    );

    const repaired = await t.services.seeder.seed(INPUT);
    expect(repaired).toMatchObject({ skipped: true });
    expect(repaired.demoRestored).toEqual(["email", "password", "membership", "profiles"]);
    expect(await t.services.auth.authenticate(thief.token)).toBeNull();
    const demo = await t.services.auth.login(
      { email: FIXTURE_DEMO_ACCOUNT.email, password: FIXTURE_DEMO_ACCOUNT.password },
      client,
      openLogin,
    );
    expect(demo.state.subscription?.status).toBe("active");
    expect(demo.state.profiles.find((profile) => profile.id === "pr-demo")).toMatchObject({
      name: "Demo",
      isLocked: false,
    });

    // Nothing drifted: nothing is touched (sessions and viewing stay).
    const again = await t.services.seeder.seed(INPUT);
    expect(again.demoRestored).toEqual([]);
    expect(await t.services.auth.authenticate(demo.token)).not.toBeNull();
  });
});
