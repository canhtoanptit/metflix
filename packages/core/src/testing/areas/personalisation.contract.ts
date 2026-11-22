import { describe, expect, it } from "vitest";
import type { AuditRecord } from "../../areas/experiments/audit.ts";
import type {
  EditorialCollectionRecord,
  TitleAvailabilityRecord,
} from "../../areas/personalisation/repository.ts";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface PersonalisationRepositoryHarness extends HarnessBase {
  repos: Repositories;
  /** Audit rows written so far (optional: the audit assertions run where a runner reads them). */
  auditRows?(): Promise<Pick<AuditRecord, "id" | "action" | "target">[]>;
}

const NOW = Date.UTC(2026, 10, 22, 12);

function audit(id: string, action: string, type: string, target: string): AuditRecord {
  return {
    id,
    actor: { type: "staff", id: "staff-1", name: "Ada" },
    action,
    target: { type, id: target },
    before: null,
    after: null,
    reason: "Holiday campaign",
    requestId: null,
    createdAt: NOW,
  };
}

function collection(overrides: Partial<EditorialCollectionRecord> = {}): EditorialCollectionRecord {
  return {
    id: "col-winter",
    name: "Winter Nights",
    description: null,
    view: "home",
    position: 3,
    status: "published",
    // 40 items: two INSERTs under the 100-parameter limit.
    titleIds: Array.from({ length: 40 }, (_, index) => `t-${String(index).padStart(2, "0")}`),
    createdAt: NOW,
    updatedAt: NOW,
    updatedBy: "staff-1",
    ...overrides,
  };
}

/**
 * Contract of the personalisation area's editorial repository (`repos.personalisation`), run
 * against memory, SQLite, PostgreSQL and D1: billboards, curated collections and availability
 * round-trip, each change carries its audit row, and serving's one read sees published
 * collections only.
 */
export function describePersonalisationRepositoryContract(
  name: string,
  factory: HarnessFactory<PersonalisationRepositoryHarness>,
): void {
  describe(`PersonalisationRepository contract: ${name}`, () => {
    const h = useHarness(factory);

    it("starts empty", async () => {
      const repo = h().repos.personalisation;
      expect(await repo.loadEditorial()).toEqual({
        billboards: [],
        collections: [],
        availability: [],
      });
      expect(await repo.getBillboard("home")).toBeNull();
      expect(await repo.listCollections()).toEqual([]);
      expect(await repo.getAvailability("t-orbit")).toBeNull();
    });

    it("pins and replaces a view's billboard", async () => {
      const repo = h().repos.personalisation;
      const record = {
        view: "home" as const,
        titleIds: ["t-orbit", "t-thaw"],
        updatedAt: NOW,
        updatedBy: "staff-1",
      };
      await repo.setBillboard(record, audit("a-1", "editorial.billboard", "billboard", "home"));
      expect(await repo.getBillboard("home")).toEqual(record);
      await repo.setBillboard(
        { ...record, titleIds: [], updatedAt: NOW + 1 },
        audit("a-2", "editorial.billboard", "billboard", "home"),
      );
      expect((await repo.getBillboard("home"))?.titleIds).toEqual([]);
      expect((await repo.loadEditorial()).billboards).toHaveLength(1);
      const rows = await h().auditRows?.();
      if (rows) expect(rows.map((row) => row.id)).toEqual(["a-1", "a-2"]);
    });

    it("saves, replaces and deletes curated collections with their items in order", async () => {
      const repo = h().repos.personalisation;
      await repo.saveCollection(
        collection(),
        audit("a-1", "editorial.collection_create", "collection", "col-winter"),
      );
      expect(await repo.getCollection("col-winter")).toEqual(collection());
      await repo.saveCollection(
        collection({ titleIds: ["t-b", "t-a"], name: "Winter", updatedAt: NOW + 1 }),
        audit("a-2", "editorial.collection_update", "collection", "col-winter"),
      );
      expect(await repo.getCollection("col-winter")).toMatchObject({
        name: "Winter",
        titleIds: ["t-b", "t-a"],
        createdAt: NOW,
        updatedAt: NOW + 1,
      });
      await repo.saveCollection(
        collection({ id: "col-draft", status: "draft", view: "series", position: 1 }),
        audit("a-3", "editorial.collection_create", "collection", "col-draft"),
      );
      expect((await repo.listCollections()).map((entry) => entry.id)).toEqual([
        "col-winter",
        "col-draft",
      ]);
      // Serving sees published collections only.
      expect((await repo.loadEditorial()).collections.map((entry) => entry.id)).toEqual([
        "col-winter",
      ]);
      expect(
        await repo.deleteCollection(
          "col-winter",
          audit("a-4", "editorial.collection_delete", "collection", "col-winter"),
        ),
      ).toBe(true);
      expect(
        await repo.deleteCollection(
          "col-winter",
          audit("a-5", "editorial.collection_delete", "collection", "col-winter"),
        ),
      ).toBe(false);
      expect(await repo.getCollection("col-winter")).toBeNull();
      const rows = await h().auditRows?.();
      if (rows) expect(rows.map((row) => row.id)).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    });

    it("keeps availability overrides", async () => {
      const repo = h().repos.personalisation;
      const record: TitleAvailabilityRecord = {
        titleId: "t-orbit",
        available: true,
        availableFrom: NOW,
        availableUntil: NOW + 86_400_000,
        updatedAt: NOW,
        updatedBy: "staff-1",
      };
      await repo.setAvailability(
        record,
        audit("a-1", "editorial.availability", "title", "t-orbit"),
      );
      expect(await repo.getAvailability("t-orbit")).toEqual(record);
      await repo.setAvailability(
        { ...record, available: false, availableFrom: null, availableUntil: null },
        audit("a-2", "editorial.availability", "title", "t-orbit"),
      );
      expect((await repo.loadEditorial()).availability).toEqual([
        { ...record, available: false, availableFrom: null, availableUntil: null },
      ]);
    });
  });
}
