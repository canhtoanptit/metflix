/**
 * Recommendations and privacy (the privacy review's M3, L1 and M6; the pipeline review's L6):
 * no list is stored for a subject being or having been erased, nor for a profile that became
 * restricted; a member who withdrew personalisation gets the rule engine from that moment and
 * across imports, and is never exposed to the experiment; the export holds the lists kept; a
 * demo run's pages say so and expose nobody.
 */
import { describe, expect, it, vi } from "vitest";
import { publishDemoRecommendations } from "../../src/areas/personalisation/demo-run.ts";
import { MemoryBlobStore } from "../../src/memory/index.ts";
import type { ProfileListRow } from "../../src/ports/recommendation-store.ts";
import { experimentDefinition } from "../../src/testing/experiments.contract.ts";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  makeProfileRow,
  type TestServices,
  writeRecsVersion,
} from "../../src/testing/index.ts";
import { demoViewer } from "../services/helpers.ts";

const DAY = 86_400_000;
const LISTS: ProfileListRow[] = [
  {
    type: "personal",
    param: null,
    items: [
      ["t-hours", 0.4],
      ["t-tides", 0.35],
    ],
  },
  {
    type: "top-picks",
    param: null,
    items: [
      ["t-tides", 0.35],
      ["t-hours", 0.4],
    ],
  },
];

function runId(index: number): string {
  return `2026061${index}-000000-0123abc${index}`;
}

/** Publishes and imports a run with lists for `profileIds` (data up to `asOf`). */
async function publish(
  t: TestServices,
  blobs: MemoryBlobStore,
  run: string,
  profileIds: readonly string[],
  asOf = t.clock.now() - DAY,
) {
  const now = t.clock.now();
  await writeRecsVersion(blobs, {
    run,
    asOf,
    expiresAt: now + 2 * DAY,
    neighbours: [{ titleId: "t-orbit", rank: 1, neighbourId: "t-pebble", score: 0.9, support: 9 }],
    profiles: await Promise.all(
      profileIds.map(async (profileId) => ({
        profileKey: await t.services.personalisation.serving.profileKey(profileId),
        run,
        generatedAt: now - DAY,
        expiresAt: now + 2 * DAY,
        rows: LISTS,
      })),
    ),
  });
  return t.services.personalisation.importRecommendations({ artefacts: blobs });
}

async function stored(t: TestServices, run: string, profileId: string) {
  const key = await t.services.personalisation.serving.profileKey(profileId);
  return t.deps.recommendations.profileLists(run, key, t.clock.now());
}

async function policyOf(t: TestServices, profileId = "pr-demo") {
  const viewer = await demoViewer(t, profileId);
  return (await t.services.browse.getBrowse(viewer, "home", undefined)).policy?.id;
}

