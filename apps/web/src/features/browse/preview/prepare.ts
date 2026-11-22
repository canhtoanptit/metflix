import { type ImageSet, imageUrl, pickImageWidth, type TitleCard } from "@webflix/contracts";
import { preloadable } from "../common/modules.ts";
import { previewGeometry } from "./geometry.ts";

/**
 * Everything a hover preview needs on its first frame, fetched while the hover-intent timer
 * runs (from the moment the pointer enters a card), so the preview never opens on a placeholder:
 *
 * - the preview layer's code;
 * - the card art at the preview's width, fetched *and decoded* (`HTMLImageElement.decode()`).
 *
 * At open, the preview paints the best art already decoded: that hi-res image, or else the
 * card's own `<img>` (the same artwork, already on screen), which is what the lift starts from.
 */

export const previewModule = preloadable(() => import("./HoverPreview.tsx"));

/** Formats in the order `ResponsiveImage` prefers them; we use its `<img>` fallback format. */
const FORMAT_PREFERENCE = ["avif", "webp"] as const;
/** Decoded preview images kept referenced (their bitmaps stay warm); oldest dropped first. */
const KEEP = 24;

const decoded = new Set<string>();
const loading = new Map<string, Promise<boolean>>();
const kept: HTMLImageElement[] = [];

export function measureLayout() {
  const root = document.documentElement;
  const rem = Number.parseFloat(getComputedStyle(root).fontSize) || 16;
  return {
    viewport: { width: root.clientWidth, height: window.innerHeight },
    gutter: Math.max(rem, window.innerWidth * 0.04),
    navHeight: rem * 4.25,
  };
}

/** Width (CSS px) of the preview that would open from a card at `rect`. */
export function previewWidth(rect: DOMRect): number {
  return previewGeometry({ rect, edge: null, ...measureLayout() }).width;
}

function fallbackFormat(image: ImageSet) {
  const formats = FORMAT_PREFERENCE.filter((format) => image.formats.includes(format));
  return formats[formats.length - 1] ?? image.formats[0] ?? "webp";
}

/** The card art's URL at a preview `width` (one fixed URL, so preloading it is exact). */
export function previewArtUrl(card: TitleCard, width: number): string {
  const image = card.images.card;
  const ratio = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  return imageUrl(image, pickImageWidth(image, width, ratio), fallbackFormat(image));
}

/** Fetch and decode `url` once; resolves true when it can paint synchronously. */
export function loadArt(url: string): Promise<boolean> {
  if (decoded.has(url)) return Promise.resolve(true);
  const pending = loading.get(url);
  if (pending !== undefined) return pending;
  if (typeof Image === "undefined") return Promise.resolve(false);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  const promise = (typeof image.decode === "function" ? image.decode() : Promise.reject()).then(
    () => {
      decoded.add(url);
      kept.push(image);
      if (kept.length > KEEP) kept.shift();
      return true;
    },
    () => {
      loading.delete(url);
      return false;
    },
  );
  loading.set(url, promise);
  return promise;
}

export function isArtReady(url: string): boolean {
  return decoded.has(url);
}

/**
 * The card's own artwork as it is painted in the row, if it is the preview's artwork (landscape
 * cards) and fully decoded: the preview's first frame *is* the card, scaled.
 */
export function anchorArt(cell: HTMLElement, card: TitleCard): string | null {
  const image = cell.querySelector<HTMLImageElement>("img.wf-image__img");
  if (!image?.complete || image.naturalWidth === 0 || !image.currentSrc) return null;
  // Posters (tall and ranked rows) are other artwork than the preview's landscape picture.
  return sameArtwork(image.currentSrc, card.images.card) ? image.currentSrc : null;
}

/** Whether `src` is a rendition of `image` (its template with width and format filled in). */
function sameArtwork(src: string, image: ImageSet): boolean {
  const [head] = image.template.split("{");
  if (!head) return true;
  try {
    const path = new URL(src, window.location.href).pathname;
    const base = new URL(head, window.location.href).pathname;
    return path.startsWith(base);
  } catch {
    return src.includes(head);
  }
}

/**
 * The pointer entered a card: start on everything its preview will need. Cheap to call on every
 * card the pointer crosses (each image is fetched once, then served from the cache).
 */
export function preparePreview(card: TitleCard, element: Element): void {
  void previewModule.load().catch(() => {});
  try {
    void loadArt(previewArtUrl(card, previewWidth(element.getBoundingClientRect())));
  } catch {
    // Layout unavailable (detached element): the preview falls back to the card's own image.
  }
}

/** Test hook. */
export function resetPreparedArt(): void {
  decoded.clear();
  loading.clear();
  kept.length = 0;
}
