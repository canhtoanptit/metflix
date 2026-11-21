import { DEFAULT_PAGE_SIZE } from "@webflix/contracts";
import * as z from "zod";
import { decodeCursor, encodeCursor, invalidCursor } from "../domain/cursor.ts";
import { fnvHex } from "../recommendations/hash.ts";

const OffsetCursor = z.object({ o: z.number().int().nonnegative() });

/** Decode a cursor or answer `validation_failed` (a tampered or stale cursor is a client error). */
export function decodeOrFail<T>(cursor: string | undefined, schema: z.ZodType<T>): T | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor, schema);
  if (decoded === null) throw invalidCursor();
  return decoded;
}

/** Offset pagination over an in-memory list (rows, genre pages, My List). */
export function pageOf<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number = DEFAULT_PAGE_SIZE,
): { items: T[]; nextCursor: string | null; offset: number } {
  const offset = decodeOrFail(cursor, OffsetCursor)?.o ?? 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    items: page,
    nextCursor: next < items.length ? encodeCursor({ o: next }) : null,
    offset,
  };
}

/** Most digests a "served" cursor carries (rows of a view, items of a row stay well below). */
const MAX_SERVED = 200;

/**
 * Pages over a list that can change between requests (a row re-ranked by a rollup or emptied by
 * the member, a title added to My List): the cursor carries a short digest of every item served
 * so far, and each page is the first `limit` items not served yet, in the list's current order.
 * Nothing is repeated or skipped because something before it moved. The count served (`field`)
 * is kept beside the digests so a server that reads only offsets still pages during a rollout,
 * and a cursor without digests (from such a server) is read as an offset.
 */
export function pageUnserved<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  cursor: string | undefined,
  limit: number,
  field: "o" | "r" = "o",
): { items: T[]; nextCursor: string | null; offset: number } {
  const schema = z.object({
    [field]: z.number().int().nonnegative(),
    s: z
      .array(z.string().regex(/^[0-9a-f]{8}$/))
      .max(MAX_SERVED)
      .optional(),
  });
  const decoded = decodeOrFail(cursor, schema) as { s?: string[] } | null;
  const offset = decoded === null ? 0 : ((decoded as Record<string, number>)[field] ?? 0);
  const digest = (item: T) => fnvHex(keyOf(item));
  const served = new Set(decoded?.s ?? items.slice(0, offset).map(digest));
  const remaining = items.filter((item) => !served.has(digest(item)));
  const page = remaining.slice(0, limit);
  const next = [...served, ...page.map(digest)];
  return {
    items: page,
    nextCursor:
      remaining.length > page.length && next.length <= MAX_SERVED
        ? encodeCursor({ [field]: offset + page.length, s: next })
        : null,
    offset,
  };
}