/** An experiment running with pr-demo in `variant` (assignment is deterministic by salt). */
async function inArm(t: TestServices, variant: "control" | "treatment") {
  for (let salt = 0; salt < 64; salt += 1) {
    t.ports.experiments.set([
      experimentDefinition({ salt: `s${salt}`, startsAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const got = await t.services.experiments.assignments(
      { type: "profile", id: "pr-demo" },
      { restricted: false, country: null, plan: "premium", isNew: false },
    );
    if (got["recs.learned-vs-rules"] === variant) return;
  }
  throw new Error("no salt for the arm");
}

async function exposed(t: TestServices): Promise<boolean> {
  for (const variant of ["control", "treatment"]) {
    const marker = `webflix:v1:exposure:recs.learned-vs-rules:${variant}:profile:pr-demo`;
    if ((await t.deps.cache.get(marker)) !== null) return true;
  }
  return false;
}

describe("the importer stores no list for an erased, a being-erased or a restricted subject (M3)", () => {
  it("withholds a key whose erasure is pending or settled after the run's cutoff", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const key = await t.services.personalisation.serving.profileKey("pr-demo");
    const now = t.clock.now();
    await t.deps.repos.events.addErasures([
      { subjectKey: key, kind: "profile", accountKey: null, requestedAt: now, compactedAt: null },
    ]);
    const pending = await publish(t, blobs, runId(1), ["pr-demo", "pr-locked"]);
    expect(pending).toMatchObject({ status: "imported", profiles: 1, withheldProfiles: 1 });
    expect(await stored(t, runId(1), "pr-demo")).toBeNull();
    expect(await stored(t, runId(1), "pr-locked")).not.toBeNull();

    // The pipeline's erase job ran (at now + 1 h): a run with data from before that may still
    // carry the subject; one with data from after cannot.
    await t.deps.repos.events.markErasuresCompacted([key], now + 3_600_000);
    t.clock.advance(2 * 3_600_000);
    const before = await publish(t, blobs, runId(2), ["pr-demo"], now + 3_000_000);
    expect(before.withheldProfiles).toBe(1);
    expect(await stored(t, runId(2), "pr-demo")).toBeNull();
    const after = await publish(t, blobs, runId(3), ["pr-demo"], now + 3_700_000);
    expect(after).toMatchObject({ profiles: 1, withheldProfiles: 0 });
    expect(await stored(t, runId(3), "pr-demo")).not.toBeNull();
  });

  it("withholds a deleted account's profiles (listed under the account's erasure)", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const now = t.clock.now();
    const accountKey = "aK3vB8nQ2wE5rT7yU9iO1p";
    await t.deps.repos.events.addErasures([
      {
        subjectKey: accountKey,
        kind: "account",
        accountKey: null,
        requestedAt: now,
        compactedAt: null,
      },
      {
        subjectKey: await t.services.personalisation.serving.profileKey("pr-locked"),
        kind: "profile",
        accountKey,
        requestedAt: now,
        compactedAt: null,
      },
    ]);
    const result = await publish(t, blobs, runId(1), ["pr-demo", "pr-locked"]);
    expect(result).toMatchObject({ profiles: 1, withheldProfiles: 1 });
    expect(await stored(t, runId(1), "pr-locked")).toBeNull();
  });

  it("drops a profile's lists from every run when it becomes restricted, and withholds it after", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    await publish(t, blobs, runId(1), ["pr-demo", "pr-locked"]);
    await publish(t, blobs, runId(2), ["pr-demo", "pr-locked"]);
    const viewer = await demoViewer(t);
    // The profiles service calls this seam when a profile becomes kids or capped.
    await t.services.seams.forgetProfileBehaviour({
      accountId: viewer.session.accountId,
      profileId: "pr-demo",
    });
    for (const run of [runId(1), runId(2)]) {
      expect(await stored(t, run, "pr-demo")).toBeNull();
      expect(await stored(t, run, "pr-locked")).not.toBeNull();
    }
    const next = await publish(t, blobs, runId(3), ["pr-demo", "pr-locked"]);
    expect(next.withheldProfiles).toBe(1);
    expect(await stored(t, runId(3), "pr-demo")).toBeNull();
    // A rollback finds nothing of it either.
    await t.services.personalisation.rollbackRecommendations();
    expect(await stored(t, runId(2), "pr-demo")).toBeNull();
  });

  it("applies to the demo run too: it goes through the same importer", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const viewer = await demoViewer(t);
    await t.services.seams.forgetProfileBehaviour({
      accountId: viewer.session.accountId,
      profileId: "pr-locked",
    });
    const { demo, imported } = await publishDemoRecommendations({
      personalisation: t.services.personalisation,
      blobs,
      catalog: FIXTURE_CATALOG,
      demoAccount: FIXTURE_DEMO_ACCOUNT,
      manifest: FIXTURE_MANIFEST,
      pseudonymKey: t.deps.config.events.pseudonymKey,
      now: t.clock.now(),
    });
    expect(demo.profiles.map((profile) => profile.profileId)).toContain("pr-locked");
    expect(imported).toMatchObject({ profiles: demo.profiles.length - 1, withheldProfiles: 1 });
    expect(await stored(t, demo.run, "pr-locked")).toBeNull();
    expect(await stored(t, demo.run, "pr-demo")).not.toBeNull();
  });
});

