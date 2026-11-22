import type {
  BrowseView,
  ContinueWatchingItem,
  RankedItem,
  Row,
  RowLayout,
  TitleCard,
} from "@webflix/contracts";
import { rankLabel, top10RankLabel } from "../common/format.ts";
import { anchorArt, isArtReady, loadArt, previewArtUrl, previewWidth } from "./prepare.ts";
import { type PreviewRequest, previewStore } from "./store.ts";

/**
 * How long an accepted intent may wait for its artwork to decode (it was requested when the
 * pointer entered the card, so this is rarely more than a frame): past it, the preview opens
 * and loads the picture itself.
 */
export const PREVIEW_ART_WAIT_MS = 900;

export type RowItem = TitleCard | RankedItem | ContinueWatchingItem;

export function cardOf(item: RowItem): TitleCard {
  if ("rank" in item) return item.title;
  if ("progress" in item) return item.title;
  return item;
}

export function itemKey(item: RowItem): string {
  return cardOf(item).id;
}

export function previewId(scope: string, titleId: string, index: number): string {
  return `${scope}:${titleId}:${index}`;
}

/** The card's own box inside a slider cell or grid cell (cells carry gap padding). */
export function cardRect(cell: HTMLElement): DOMRect {
  return (cell.querySelector("a") ?? cell).getBoundingClientRect();
}

export interface IntentSource {
  scope: string;
  layout: RowLayout;
  /** Ranked rows: the row title, for "#2 in Series Today". */
  rowTitle?: string;
  /** The browse view a row belongs to (whose Top 10 a card's rank refers to); none for grids. */
  view?: BrowseView;
}

/**
 * Open the hover preview for an item of a row or grid; false if the store declined it. The
 * preview opens on artwork that is already decoded (the hi-res image fetched during intent, or
 * the card's own image): when neither is, it waits for the hi-res one, briefly.
 */
export function requestPreview(
  source: IntentSource,
  item: RowItem,
  index: number,
  cell: HTMLElement,
  edge: "start" | "end" | null,
): boolean {
  const card = cardOf(item);
  const id = previewId(source.scope, card.id, index);
  const hiRes = previewArtUrl(card, previewWidth(cardRect(cell)));
  const art = () => (isArtReady(hiRes) ? hiRes : anchorArt(cell, card));
  const build = (): PreviewRequest => buildRequest(source, item, index, cell, edge, art());
  if (art()) return previewStore.open(build());
  return previewStore.openWhenReady(id, source.scope, loadArt(hiRes), build, PREVIEW_ART_WAIT_MS);
}

function buildRequest(
  source: IntentSource,
  item: RowItem,
  index: number,
  cell: HTMLElement,
  edge: "start" | "end" | null,
  art: string | null,
): PreviewRequest {
  const card = cardOf(item);
  return {
    id: previewId(source.scope, card.id, index),
    scope: source.scope,
    card,
    anchor: cell,
    rect: cardRect(cell),
    edge,
    layout: source.layout,
    rankLabel:
      "rank" in item && source.rowTitle
        ? rankLabel(item.rank, source.rowTitle)
        : top10RankLabel(card, source.view ?? null),
    progress: "progress" in item ? item.progress : null,
    episode: "progress" in item ? item.episode : null,
    removable: "progress" in item,
    art,
  };
}

/** Concatenate a row's first page with the pages fetched for it, without duplicate titles. */
export function mergeRow(row: Row, pages: readonly Row[]): Row {
  if (pages.length === 0) return row;
  const seen = new Set<string>();
  const items: RowItem[] = [];
  for (const page of [row, ...pages]) {
    for (const item of page.items as readonly RowItem[]) {
      const key = itemKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  const last = pages[pages.length - 1];
  return { ...row, items, nextCursor: last ? last.nextCursor : row.nextCursor } as Row;
}
