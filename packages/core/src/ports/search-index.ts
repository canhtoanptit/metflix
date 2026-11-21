import type { MaturityLevel, TitleType } from "@webflix/contracts";

export const SEARCH_FIELDS = ["name", "people", "genres", "moods", "synopsis"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** One searchable title. Rebuilt from the catalog by the indexing job. */
export interface SearchDocument {
  /** Title id. */
  id: string;
  type: TitleType;
  maturity: MaturityLevel;
  name: string;
  /** Cast, directors and creators. */
  people: readonly { id: string; name: string }[];
  genres: readonly { slug: string; name: string }[];
  moods: readonly string[];
  synopsis: string;
  /** 0-100; breaks ties between equally relevant hits. */
  popularity: number;
}

export interface SearchQuery {
  text: string;
  /** Only titles at or below this level are returned. */
  maturityCeiling: MaturityLevel;
  type?: TitleType;
  /** 1..100 */
  limit: number;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
}

export interface SearchHit {
  id: string;
  /** Adapter-specific relevance; only the order is meaningful. */
  score: number;
  matchedFields: SearchField[];
}

export interface SearchPage {
  hits: SearchHit[];
  nextCursor: string | null;
}

export interface SuggestQuery {
  text: string;
  maturityCeiling: MaturityLevel;
  /** 1..20 */
  limit: number;
}

export interface SearchSuggestionHit {
  kind: "title" | "person" | "genre";
  /** Title id, person id or genre slug. */
  id: string;
  label: string;
}

/**
 * Port: full-text search over titles (memory / SQLite FTS5 / Postgres FTS + trigram / D1 FTS5).
 *
 * Matching contract, chosen so FTS5 and Postgres can both implement it:
 * - Text is normalised with `normalizeSearchText` (case- and diacritic-insensitive).
 * - Every query token must prefix-match some token of the document (any field). That is
 *   search-as-you-type: "sint" finds "Sintel". Typo tolerance is optional, never required.
 * - A title whose name matches ranks above one that matches only in the synopsis; ties are
 *   broken by popularity, then id.
 * - Maturity filtering happens inside the index (never post-filter: pages would come up short).
 * - `suggest` returns titles, people and genres whose name prefix-matches, considering only
 *   documents visible under the ceiling.
 */
export interface SearchIndex {
  /** Insert or replace documents by id. */
  upsert(documents: readonly SearchDocument[]): Promise<void>;
  /** Idempotent. */
  remove(ids: readonly string[]): Promise<void>;
  search(query: SearchQuery): Promise<SearchPage>;
  suggest(query: SuggestQuery): Promise<SearchSuggestionHit[]>;
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The longest prefix of `text` that fits in `maxBytes` of UTF-8, cut between code points (never
 * inside a surrogate pair or a multi-byte sequence). For engines that bound pattern sizes in
 * bytes (D1: 50-byte LIKE patterns): a shorter token still prefix-matches.
 */
export function prefixWithinUtf8Bytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

export function tokenizeSearchText(text: string): string[] {
  const normalized = normalizeSearchText(text);
  return normalized === "" ? [] : normalized.split(" ");
}