describe("withdrawing personalisation (L1)", () => {
  it("serves the rule engine from the withdrawal on, across imports, until granted again", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const viewer = await demoViewer(t);
    const accountId = viewer.session.accountId;
    await publish(t, blobs, runId(1), ["pr-demo", "pr-locked"]);
    expect(await policyOf(t)).toBe(`learned:${runId(1)}`);

    await t.services.seams.personalisationConsentChanged({
      accountId,
      granted: false,
      at: t.clock.now(),
    });
    expect(await policyOf(t)).toBe("rules");
    // What was stored for the account's profiles is gone, from every run.
    expect(await stored(t, runId(1), "pr-demo")).toBeNull();
    expect(await stored(t, runId(1), "pr-locked")).toBeNull();
    // A later import brings nothing back (a run built before the withdrawal reached the
    // pipeline still carries them).
    const next = await publish(t, blobs, runId(2), ["pr-demo", "pr-locked"]);
    expect(next.withheldProfiles).toBe(2);
    expect(await policyOf(t)).toBe("rules");
    // Told twice: unchanged.
    await t.services.seams.personalisationConsentChanged({
      accountId,
      granted: false,
      at: t.clock.now(),
    });
    expect(await policyOf(t)).toBe("rules");

    await t.services.seams.personalisationConsentChanged({
      accountId,
      granted: true,
      at: t.clock.now(),
    });
    const granted = await publish(t, blobs, runId(3), ["pr-demo"]);
    expect(granted.withheldProfiles).toBe(0);
    expect(await policyOf(t)).toBe(`learned:${runId(3)}`);
  });

  it("covers the account's profiles created after the withdrawal", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const viewer = await demoViewer(t);
    const accountId = viewer.session.accountId;
    await t.services.seams.personalisationConsentChanged({
      accountId,
      granted: false,
      at: t.clock.now(),
    });
    await t.deps.repos.profiles.createWithinLimit(
      makeProfileRow({ id: "pr-later", accountId, name: "Later" }),
      5,
    );
    await publish(t, blobs, runId(1), ["pr-later"]);
    expect(await policyOf(t, "pr-later")).toBe("rules");
  });

  it("exposes a withdrawn member to neither arm of the experiment", async () => {
    for (const variant of ["control", "treatment"] as const) {
      const t = await createTestServices();
      const blobs = new MemoryBlobStore({ clock: t.clock });
      const viewer = await demoViewer(t);
      await publish(t, blobs, runId(1), ["pr-demo"]);
      await inArm(t, variant);
      await t.services.seams.personalisationConsentChanged({
        accountId: viewer.session.accountId,
        granted: false,
        at: t.clock.now(),
      });
      expect(await policyOf(t)).toBe("rules");
      expect(await exposed(t)).toBe(false);
    }
  });

  it("fails closed: while the withdrawals cannot be read, every page is the rule engine's", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    await publish(t, blobs, runId(1), ["pr-demo"]);
    vi.spyOn(t.deps.repos.personalisation, "loadEditorial").mockRejectedValue(new Error("down"));
    await t.services.personalisation.serving.invalidateEditorial();
    expect(await policyOf(t)).toBe("rules");
  });
});

describe("the data export (M6)", () => {
  it("holds the lists kept for the account's profiles in every run, and the withdrawal", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const viewer = await demoViewer(t);
    const accountId = viewer.session.accountId;
    await publish(t, blobs, runId(1), ["pr-demo"]);
    await publish(t, blobs, runId(2), ["pr-demo", "pr-locked"]);
    const exported = (await t.services.personalisation.exportAccountData(accountId)) as {
      recommendationLists: {
        profileId: string;
        run: string;
        served: boolean;
        expiresAt: string;
        lists: { kind: string; because: string | null; titleIds: string[] }[];
      }[];
      personalisationWithdrawnAt: string | null;
    };
    expect(
      exported.recommendationLists.map((entry) => [entry.profileId, entry.run, entry.served]),
    ).toEqual([
      ["pr-demo", runId(2), true],
      ["pr-demo", runId(1), false],
      ["pr-locked", runId(2), true],
    ]);
    expect(exported.recommendationLists[0]?.lists).toEqual([
      { kind: "personal", because: null, titleIds: ["t-hours", "t-tides"] },
      { kind: "top-picks", because: null, titleIds: ["t-tides", "t-hours"] },
    ]);
    expect(Date.parse(exported.recommendationLists[0]?.expiresAt ?? "")).toBe(
      t.clock.now() + 2 * DAY,
    );
    expect(exported.personalisationWithdrawnAt).toBeNull();

    // The events area's export job asks every area: this part is under `personalisation`.
    await t.services.seams.personalisationConsentChanged({
      accountId,
      granted: false,
      at: t.clock.now(),
    });
    const after = (await t.services.personalisation.exportAccountData(accountId)) as {
      recommendationLists: unknown[];
      personalisationWithdrawnAt: string | null;
    };
    expect(after.recommendationLists).toEqual([]);
    expect(after.personalisationWithdrawnAt).toBe(new Date(t.clock.now()).toISOString());
  });
});

describe("a demo run's pages (pipeline review L6)", () => {
  it("are labelled demo, never learned, and expose nobody to the experiment", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    await inArm(t, "treatment");
    const { demo } = await publishDemoRecommendations({
      personalisation: t.services.personalisation,
      blobs,
      catalog: FIXTURE_CATALOG,
      demoAccount: FIXTURE_DEMO_ACCOUNT,
      manifest: FIXTURE_MANIFEST,
      pseudonymKey: t.deps.config.events.pseudonymKey,
      now: t.clock.now(),
    });
    const viewer = await demoViewer(t);
    const page = await t.services.browse.getBrowse(viewer, "home", undefined);
    expect(page.policy?.id).toBe(`demo:${demo.run}`);
    expect(page.rows.some((row) => row.kind === "top-picks")).toBe(true);
    expect(await exposed(t)).toBe(false);
  });
});
