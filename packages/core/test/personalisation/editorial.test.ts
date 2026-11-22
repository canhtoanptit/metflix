/**
 * Editorial data staff control (milestone 2 §8.3): the service methods behind the staff routes,
 * each with its audit row, and what browse does with them, under the same rules as everything
 * else (maturity, dislikes, availability).
 */
import type { Row } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import type { StaffAction } from "../../src/index.ts";
import type { MemoryPersonalisationRepository } from "../../src/memory/areas/personalisation.ts";
import { createTestServices, type TestServices } from "../../src/testing/index.ts";
import { demoViewer } from "../services/helpers.ts";

const staff: StaffAction = {
  actor: { type: "staff", id: "staff-7", name: "Grace" },
  reason: "Holiday campaign",
  requestId: "req-9",
};

function ids(row: Row | undefined): string[] {
  return (row?.items ?? []).map((item) => ("title" in item ? item.title.id : item.id));
}

async function allRows(t: TestServices, viewer: Awaited<ReturnType<typeof demoViewer>>) {
  const first = await t.services.browse.getBrowse(viewer, "home", undefined);
  const rows = [...first.rows];
  let cursor = first.nextCursor;
  while (cursor) {
    const next = await t.services.browse.getBrowse(viewer, "home", cursor);
    rows.push(...next.rows);
    cursor = next.nextCursor;
  }
  return { first, rows };
}

const auditOf = (t: TestServices) =>
  (t.deps.repos.personalisation as MemoryPersonalisationRepository).audit;

