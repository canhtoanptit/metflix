import * as z from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./constants.ts";

/**
 * Entity ids are opaque, URL-safe strings. Ids generated at runtime are UUIDv7;
 * seed data uses stable human-readable ids (e.g. `t-sintel`). Never parse an id.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const Id = z
  .string()
  .regex(ID_PATTERN, "Invalid id")
  .meta({
    description: "Opaque URL-safe identifier (1-64 chars of [A-Za-z0-9_-]).",
    examples: ["t-sintel"],
  });

/** UTC timestamp, always serialised by the server with `Date.prototype.toISOString()`. */
export const IsoDateTime = z.iso.datetime().meta({
  description: "UTC timestamp in ISO 8601 format.",
  examples: ["2026-11-21T09:30:00.000Z"],
});

/** Lowercase kebab-case slug, used in URLs (genres). */
export const Slug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug");

/** Lowercase `#rrggbb`. */
export const HexColor = z.string().regex(/^#[0-9a-f]{6}$/, "Expected a lowercase #rrggbb colour");

/** BCP 47 language tag (simplified): `en`, `pt-BR`, `zh-Hant`. */
export const LanguageTag = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "Expected a BCP 47 language tag");

/**
 * A URL the client can fetch: either same-origin absolute path (`/cdn/...`, `/media/...`)
 * or an absolute http(s) URL (external HLS fallbacks).
 */
export const ResourceUrl = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^(?:\/(?!\/)|https?:\/\/)/, "Expected a root-relative path or an http(s) URL");

/** Seconds as a finite non-negative number (fractions allowed: media positions). */
export const Seconds = z.number().finite().nonnegative();

/** Whole seconds, e.g. runtimes. */
export const WholeSeconds = z.number().int().nonnegative();

/** Opaque pagination cursor. Clients pass it back verbatim; only the server decodes it. */
export const Cursor = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_.~-]+$/, "Invalid cursor")
  .meta({ description: "Opaque pagination cursor. Pass back verbatim." });

/** Query parameters shared by every cursor-paginated endpoint. */
export const PageQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce
    .number<number>()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .meta({ description: `Page size (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE}).` }),
});
export type PageQuery = z.input<typeof PageQuery>;

/**
 * Cursor-paginated collection. `nextCursor` is null on the last page.
 * Collections are always wrapped in an object (never a bare array) so they can grow fields.
 */
export function page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: Cursor.nullable(),
  });
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** A non-paginated collection. */
export function list<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

/** JSON value, for opaque payloads (seed art direction, job payloads). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.json();
