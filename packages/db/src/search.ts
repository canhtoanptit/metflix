import {
  decodeCursor,
  encodeCursor,
  invalidCursor,
  maturityRank,
  normalizeSearchText,
  prefixWithinUtf8Bytes,
  SEARCH_FIELDS,
  type SearchDocument,
  type SearchField,
  type SearchIndex,
  type SearchSuggestionHit,
  tokenizeSearchText,
} from "@webflix/core";
import { type Compilable, sql } from "kysely";
import * as z from "zod";
import { chunkValues, type Database, withUnavailableErrors } from "./database.ts";
import { insertChunks } from "./repositories/catalog.ts";

/**
 * `SearchIndex` in the application database: FTS5 on SQLite and D1, a weighted `tsvector` on
 * Postgres. Suggestions (titles, people, genres) come from a plain label table with token-prefix
 * `LIKE`s, identical on every dialect.
 *
 * Matching follows the port: every query token prefix-matches a document token. Text is
 * normalised in JavaScript (`normalizeSearchText`) before it is stored or queried, so both
 * engines see the same tokens and no database extension (unaccent, pg_trgm) is required.
 */

const OffsetCursor = z.object({ o: z.number().int().nonnegative() });

/**
 * D1 caps LIKE patterns at 50 bytes of UTF-8. A token's pattern is `% <token>%`, so a token
 * keeps at most 47 bytes (15 CJK characters, 23 Cyrillic ones), cut between code points; a
 * shorter token still prefix-matches. Every dialect cuts alike, so results agree.
 */
const MAX_LIKE_PATTERN_BYTES = 50;
const MAX_LIKE_TOKEN_BYTES = MAX_LIKE_PATTERN_BYTES - "% %".length;

/** A tampered or foreign cursor is the client's mistake (`validation_failed`), never page one. */
function offsetOf(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const decoded = decodeCursor(cursor, OffsetCursor);
  if (!decoded) throw invalidCursor();
  return decoded.o;
}

const SUGGESTION_KIND_WEIGHT = { title: 300, person: 200, genre: 100 } as const;

function documentFields(document: SearchDocument): Record<SearchField, string> {
  return {
    name: normalizeSearchText(document.name),
    people: normalizeSearchText(document.people.map((person) => person.name).join(" ")),
    genres: normalizeSearchText(document.genres.map((genre) => genre.name).join(" ")),
    moods: normalizeSearchText(document.moods.join(" ")),
    synopsis: normalizeSearchText(document.synopsis),
  };
}

function matchedFields(
  queryTokens: readonly string[],
  fields: Record<SearchField, string>,
): SearchField[] {
  return SEARCH_FIELDS.filter((field) => {
    const tokens = fields[field] === "" ? [] : fields[field].split(" ");
    return queryTokens.some((query) => tokens.some((token) => token.startsWith(query)));
  });
}

interface HitRow {
  title_id: string;
  rank: number;
  name_norm: string;
  people_norm: string;
  genres_norm: string;
  moods_norm: string;
  synopsis_norm: string;
}

export function createSqlSearchIndex(database: Database): SearchIndex {
  return withUnavailableErrors(searchIndex(database));
}

