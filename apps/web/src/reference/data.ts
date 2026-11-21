/**
 * Reference-page data: real contract DTOs from the mock catalogue (rows of realistic length and
 * artwork sizes). Artwork renders in mock mode; against a real API the blur-up shows instead.
 */
import type { ContinueWatchingItem, RankedItem, TitleCard, TitleDetail } from "@webflix/contracts";
import { iso, seedById, titleCard, titleDetail, top10 } from "../mocks/catalog.ts";
import { MOCK_TITLES } from "../mocks/data/catalog.ts";

const viewer = { inMyList: false, rating: null };

export const cards: TitleCard[] = MOCK_TITLES.map((seed) => titleCard(seed, viewer));
export const originals: TitleCard[] = MOCK_TITLES.filter((seed) => seed.original).map((seed) =>
  titleCard(seed, viewer),
);
export const ranked: RankedItem[] = top10.movies.map((seed, index) => ({
  rank: index + 1,
  title: titleCard(seed, viewer),
}));
export const continueItems: ContinueWatchingItem[] = cards.slice(8, 16).map((title, index) => ({
  title,
  episode:
    title.type === "series"
      ? { id: `e-ref-${index}`, seasonNumber: 1, number: index + 2, name: "Chapter two" }
      : null,
  progress: {
    positionSec: 300 + index * 420,
    durationSec: 3600,
    completed: false,
    updatedAt: iso(index * 3_600_000),
  },
}));

const sintel = seedById.get("t-sintel");
export const detail: TitleDetail | null = sintel
  ? titleDetail(sintel, { ...viewer, progress: null })
  : null;
export const sample: TitleCard = cards.find((card) => card.isOriginal) ?? (cards[0] as TitleCard);
