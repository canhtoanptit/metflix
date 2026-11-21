import {
  API_BASE_PATH,
  type BrowsePage,
  type BrowseView,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  MATURITY_LEVELS,
  type MaturityLevel,
  type Row,
  type TitleCard,
} from "@webflix/contracts";
import { succeeds } from "../expect.ts";
import type { Agent, HttpResult } from "../http.ts";

export const API = API_BASE_PATH;
/** The CSRF header every mutation carries (blueprint §2.3). */
export const CSRF = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } as const;

export function maturityRank(level: MaturityLevel): number {
  return MATURITY_LEVELS.indexOf(level);
}

export function cardsOfRow(row: Row): TitleCard[] {
  switch (row.layout) {
    case "ranked":
      return row.items.map((item) => item.title);
    case "continue":
      return row.items.map((item) => item.title);
    case "standard":
    case "tall":
      return row.items;
  }
}

export function cardsOfPage(page: BrowsePage): TitleCard[] {
  return [...(page.billboard ? [page.billboard.title] : []), ...page.rows.flatMap(cardsOfRow)];
}

/** Every batch of a browse view (follows `nextCursor`, at most `maxBatches`). */
export async function browseAll(
  agent: Agent,
  view: BrowseView,
  maxBatches = 12,
): Promise<{ pages: BrowsePage[]; rows: Row[] }> {
  const pages: BrowsePage[] = [];
  let cursor: string | undefined;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const page = await succeeds(
      () => agent.api.getBrowse({ query: { view, ...(cursor ? { cursor } : {}) } }),
      `browse ${view} batch ${batch + 1}`,
    );
    pages.push(page);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { pages, rows: pages.flatMap((page) => page.rows) };
}

/** Run `count` calls at once. */
export function fanOut<T>(count: number, call: (index: number) => Promise<T>): Promise<T[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => call(index)));
}

/** "3×200, 1×410" */
export function tallyStatuses(results: readonly HttpResult[]): string {
  const counts = new Map<number, number>();
  for (const result of results) counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a - b)
    .map(([code, count]) => `${count}×${code}`)
    .join(", ");
}

/** A unique suffix for paths and names within a run. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** First ASCII vowel accented (e → é): diacritic-insensitive search must still match. */
export function accentFirstVowel(text: string): string | null {
  const accents: Record<string, string> = {
    a: "á",
    e: "é",
    i: "í",
    o: "ó",
    u: "ú",
    A: "Á",
    E: "É",
    I: "Í",
    O: "Ó",
    U: "Ú",
  };
  const index = text.search(/[aeiouAEIOU]/);
  if (index === -1) return null;
  const vowel = text[index] ?? "";
  return `${text.slice(0, index)}${accents[vowel] ?? vowel}${text.slice(index + 1)}`;
}

/** Strip diacritics the way users type without them. */
export function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