function searchIndex(database: Database): SearchIndex {
  const { db, dialect } = database;
  const fts = dialect !== "postgres";

  const deleteStatements = (ids: readonly string[]): Compilable<unknown>[] =>
    chunkValues(ids).flatMap((chunk) => [
      db.deleteFrom("search_documents").where("title_id", "in", chunk),
      db.deleteFrom("search_labels").where("title_id", "in", chunk),
      ...(fts ? [db.deleteFrom("search_fts").where("title_id", "in", chunk)] : []),
    ]);

  return {
    async upsert(documents) {
      if (documents.length === 0) return;
      const prepared = documents.map((document) => ({
        document,
        fields: documentFields(document),
      }));
      const labels = new Map<
        string,
        {
          kind: string;
          entity_id: string;
          title_id: string;
          label: string;
          label_norm: string;
          maturity_rank: number;
          popularity: number;
        }
      >();
      for (const { document } of prepared) {
        const base = {
          title_id: document.id,
          maturity_rank: maturityRank(document.maturity),
          popularity: document.popularity,
        };
        const add = (kind: string, entityId: string, label: string) => {
          labels.set(`${kind}\u0000${entityId}\u0000${document.id}`, {
            ...base,
            kind,
            entity_id: entityId,
            label,
            label_norm: normalizeSearchText(label),
          });
        };
        add("title", document.id, document.name);
        for (const person of document.people) add("person", person.id, person.name);
        for (const genre of document.genres) add("genre", genre.slug, genre.name);
      }

      await database.batch([
        ...deleteStatements(documents.map((document) => document.id)),
        ...insertChunks(
          database,
          "search_documents",
          prepared.map(({ document, fields }) => ({
            title_id: document.id,
            type: document.type,
            maturity_rank: maturityRank(document.maturity),
            popularity: document.popularity,
            name_norm: fields.name,
            people_norm: fields.people,
            genres_norm: fields.genres,
            moods_norm: fields.moods,
            synopsis_norm: fields.synopsis,
          })),
        ),
        ...(fts
          ? insertChunks(
              database,
              "search_fts",
              prepared.map(({ document, fields }) => ({
                title_id: document.id,
                name: fields.name,
                people: fields.people,
                genres: fields.genres,
                moods: fields.moods,
                synopsis: fields.synopsis,
              })),
            )
          : []),
        ...insertChunks(database, "search_labels", [...labels.values()]),
      ]);
    },

    async remove(ids) {
      if (ids.length === 0) return;
      await database.batch(deleteStatements(ids));
    },

    async search(query) {
      const tokens = tokenizeSearchText(query.text);
      if (tokens.length === 0) return { hits: [], nextCursor: null };
      const offset = offsetOf(query.cursor);
      const ceiling = maturityRank(query.maturityCeiling);
      const typeFilter = query.type ? sql`AND d.type = ${query.type}` : sql``;

      // One extra row tells whether another page exists.
      const result = fts
        ? await sql<HitRow>`
            SELECT d.title_id, d.name_norm, d.people_norm, d.genres_norm, d.moods_norm,
                   d.synopsis_norm, -bm25(search_fts, 0.0, 10.0, 5.0, 4.0, 3.0, 1.0) AS rank
            FROM search_fts
            JOIN search_documents d ON d.title_id = search_fts.title_id
            WHERE search_fts MATCH ${tokens.map((token) => `"${token}"*`).join(" ")}
              AND d.maturity_rank <= ${ceiling} ${typeFilter}
            ORDER BY rank DESC, d.popularity DESC, d.title_id ASC
            LIMIT ${query.limit + 1} OFFSET ${offset}
          `.execute(db)
        : await sql<HitRow>`
            SELECT d.title_id, d.name_norm, d.people_norm, d.genres_norm, d.moods_norm,
                   d.synopsis_norm,
                   ts_rank('{0.05,0.2,0.4,1.0}'::float4[], d.document, q) AS rank
            FROM search_documents d, to_tsquery('simple', ${tokens.map((token) => `'${token}':*`).join(" & ")}) q
            WHERE d.document @@ q AND d.maturity_rank <= ${ceiling} ${typeFilter}
            ORDER BY rank DESC, d.popularity DESC, d.title_id ASC
            LIMIT ${query.limit + 1} OFFSET ${offset}
          `.execute(db);

      const rows = result.rows.slice(0, query.limit);
      const hits = rows.map((row) => ({
        id: row.title_id,
        score: Number(row.rank),
        matchedFields: matchedFields(tokens, {
          name: row.name_norm,
          people: row.people_norm,
          genres: row.genres_norm,
          moods: row.moods_norm,
          synopsis: row.synopsis_norm,
        }),
      }));
      const nextCursor =
        result.rows.length > query.limit ? encodeCursor({ o: offset + rows.length }) : null;
      return { hits, nextCursor };
    },

    async suggest(query) {
      const tokens = tokenizeSearchText(query.text).map((token) =>
        prefixWithinUtf8Bytes(token, MAX_LIKE_TOKEN_BYTES),
      );
      if (tokens.length === 0) return [];
      const weight = sql<number>`(CASE kind WHEN 'title' THEN ${sql.lit(SUGGESTION_KIND_WEIGHT.title)} WHEN 'person' THEN ${sql.lit(SUGGESTION_KIND_WEIGHT.person)} ELSE ${sql.lit(SUGGESTION_KIND_WEIGHT.genre)} END + max(popularity))`;
      let select = db
        .selectFrom("search_labels")
        .select(["kind", "entity_id", "label", "label_norm"])
        .where("maturity_rank", "<=", maturityRank(query.maturityCeiling));
      for (const token of tokens) {
        // Token prefix: the label, with a leading space, contains " <token>".
        select = select.where(sql<string>`' ' || label_norm`, "like", `% ${token}%`);
      }
      const rows = await select
        .groupBy(["kind", "entity_id", "label", "label_norm"])
        .orderBy(weight, "desc")
        .orderBy("label_norm")
        .orderBy("entity_id")
        .limit(query.limit)
        .execute();
      return rows.map(
        (row): SearchSuggestionHit => ({
          kind: row.kind as SearchSuggestionHit["kind"],
          id: row.entity_id,
          label: row.label,
        }),
      );
    },
  };
}
