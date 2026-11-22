import type {
  StaffTitle,
  StaffTitlePage,
  TitleAvailability,
  TitleAvailabilityOverride,
} from "@webflix/contracts";
import * as z from "zod";
import { decodeCursor, encodeCursor, invalidCursor } from "../../domain/cursor.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import type { TitleRecord } from "../../repositories/records.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import { isUnavailable, type TitleAvailabilityRecord } from "./repository.ts";

/**
 * The catalogue as staff see it (the admin console's content screens): every title whatever its
 * maturity, found by name, by id or in name order, and the availability overrides staff set.
 * Nothing here knows about members; the member surfaces are browse, search and title detail.
 */
export interface StaffTitleQuery {
  /** Search text (every maturity level). */
  q?: string | undefined;
  /** Comma-separated title ids, in that order (unknown ids left out). */
  ids?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface StaffTitles {
  staffTitles(query: StaffTitleQuery): Promise<StaffTitlePage>;
  /** A title's availability (no override: available); `not_found` for an unknown title. */
  titleAvailability(titleId: string): Promise<TitleAvailability>;
  /** Every override, with the title's name and whether it hides the title now. */
  listTitleAvailability(): Promise<TitleAvailabilityOverride[]>;
}

/** The catalogue is read at most this often for staff (it changes with a re-seed). */
const SNAPSHOT_MEMO_MS = 30_000;
const DEFAULT_PAGE = 20;
const ListCursor = z.object({ o: z.number().int().nonnegative() });
const SearchCursor = z.object({ s: z.string().min(1).max(512) });

function presentTitle(title: TitleRecord): StaffTitle {
  return {
    id: title.id,
    name: title.name,
    type: title.type,
    releaseYear: title.releaseYear,
    maturity: title.maturity,
    card: title.images.card,
  };
}

export function presentAvailability(record: TitleAvailabilityRecord): TitleAvailability {
  return {
    titleId: record.titleId,
    available: record.available,
    availableFrom: record.availableFrom === null ? null : toIsoString(record.availableFrom),
    availableUntil: record.availableUntil === null ? null : toIsoString(record.availableUntil),
    updatedAt: toIsoString(record.updatedAt),
  };
}

const byName = (a: TitleRecord, b: TitleRecord) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : 1);

export function createStaffTitles(deps: ServiceDependencies): StaffTitles {
  let memo: { at: number; titles: Map<string, TitleRecord>; sorted: TitleRecord[] } | null = null;

  async function catalogue() {
    const now = deps.clock.now();
    if (memo && now - memo.at < SNAPSHOT_MEMO_MS) return memo;
    const { titles } = await deps.repos.catalog.loadSnapshot();
    memo = {
      at: now,
      titles: new Map(titles.map((title) => [title.id, title])),
      sorted: [...titles].sort(byName),
    };
    return memo;
  }

  return {
    async staffTitles({ q, ids, cursor, limit = DEFAULT_PAGE }) {
      const { titles, sorted } = await catalogue();
      if (ids !== undefined) {
        const items = ids
          .split(",")
          .map((id) => titles.get(id))
          .filter((title): title is TitleRecord => title !== undefined);
        return { items: items.map(presentTitle), nextCursor: null };
      }
      if (q !== undefined) {
        const after = cursor === undefined ? null : decodeCursor(cursor, SearchCursor);
        if (cursor !== undefined && after === null) throw invalidCursor();
        const page = await deps.search.search({
          text: q,
          maturityCeiling: "18+",
          limit,
          cursor: after?.s ?? null,
        });
        return {
          items: page.hits
            .map((hit) => titles.get(hit.id))
            .filter((title): title is TitleRecord => title !== undefined)
            .map(presentTitle),
          nextCursor: page.nextCursor === null ? null : encodeCursor({ s: page.nextCursor }),
        };
      }
      const after = cursor === undefined ? null : decodeCursor(cursor, ListCursor);
      if (cursor !== undefined && after === null) throw invalidCursor();
      const offset = after?.o ?? 0;
      const items = sorted.slice(offset, offset + limit);
      return {
        items: items.map(presentTitle),
        nextCursor: offset + limit < sorted.length ? encodeCursor({ o: offset + limit }) : null,
      };
    },

    async titleAvailability(titleId) {
      const { titles } = await catalogue();
      if (!titles.has(titleId)) throw new AppError("not_found", { detail: "No such title" });
      const record = await deps.repos.personalisation.getAvailability(titleId);
      if (!record) {
        return {
          titleId,
          available: true,
          availableFrom: null,
          availableUntil: null,
          updatedAt: null,
        };
      }
      return presentAvailability(record);
    },

    async listTitleAvailability() {
      const [{ titles }, editorial] = await Promise.all([
        catalogue(),
        deps.repos.personalisation.loadEditorial(),
      ]);
      const now = deps.clock.now();
      return editorial.availability
        .map((record) => ({
          ...presentAvailability(record),
          name: titles.get(record.titleId)?.name ?? null,
          unavailableNow: isUnavailable(record, now),
        }))
        .sort(
          (a, b) =>
            (a.name ?? "").localeCompare(b.name ?? "", "en", { sensitivity: "base" }) ||
            (a.titleId < b.titleId ? -1 : 1),
        );
    },
  };
}
