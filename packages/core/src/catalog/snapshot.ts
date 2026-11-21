import { type VideoQualityTier, videoQualityForHeight } from "@webflix/contracts";
import { maturityRank } from "../domain/maturity.ts";
import { dot, type FeatureVector, titleFeatures } from "../recommendations/features.ts";
import type {
  CatalogSnapshotData,
  EpisodeSummary,
  GenreRecord,
  NamedCreditRecord,
  SeasonRecord,
  TitleRecord,
} from "../repositories/records.ts";

export interface SimilarTitle {
  id: string;
  /** Cosine similarity of content features, 0..1. */
  similarity: number;
}

/** How many neighbours are kept per title (More Like This, Because You Watched). */
const SIMILAR_LIMIT = 48;

/**
 * The catalog, indexed for browse. Immutable; built once per catalog version and shared by
 * every request of the process/isolate. Item-to-item similarity is computed lazily per title
 * through an inverted index over features, so cost grows with the overlap of a title's
 * features, not with catalog size squared.
 */
export class CatalogSnapshot {
  readonly version: string;
  readonly titles: readonly TitleRecord[];
  readonly genres: readonly GenreRecord[];
  private readonly titleById = new Map<string, TitleRecord>();
  private readonly genreById = new Map<string, GenreRecord>();
  private readonly genreBySlug = new Map<string, GenreRecord>();
  private readonly creditsByTitle = new Map<string, NamedCreditRecord[]>();
  private readonly seasonsByTitle = new Map<string, SeasonRecord[]>();
  private readonly episodesByTitle = new Map<string, EpisodeSummary[]>();
  private readonly episodeById = new Map<string, EpisodeSummary>();
  private readonly maturityRanks = new Map<string, number>();
  private readonly assetHeights = new Map<string, number>();
  private readonly qualityCache = new Map<string, VideoQualityTier | null>();
  private readonly featureCache = new Map<string, FeatureVector>();
  private readonly similarCache = new Map<string, SimilarTitle[]>();
  private postings: Map<string, { id: string; weight: number }[]> | undefined;

  constructor(data: CatalogSnapshotData) {
    this.version = data.version;
    this.titles = data.titles;
    this.genres = data.genres;
    for (const title of data.titles) {
      this.titleById.set(title.id, title);
      this.maturityRanks.set(title.id, maturityRank(title.maturity));
    }
    for (const genre of data.genres) {
      this.genreById.set(genre.id, genre);
      this.genreBySlug.set(genre.slug, genre);
    }
    for (const credit of data.credits) push(this.creditsByTitle, credit.titleId, credit);
    for (const season of data.seasons) push(this.seasonsByTitle, season.titleId, season);
    for (const episode of data.episodes) {
      push(this.episodesByTitle, episode.titleId, episode);
      this.episodeById.set(episode.id, episode);
    }
    for (const list of this.episodesByTitle.values()) list.sort((a, b) => a.seq - b.seq);
    for (const asset of data.packagedAssets) this.assetHeights.set(asset.id, asset.maxHeight);
    for (const list of this.seasonsByTitle.values()) list.sort((a, b) => a.number - b.number);
  }

  title(id: string): TitleRecord | undefined {
    return this.titleById.get(id);
  }

  genre(id: string): GenreRecord | undefined {
    return this.genreById.get(id);
  }

  genreBySlugName(slug: string): GenreRecord | undefined {
    return this.genreBySlug.get(slug);
  }

  maturityRankOf(titleId: string): number {
    return this.maturityRanks.get(titleId) ?? Number.POSITIVE_INFINITY;
  }

  credits(titleId: string): readonly NamedCreditRecord[] {
    return this.creditsByTitle.get(titleId) ?? [];
  }

  seasons(titleId: string): readonly SeasonRecord[] {
    return this.seasonsByTitle.get(titleId) ?? [];
  }

  /** Episodes of a series in viewing order. */
  episodes(titleId: string): readonly EpisodeSummary[] {
    return this.episodesByTitle.get(titleId) ?? [];
  }

  episode(id: string): EpisodeSummary | undefined {
    return this.episodeById.get(id);
  }

  /** The episode after `episodeId` in its series, across seasons. */
  nextEpisode(episodeId: string): EpisodeSummary | undefined {
    const episode = this.episodeById.get(episodeId);
    if (!episode) return undefined;
    return this.episodes(episode.titleId).find((candidate) => candidate.seq > episode.seq);
  }

  /**
   * Best video quality the title's packaged media offers (a series: its best episode). Null
   * when none of it is packaged (external fallback streams have no known quality).
   */
  bestVideoQuality(titleId: string): VideoQualityTier | null {
    const cached = this.qualityCache.get(titleId);
    if (cached !== undefined) return cached;
    const title = this.titleById.get(titleId);
    const assetIds =
      title?.type === "movie"
        ? [title.videoAssetId]
        : this.episodes(titleId).map((episode) => episode.videoAssetId);
    let best: number | null = null;
    for (const assetId of assetIds) {
      const height = assetId ? this.assetHeights.get(assetId) : undefined;
      if (height !== undefined && (best === null || height > best)) best = height;
    }
    const quality = best === null ? null : videoQualityForHeight(best);
    this.qualityCache.set(titleId, quality);
    return quality;
  }

  features(titleId: string): FeatureVector {
    let features = this.featureCache.get(titleId);
    if (!features) {
      const title = this.titleById.get(titleId);
      features = title ? titleFeatures(title, this.credits(titleId)) : new Map();
      this.featureCache.set(titleId, features);
    }
    return features;
  }

  /** Most similar titles by content, best first (ties: popularity, then id). Not maturity-filtered. */
  similar(titleId: string): readonly SimilarTitle[] {
    const cached = this.similarCache.get(titleId);
    if (cached) return cached;
    const source = this.features(titleId);
    const postings = this.buildPostings();
    const scores = new Map<string, number>();
    for (const [feature, weight] of source) {
      for (const posting of postings.get(feature) ?? []) {
        if (posting.id === titleId) continue;
        scores.set(posting.id, (scores.get(posting.id) ?? 0) + weight * posting.weight);
      }
    }
    const similar = [...scores]
      .map(([id, similarity]) => ({ id, similarity }))
      .sort(
        (a, b) =>
          b.similarity - a.similarity ||
          (this.titleById.get(b.id)?.popularity ?? 0) -
            (this.titleById.get(a.id)?.popularity ?? 0) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, SIMILAR_LIMIT);
    this.similarCache.set(titleId, similar);
    return similar;
  }

  /** Content similarity of two titles, 0..1. */
  similarity(a: string, b: string): number {
    return dot(this.features(a), this.features(b));
  }

  private buildPostings(): Map<string, { id: string; weight: number }[]> {
    if (!this.postings) {
      const postings = new Map<string, { id: string; weight: number }[]>();
      for (const title of this.titles) {
        for (const [feature, weight] of this.features(title.id)) {
          push(postings, feature, { id: title.id, weight });
        }
      }
      this.postings = postings;
    }
    return this.postings;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
