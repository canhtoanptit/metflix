/**
 * The demo run (docs/RECOMMENDATIONS.md, "A demo run"): written in the pipeline's artefact
 * format, labelled as demo data, imported by the real importer (checksums included) and served
 * as learned lists to the demo account's unrestricted profiles.
 */
import { describe, expect, it } from "vitest";
import {
  DemoRunRefusedError,
  demoRunId,
  isDemoRun,
  publishDemoRecommendations,
  writeDemoRecommendations,
} from "../../src/areas/personalisation/demo-run.ts";
import { MemoryBlobStore } from "../../src/memory/index.ts";
import {
  createTestServices,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  type TestServices,
  writeRecsVersion,
} from "../../src/testing/index.ts";
import { demoViewer } from "../services/helpers.ts";

const DAY = 86_400_000;

async function json(blobs: MemoryBlobStore, key: string): Promise<Record<string, unknown>> {
  const object = await blobs.get(key);
  if (!object) throw new Error(`${key} missing`);
  return JSON.parse(await new Response(object.body).text()) as Record<string, unknown>;
}

function demoInput(t: TestServices, blobs: MemoryBlobStore) {
  return {
    personalisation: t.services.personalisation,
    blobs,
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
    pseudonymKey: t.deps.config.events.pseudonymKey,
    now: t.clock.now(),
  };
}

describe("demo run", () => {
  it("is labelled as demo data in its run id and its manifest, and published by its pointer", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const now = t.clock.now();
    const result = await writeDemoRecommendations({ ...demoInput(t, blobs), publish: true });

    expect(result.run).toBe(demoRunId(now));
    expect(result.run).toMatch(/^\d{8}-\d{6}-de00de00$/);
    expect(isDemoRun(result.run)).toBe(true);
    expect(isDemoRun("20261122-000000-0fdd31cd")).toBe(false);
    // Restricted profiles (kids, a lowered ceiling) never get lists, as in the pipeline.
    expect(result.skipped).toEqual(["pr-kids"]);
    expect(result.profiles.map((profile) => profile.profileId)).toEqual(["pr-demo", "pr-locked"]);
    expect(result.neighbourRows).toBeGreaterThan(0);

    const pointer = await json(blobs, "recs/current.json");
    expect(pointer).toMatchObject({ run: result.run, manifest: result.manifestKey });
    const manifest = await json(blobs, result.manifestKey);
    expect(manifest).toMatchObject({
      run: result.run,
      code: { demo: true },
      data: { demoAccount: FIXTURE_DEMO_ACCOUNT.email },
    });
    expect(Date.parse(String(manifest.expiresAt)) - now).toBe(3 * DAY);
  });

  it("is imported through the importer and served as learned lists to the demo profiles", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const { demo, imported } = await publishDemoRecommendations(demoInput(t, blobs));
    expect(imported).toMatchObject({ status: "imported", run: demo.run });
    // The importer verified the pointer's manifest digest (it records it).
    expect((await t.services.personalisation.recommendationStatus()).activeModel?.run).toBe(
      demo.run,
    );

    const viewer = await demoViewer(t);
    const page = await t.services.browse.getBrowse(viewer, "home", undefined);
    expect(page.policy?.id).toBe(`demo:${demo.run}`);
    const kids = await demoViewer(t, "pr-kids");
    expect((await t.services.browse.getBrowse(kids, "home", undefined)).policy?.id).toBe("rules");

    // The lists follow the rules the pipeline's lists follow: nothing disliked, nothing started.
    const stored = await t.deps.recommendations.profileLists(
      demo.run,
      await t.services.personalisation.serving.profileKey("pr-demo"),
      t.clock.now(),
    );
    expect(stored).not.toBeNull();
    const rows = stored?.rows ?? [];
    const personal = rows.find((row) => row.type === "personal")?.items.map(([id]) => id) ?? [];
    expect(personal.length).toBeGreaterThan(0);
    expect(personal).not.toContain("t-copper"); // disliked
    expect(personal).not.toContain("t-saltwater"); // in progress
    const topPicks = rows.find((row) => row.type === "top-picks")?.items ?? [];
    expect(topPicks.length).toBeGreaterThan(0);
    for (const [, score] of topPicks) expect(score).toBeGreaterThan(0);
    for (const [, score] of topPicks) expect(score).toBeLessThan(1);
    expect(rows.some((row) => row.type === "because-you-watched")).toBe(true);
  });

  it("goes through the importer's checksums: a tampered file is refused and nothing changes", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const written = await writeDemoRecommendations({ ...demoInput(t, blobs), publish: true });
    const shard = (await blobs.list({ prefix: `recs/v=${written.run}/profiles/` })).items[0];
    if (!shard) throw new Error("no profile shard");
    const object = await blobs.get(shard.key);
    const bytes = new Uint8Array(await new Response(object?.body).arrayBuffer());
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
    await blobs.put(shard.key, bytes);

    await expect(
      t.services.personalisation.importRecommendations({ artefacts: blobs }),
    ).rejects.toThrow(/SHA-256/);
    expect((await t.services.personalisation.recommendationStatus()).activeModel).toBeNull();
  });

  it("refuses to replace a fresh pipeline run unless told to; replaces a demo run or a stale one", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const now = t.clock.now();
    const pipelineRun = "20260614-000000-0123abcd";
    await writeRecsVersion(blobs, {
      run: pipelineRun,
      asOf: now - DAY,
      expiresAt: now + 2 * DAY,
      neighbours: [],
      profiles: [],
    });
    await t.services.personalisation.importRecommendations({ artefacts: blobs });

    await expect(publishDemoRecommendations(demoInput(t, blobs))).rejects.toBeInstanceOf(
      DemoRunRefusedError,
    );
    // Nothing was written: the pipeline's pointer still names its run.
    expect((await json(blobs, "recs/current.json")).run).toBe(pipelineRun);

    const first = await publishDemoRecommendations({ ...demoInput(t, blobs), replace: true });
    expect(first.imported.status).toBe("imported");

    // A demo run is replaced by the next one without --replace.
    t.clock.advance(60_000);
    const second = await publishDemoRecommendations(demoInput(t, blobs));
    expect(second.demo.run).not.toBe(first.demo.run);
    expect(second.imported).toMatchObject({ status: "imported", previous: first.demo.run });

    // Published like a pipeline run: the scheduled import finds it already served.
    const again = await t.services.personalisation.importRecommendations({ artefacts: blobs });
    expect(again.status).toBe("unchanged");
  });

  it("files lists under the keys the given pseudonym key derives (the serving runtime's own)", async () => {
    const t = await createTestServices();
    const blobs = new MemoryBlobStore({ clock: t.clock });
    const result = await writeDemoRecommendations({
      ...demoInput(t, blobs),
      pseudonymKey: "another-runtime-key-another-runtime-key",
      publish: false,
    });
    expect(await blobs.head("recs/current.json")).toBeNull();
    const ownKey = await t.services.personalisation.serving.profileKey("pr-demo");
    expect(result.profiles.find((p) => p.profileId === "pr-demo")?.profileKey).not.toBe(ownKey);
  });
});
