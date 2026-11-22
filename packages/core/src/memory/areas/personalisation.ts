import type { AuditRecord } from "../../areas/experiments/audit.ts";
import type {
  EditorialBillboardRecord,
  EditorialCollectionRecord,
  PersonalisationRepository,
  TitleAvailabilityRecord,
} from "../../areas/personalisation/repository.ts";

/** In-memory `PersonalisationRepository`; `audit` holds the audit rows it was given (tests). */
export interface MemoryPersonalisationRepository extends PersonalisationRepository {
  readonly audit: readonly AuditRecord[];
}

export function createMemoryPersonalisationRepository(): MemoryPersonalisationRepository {
  const billboards = new Map<string, EditorialBillboardRecord>();
  const collections = new Map<string, EditorialCollectionRecord>();
  const availability = new Map<string, TitleAvailabilityRecord>();
  const audit: AuditRecord[] = [];
  const copy = <T>(value: T): T => structuredClone(value);

  return {
    audit,
    async loadEditorial() {
      return {
        billboards: [...billboards.values()].map(copy),
        collections: [...collections.values()]
          .filter((collection) => collection.status === "published")
          .sort(
            (a, b) =>
              a.view.localeCompare(b.view) || a.position - b.position || a.id.localeCompare(b.id),
          )
          .map(copy),
        availability: [...availability.values()].map(copy),
      };
    },
    async getBillboard(view) {
      const found = billboards.get(view);
      return found ? copy(found) : null;
    },
    async setBillboard(record, row) {
      billboards.set(record.view, copy(record));
      audit.push(copy(row));
    },
    async listCollections() {
      return [...collections.values()]
        .sort(
          (a, b) =>
            a.view.localeCompare(b.view) || a.position - b.position || a.id.localeCompare(b.id),
        )
        .map(copy);
    },
    async getCollection(id) {
      const found = collections.get(id);
      return found ? copy(found) : null;
    },
    async saveCollection(record, row) {
      collections.set(record.id, copy(record));
      audit.push(copy(row));
    },
    async deleteCollection(id, row) {
      if (!collections.delete(id)) return false;
      audit.push(copy(row));
      return true;
    },
    async getAvailability(titleId) {
      const found = availability.get(titleId);
      return found ? copy(found) : null;
    },
    async setAvailability(record, row) {
      availability.set(record.titleId, copy(record));
      audit.push(copy(row));
    },
  };
}