describe("editorial", () => {
  it("pins a billboard (an audit row each time), under the rules for every profile", async () => {
    const t = await createTestServices();
    const demo = await demoViewer(t);
    const kids = await demoViewer(t, "pr-kids");
    expect(await t.services.personalisation.getBillboard("home")).toEqual({
      view: "home",
      titleIds: [],
      updatedAt: null,
    });
    const pinned = await t.services.personalisation.setBillboard(
      "home",
      ["t-copper", "t-thaw"],
      staff,
    );
    expect(pinned.titleIds).toEqual(["t-copper", "t-thaw"]);
    // t-copper is disliked by the demo profile and 18+ for the kids profile: both get t-thaw.
    expect((await t.services.browse.getBrowse(demo, "home", undefined)).billboard?.title.id).toBe(
      "t-thaw",
    );
    expect((await t.services.browse.getBrowse(kids, "home", undefined)).billboard?.title.id).toBe(
      "t-thaw",
    );
    expect(auditOf(t).map((row) => [row.action, row.target.id, row.reason, row.actor.id])).toEqual([
      ["editorial.billboard_set", "home", "Holiday campaign", "staff-7"],
    ]);
    await expect(
      t.services.personalisation.setBillboard("home", ["t-nope"], staff),
    ).rejects.toMatchObject({ code: "not_found" });
    // Unpinning gives the choice back to the engine.
    await t.services.personalisation.setBillboard("home", [], staff);
    expect((await t.services.personalisation.getBillboard("home")).titleIds).toEqual([]);
  });

  it("publishes a curated row at its position, filtered per profile; drafts stay hidden", async () => {
    const t = await createTestServices();
    const demo = await demoViewer(t);
    const kids = await demoViewer(t, "pr-kids");
    const created = await t.services.personalisation.createCollection(
      {
        name: "Winter Nights",
        description: null,
        view: "home",
        position: 2,
        titleIds: ["t-copper", "t-meadow", "t-thaw", "t-owl"],
        status: "published",
      },
      staff,
    );
    await t.services.personalisation.createCollection(
      {
        name: "Draft",
        description: null,
        view: "home",
        position: 1,
        titleIds: ["t-thaw"],
        status: "draft",
      },
      staff,
    );
    const rowId = `home:collection:${created.id}`;
    const demoRows = (await allRows(t, demo)).rows;
    expect(demoRows[1]?.id).toBe(rowId);
    expect(demoRows[1]).toMatchObject({
      kind: "collection",
      title: "Winter Nights",
      layout: "standard",
    });
    // Curated order, less the demo profile's dislike.
    expect(ids(demoRows[1])).toEqual(["t-meadow", "t-thaw", "t-owl"]);
    expect(demoRows.some((row) => row.title === "Draft")).toBe(false);
    // The kids profile sees only what its ceiling allows.
    const kidsRow = (await allRows(t, kids)).rows.find((row) => row.id === rowId);
    expect(ids(kidsRow).every((id) => ["t-meadow", "t-thaw", "t-owl"].includes(id))).toBe(true);
    expect(ids(kidsRow)).not.toContain("t-copper");
    // Row pages agree with the page.
    expect(ids(await t.services.browse.getRow(demo, rowId, undefined, undefined))).toEqual(
      ids(demoRows[1]),
    );

    const updated = await t.services.personalisation.updateCollection(
      created.id,
      { ...created, titleIds: ["t-owl", "t-thaw"], description: "Cosy" },
      staff,
    );
    expect(updated.titleIds).toEqual(["t-owl", "t-thaw"]);
    expect((await t.services.personalisation.listCollections()).items).toHaveLength(2);
    await t.services.personalisation.deleteCollection(created.id, staff);
    expect((await allRows(t, demo)).rows.some((row) => row.id === rowId)).toBe(false);
    await expect(
      t.services.personalisation.deleteCollection(created.id, staff),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    expect(auditOf(t).map((row) => row.action)).toEqual([
      "editorial.collection_create",
      "editorial.collection_create",
      "editorial.collection_update",
      "editorial.collection_delete",
    ]);
    expect(auditOf(t)[2]?.before).toMatchObject({
      titleIds: ["t-copper", "t-meadow", "t-thaw", "t-owl"],
    });
    expect(auditOf(t)[2]?.after).toMatchObject({
      titleIds: ["t-owl", "t-thaw"],
      description: "Cosy",
    });
  });

  it("answers a direct link to an unavailable title as not found, and search leaves it out", async () => {
    const t = await createTestServices();
    const demo = await demoViewer(t);
    const searchIds = async (q: string) => {
      const found = await t.services.search.search(demo, { q });
      return {
        results: found.results.map((card) => card.id),
        suggestions: found.suggestions.flatMap((hit) => (hit.kind === "title" ? [hit.id] : [])),
      };
    };
    expect((await searchIds("small hours")).results).toContain("t-hours");
    expect((await t.services.browse.getTitle(demo, "t-hours")).id).toBe("t-hours");
    await t.services.personalisation.setTitleAvailability("t-hours", { available: false }, staff);
    await t.services.personalisation.setTitleAvailability(
      "t-starlings",
      { available: false },
      staff,
    );
    await expect(t.services.browse.getTitle(demo, "t-hours")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(t.services.browse.listSimilar(demo, "t-hours")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(t.services.browse.listEpisodes(demo, "t-starlings", 1)).rejects.toMatchObject({
      code: "not_found",
    });
    const after = await searchIds("small hours");
    expect(after.results).not.toContain("t-hours");
    expect(after.suggestions).not.toContain("t-hours");
    expect((await searchIds("starlings")).results).not.toContain("t-starlings");
    // Back in its window: offered again everywhere.
    await t.services.personalisation.setTitleAvailability("t-hours", { available: true }, staff);
    expect((await t.services.browse.getTitle(demo, "t-hours")).id).toBe("t-hours");
    expect((await searchIds("small hours")).results).toContain("t-hours");
  });

  it("takes an unavailable title off every browse surface, and puts it back on its date", async () => {
    const t = await createTestServices();
    const demo = await demoViewer(t);
    const everywhere = async () => {
      const { first, rows } = await allRows(t, demo);
      const genre = await t.services.browse.getGenrePage(demo, "drama", {});
      return [
        first.billboard?.title.id,
        ...rows.flatMap(ids),
        ...genre.items.map((card) => card.id),
      ];
    };
    expect(await everywhere()).toContain("t-hours");
    const availability = await t.services.personalisation.setTitleAvailability(
      "t-hours",
      { available: false },
      staff,
    );
    expect(availability).toMatchObject({ titleId: "t-hours", available: false });
    expect(await everywhere()).not.toContain("t-hours");
    expect(await t.services.personalisation.isTitleUnavailable("t-hours")).toBe(true);
    expect(await t.services.personalisation.isTitleUnavailable("t-thaw")).toBe(false);
    // Available again from tomorrow: hidden until then.
    const tomorrow = new Date(t.clock.now() + 86_400_000).toISOString();
    await t.services.personalisation.setTitleAvailability(
      "t-hours",
      { available: true, availableFrom: tomorrow },
      staff,
    );
    expect(await everywhere()).not.toContain("t-hours");
    t.clock.advance(86_400_000 + 31_000);
    expect(await everywhere()).toContain("t-hours");
    await expect(
      t.services.personalisation.setTitleAvailability(
        "t-hours",
        { available: true, availableFrom: tomorrow, availableUntil: tomorrow },
        staff,
      ),
    ).rejects.toMatchObject({ code: "validation_failed" });
    expect(auditOf(t).map((row) => row.action)).toEqual([
      "editorial.availability_set",
      "editorial.availability_set",
    ]);
  });
});
