import * as z from "zod";
import { decodeCursor, encodeCursor, invalidCursor } from "../domain/cursor.ts";
import { isWithinMaturityCeiling } from "../domain/maturity.ts";
import {
  normalizeSearchText,
  SEARCH_FIELDS,
  type SearchDocument,
  type SearchField,
  type SearchHit,
  type SearchIndex,
  type SearchPage,
  type SearchQuery,
  type SearchSuggestionHit,
  type SuggestQuery,
  tokenizeSearchText,
} from "../ports/search-index.ts";

const FIELD_WEIGHTS: Record<SearchField, number> = {
  name: 10,
  people: 5,
  genres: 4,
  moods: 3,
  synopsis: 1,
};

interface IndexedDocument {
  document: SearchDocument;
  tokens: Record<SearchField, string[]>;
}

const OffsetCursor = z.object({ o: z.number().int().nonnegative() });

function fieldText(document: SearchDocument, field: SearchField): string {
  switch (field) {
    case "name":
      return document.name;
    case "people":
      return document.people.map((person) => person.name).join(" ");
    case "genres":
      return document.genres.map((genre) => genre.name).join(" ");
    case "moods":
      return document.moods.join(" ");
    case "synopsis":
      return document.synopsis;
  }
}

/** True when every query token prefix-matches one of `tokens`. */
function matchesAll(queryTokens: readonly string[], tokens: readonly string[]): boolean {
  return queryTokens.every((query) => tokens.some((token) => token.startsWith(query)));
}

/**
 * In-process `SearchIndex`: a linear scan with field weights. Fine for the ~120-title catalog
 * and the reference behaviour the SQL adapters are tested against.
 */
export class MemorySearchIndex implements SearchIndex {
  private readonly documents = new Map<string, IndexedDocument>();

  async upsert(documents: readonly SearchDocument[]): Promise<void> {
    for (const document of documents) {
      const tokens = Object.fromEntries(
        SEARCH_FIELDS.map((field) => [field, tokenizeSearchText(fieldText(document, field))]),
      ) as Record<SearchField, string[]>;
      this.documents.set(document.id, { document: structuredClone(document), tokens });
    }
  }

  async remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.documents.delete(id);
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const queryTokens = tokenizeSearchText(query.text);
    if (queryTokens.length === 0) return { hits: [], nextCursor: null };
    const decoded = query.cursor ? decodeCursor(query.cursor, OffsetCursor) : null;
    // A tampered or foreign cursor is the client's mistake, never page one.
    if (query.cursor && !decoded) throw invalidCursor();
    const offset = decoded?.o ?? 0;

    const hits: (SearchHit & { popularity: number })[] = [];
    for (const { document, tokens } of this.documents.values()) {
      if (!isWithinMaturityCeiling(document.maturity, query.maturityCeiling)) continue;
      if (query.type && document.type !== query.type) continue;
      const allTokens = SEARCH_FIELDS.flatMap((field) => tokens[field]);
      if (!matchesAll(queryTokens, allTokens)) continue;

      let score = 0;
      const matchedFields: SearchField[] = [];
      for (const field of SEARCH_FIELDS) {
        let fieldScore = 0;
        for (const queryToken of queryTokens) {
          if (tokens[field].includes(queryToken)) fieldScore += 1.5;
          else if (tokens[field].some((token) => token.startsWith(queryToken))) fieldScore += 1;
        }
        if (fieldScore > 0) {
          matchedFields.push(field);
          score += fieldScore * FIELD_WEIGHTS[field];
        }
      }
      hits.push({ id: document.id, score, matchedFields, popularity: document.popularity });
    }

    hits.sort(
      (a, b) => b.score - a.score || b.popularity - a.popularity || a.id.localeCompare(b.id),
    );
    const page = hits.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;
    return {
      hits: page.map(({ popularity: _popularity, ...hit }) => hit),
      nextCursor: nextOffset < hits.length ? encodeCursor({ o: nextOffset }) : null,
    };
  }

  async suggest(query: SuggestQuery): Promise<SearchSuggestionHit[]> {
    const queryTokens = tokenizeSearchText(query.text);
    if (queryTokens.length === 0) return [];
    const suggestions = new Map<string, SearchSuggestionHit & { weight: number }>();
    const consider = (hit: SearchSuggestionHit, weight: number) => {
      if (!matchesAll(queryTokens, tokenizeSearchText(hit.label))) return;
      const key = `${hit.kind}:${hit.id}`;
      const existing = suggestions.get(key);
      if (!existing || existing.weight < weight) suggestions.set(key, { ...hit, weight });
    };

    for (const { document } of this.documents.values()) {
      if (!isWithinMaturityCeiling(document.maturity, query.maturityCeiling)) continue;
      consider({ kind: "title", id: document.id, label: document.name }, document.popularity + 300);
      for (const person of document.people) {
        consider({ kind: "person", id: person.id, label: person.name }, document.popularity + 200);
      }
      for (const genre of document.genres) {
        consider({ kind: "genre", id: genre.slug, label: genre.name }, document.popularity + 100);
      }
    }
    return [...suggestions.values()]
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          normalizeSearchText(a.label).localeCompare(normalizeSearchText(b.label)),
      )
      .slice(0, query.limit)
      .map(({ weight: _weight, ...hit }) => hit);
  }
}
