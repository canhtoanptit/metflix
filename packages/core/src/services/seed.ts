import {
  artworkToImageSet,
  blobKeys,
  type CatalogSeed,
  cdnUrlForBlobKey,
  DEFAULT_PROFILE_SETTINGS,
  type DemoAccountSeed,
  type ImageSet,
  type MediaManifest,
  nominalVideoHeight,
  type PackagedVideoAsset,
  type TitleImageKind,
  type TitleSeed,
} from "@webflix/contracts";
import { getPlan } from "../domain/plans.ts";
import { sha256Hex, utf8Encode } from "../encoding.ts";
import type { SearchDocument } from "../ports/search-index.ts";
import { addDays, DAY_MS, fnv1a32, fnvHex, utcDay } from "../recommendations/hash.ts";
import type {
  AccountWrite,
  CatalogWrite,
  CreditRecord,
  EpisodeRecord,
  NotificationRecord,
  ProgressRecord,
  TitleImages,
  TitleRecord,
  VideoAssetRecord,
} from "../repositories/records.ts";
import type { ServiceDependencies, ServiceState } from "./context.ts";
import { baselineStats } from "./jobs.ts";
import { DEMO_ACCOUNT_ID } from "./privileges.ts";
import { BILLING_PERIOD_MS, effectiveSubscription } from "./subscriptions.ts";

/**
 * Bump when the way seeds are turned into rows changes, so `seed` re-applies.
 * 3: assets store their nominal height; demo progress is measured on the playable stream.
 */
const SEED_FORMAT_VERSION = 3;
export const SEED_HASH_KEY = "seed.hash";
/** The demo account's card on file (expiry: three years after seeding). */
const DEMO_CARD = { brand: "visa", last4: "4242", expMonth: 12 } as const;
/** Days of synthetic stats written at seed time (Trending looks at 7, Top 10 at 2). */
const BASELINE_DAYS = 14;
/** Titles added within this window get a "new arrival" notification. */
const NOTIFY_WITHIN_DAYS = 14;

export interface SeedInput {
  catalog: CatalogSeed;
  demoAccount?: DemoAccountSeed | null;
  manifest?: MediaManifest | null;
}

export interface SeedResult {
  skipped: boolean;
  hash: string;
  titles: number;
  episodes: number;
  packagedAssets: number;
  externalAssets: number;
  unavailableAssets: number;
  demoAccount: boolean;
  /**
   * What had drifted on the demo account (sign-in details, membership, profiles) and was put
   * back, on a run that otherwise found nothing to do; empty when nothing had.
   */
  demoRestored: string[];
}

// --- Images ---------------------------------------------------------------------------------

/** Placeholder colours for titles without generated artwork (deterministic per title). */
const FALLBACK_COLORS = [
  "#1d2b3a",
  "#3a1d2b",
  "#1d3a2b",
  "#3a2f1d",
  "#2b1d3a",
  "#1d353a",
  "#3a1d1d",
  "#26303d",
];

const FALLBACK_GEOMETRY: Record<TitleImageKind, { widths: number[]; aspectRatio: number }> = {
  backdrop: { widths: [640, 1280, 1920], aspectRatio: 16 / 9 },
  card: { widths: [320, 480, 640], aspectRatio: 16 / 9 },
  poster: { widths: [200, 300, 400], aspectRatio: 2 / 3 },
  logo: { widths: [300, 600], aspectRatio: 4 },
};

/**
 * The CDN template the media pipeline will fill (`blobKeys.titleImageTemplate`), with a
 * placeholder colour and no ThumbHash. Used until `tools/media` has produced artwork; the
 * client shows the dominant colour if the image 404s.
 */
function fallbackImage(titleId: string, kind: TitleImageKind): ImageSet {
  const geometry = FALLBACK_GEOMETRY[kind];
  return {
    template: cdnUrlForBlobKey(blobKeys.titleImageTemplate(titleId, kind)),
    widths: geometry.widths,
    formats: ["avif", "webp"],
    aspectRatio: geometry.aspectRatio,
    dominantColor: FALLBACK_COLORS[fnv1a32(titleId) % FALLBACK_COLORS.length] ?? "#1d2b3a",
    thumbhash: null,
  };
}

// --- Catalog --------------------------------------------------------------------------------

function videoAssetRecord(
  asset: CatalogSeed["videoAssets"][number],
  packaged: PackagedVideoAsset | undefined,
  fallbackUrl: string | null,
): VideoAssetRecord {
  if (packaged) {
    return {
      id: asset.id,
      label: asset.label,
      kind: "packaged",
      durationSec: packaged.durationSec,
      masterKey: packaged.master,
      externalUrl: asset.externalHlsUrl,
      maxHeight: Math.max(
        ...packaged.renditions.map((rendition) =>
          nominalVideoHeight(rendition.width, rendition.height),
        ),
      ),
      textTracks: packaged.textTracks,
      trickPlay: packaged.trickPlay,
      markers: packaged.markers,
    };
  }
  return {
    id: asset.id,
    label: asset.label,
    kind: fallbackUrl ? "external" : "unavailable",
    durationSec: asset.source.durationSec ?? null,
    masterKey: null,
    externalUrl: fallbackUrl,
    maxHeight: null,
    textTracks: [],
    trickPlay: null,
    markers: { intro: null, recap: null, creditsStartSec: null },
  };
}

/**
 * The stream an unpackaged asset falls back to, so the product plays end to end before
 * `tools/media` has run: the asset's own `externalHlsUrl`; else the stream of another asset cut
 * from the same source file (a chapter plays its whole film); else the catalog's first stream.
 * Null only when the seed has no external stream at all.
 */
function fallbackStreams(
  catalog: CatalogSeed,
): (asset: CatalogSeed["videoAssets"][number]) => string | null {
  const bySource = new Map<string, string>();
  let first: string | null = null;
  for (const asset of catalog.videoAssets) {
    if (!asset.externalHlsUrl) continue;
    first ??= asset.externalHlsUrl;
    if (asset.source.kind === "download" && !bySource.has(asset.source.url)) {
      bySource.set(asset.source.url, asset.externalHlsUrl);
    }
  }
  return (asset) =>
    asset.externalHlsUrl ??
    (asset.source.kind === "download" ? bySource.get(asset.source.url) : undefined) ??
    first;
}

function mainAssetId(title: TitleSeed): string | undefined {
  return title.type === "movie" ? title.videoAssetId : title.seasons[0]?.episodes[0]?.videoAssetId;
}

/** Turn the seed (and, if media was packaged, its manifest) into catalog rows. */
export function buildCatalogWrite(
  catalog: CatalogSeed,
  manifest: MediaManifest | null,
  now: number,
  version: string,
): CatalogWrite {
  const packaged = new Map(manifest?.videoAssets.map((asset) => [asset.assetId, asset]) ?? []);
  const artwork = new Map(manifest?.titleArtwork.map((entry) => [entry.titleId, entry]) ?? []);
  const stills = new Map(
    manifest?.episodeStills.map((entry) => [entry.episodeId, entry.still]) ?? [],
  );
  const avatarImages = new Map(manifest?.avatars.map((entry) => [entry.avatarId, entry]) ?? []);
  const seedAssets = new Map(catalog.videoAssets.map((asset) => [asset.id, asset]));

  const fallback = fallbackStreams(catalog);
  const videoAssets = catalog.videoAssets.map((asset) =>
    videoAssetRecord(asset, packaged.get(asset.id), fallback(asset)),
  );
  const assets = new Map(videoAssets.map((asset) => [asset.id, asset]));
  const playable = (assetId: string) => {
    const kind = assets.get(assetId)?.kind;
    return kind === "packaged" || kind === "external";
  };

  const titles: TitleRecord[] = [];
  const episodes: EpisodeRecord[] = [];
  const credits: CreditRecord[] = [];
  const seasons: CatalogWrite["seasons"] = [];

  for (const title of catalog.titles) {
    const art = artwork.get(title.id);
    const images: TitleImages = art
      ? {
          backdrop: artworkToImageSet(art.backdrop),
          card: artworkToImageSet(art.card),
          poster: artworkToImageSet(art.poster),
          logo: art.logo ? artworkToImageSet(art.logo) : null,
        }
      : {
          backdrop: fallbackImage(title.id, "backdrop"),
          card: fallbackImage(title.id, "card"),
          poster: fallbackImage(title.id, "poster"),
          logo: null,
        };

    const assetIds =
      title.type === "movie"
        ? [title.videoAssetId]
        : title.seasons.flatMap((season) => season.episodes.map((episode) => episode.videoAssetId));
    const previewAsset = packaged.get(title.previewAssetId ?? mainAssetId(title) ?? "");
    const subtitleLanguages = new Set<string>();
    for (const assetId of assetIds) {
      const packagedAsset = packaged.get(assetId);
      const languages = packagedAsset
        ? packagedAsset.textTracks.map((track) => track.language)
        : (seedAssets.get(assetId)?.subtitleLanguages ?? []);
      for (const language of languages) subtitleLanguages.add(language);
    }
    const mainSource = seedAssets.get(mainAssetId(title) ?? "")?.source;
    const license = title.license ?? (mainSource?.kind === "download" ? mainSource.license : null);

    if (title.type === "series") {
      let seq = 0;
      for (const season of title.seasons) {
        seasons.push({
          titleId: title.id,
          number: season.number,
          name: season.name,
          releaseYear: season.releaseYear,
          episodeCount: season.episodes.length,
        });
        for (const episode of season.episodes) {
          seq += 1;
          const still = stills.get(episode.id);
          episodes.push({
            id: episode.id,
            titleId: title.id,
            seasonNumber: season.number,
            number: episode.number,
            seq,
            name: episode.name,
            synopsis: episode.synopsis,
            runtimeSec: episode.runtimeSec,
            videoAssetId: episode.videoAssetId,
            still: still ? artworkToImageSet(still) : null,
            isPlayable: playable(episode.videoAssetId),
          });
        }
      }
    }

    title.cast.forEach((credit, position) => {
      credits.push({
        titleId: title.id,
        personId: credit.personId,
        role: "cast",
        character: credit.character,
        position,
      });
    });
    for (const [role, ids] of [
      ["director", title.directorIds],
      ["creator", title.creatorIds],
      ["writer", title.writerIds],
    ] as const) {
      ids.forEach((personId, position) => {
        credits.push({ titleId: title.id, personId, role, character: null, position });
      });
    }

    titles.push({
      id: title.id,
      type: title.type,
      name: title.name,
      tagline: title.tagline,
      synopsis: title.synopsis,
      releaseYear: title.releaseYear,
      maturity: title.maturity,
      maturityDescriptors: title.maturityDescriptors,
      genreIds: title.genreIds,
      moods: title.moods,
      isOriginal: title.isOriginal,
      addedAt: now - title.addedDaysAgo * DAY_MS,
      popularity: title.popularity,
      runtimeSec: title.type === "movie" ? title.runtimeSec : null,
      seasonCount: title.type === "series" ? title.seasons.length : null,
      videoAssetId: title.type === "movie" ? title.videoAssetId : null,
      attribution: license
        ? {
            text: license.attribution,
            license: license.license,
            licenseUrl: license.licenseUrl,
            sourceUrl: license.sourceUrl,
          }
        : null,
      audioLanguages: title.audioLanguages,
      subtitleLanguages: [...subtitleLanguages].sort(),
      images,
      preview: previewAsset?.preview
        ? {
            url: cdnUrlForBlobKey(previewAsset.preview.key),
            durationSec: previewAsset.preview.durationSec,
            width: previewAsset.preview.width,
            height: previewAsset.preview.height,
          }
        : null,
      isPlayable: assetIds.some(playable),
    });
  }

  const notifications: NotificationRecord[] = titles
    .filter((title) => now - title.addedAt <= NOTIFY_WITHIN_DAYS * DAY_MS)
    .map((title) => ({
      id: `n-${fnvHex(title.id)}-${title.id}`.slice(0, 64),
      kind: "new-arrival",
      titleId: title.id,
      headline: title.type === "series" ? "New Series" : "New Arrival",
      body: title.tagline ? `${title.name}: ${title.tagline}` : `${title.name} is now streaming.`,
      image: title.images.card,
      maturity: title.maturity,
      createdAt: title.addedAt,
    }));

  return {
    version,
    genres: catalog.genres.map((genre, position) => ({ ...genre, position })),
    people: catalog.people,
    titles,
    credits,
    seasons,
    episodes,
    videoAssets,
    avatarGroups: catalog.avatarGroups.map((group, position) => ({ ...group, position })),
    avatars: catalog.avatars.map((avatar, position) => {
      const image = avatarImages.get(avatar.id);
      return {
        id: avatar.id,
        groupId: avatar.groupId,
        name: avatar.name,
        imageUrl: image
          ? `${cdnUrlForBlobKey(image.key)}?v=${image.version}`
          : cdnUrlForBlobKey(blobKeys.avatar(avatar.id)),
        position,
      };
    }),
    notifications,
  };
}

/** Search documents for every title (people: cast, directors, creators, writers). */
export function buildSearchDocuments(write: CatalogWrite): SearchDocument[] {
  const people = new Map(write.people.map((person) => [person.id, person.name]));
  const genres = new Map(write.genres.map((genre) => [genre.id, genre]));
  return write.titles.map((title) => {
    const credited = new Map<string, string>();
    for (const credit of write.credits) {
      if (credit.titleId !== title.id) continue;
      const name = people.get(credit.personId);
      if (name) credited.set(credit.personId, name);
    }
    return {
      id: title.id,
      type: title.type,
      maturity: title.maturity,
      name: title.name,
      people: [...credited].map(([id, name]) => ({ id, name })),
      genres: title.genreIds.flatMap((id) => {
        const genre = genres.get(id);
        return genre ? [{ slug: genre.slug, name: genre.name }] : [];
      }),
      moods: title.moods,
      synopsis: title.synopsis,
      popularity: title.popularity,
    };
  });
}

// --- Demo account -----------------------------------------------------------------------------

async function buildDemoAccount(
  demo: DemoAccountSeed,
  write: CatalogWrite,
  deps: ServiceDependencies,
  now: number,
): Promise<AccountWrite> {
  const titles = new Map(write.titles.map((title) => [title.id, title]));
  const episodes = new Map(write.episodes.map((episode) => [episode.id, episode]));
  const assets = new Map(write.videoAssets.map((asset) => [asset.id, asset]));
  const plan = getPlan(demo.planId);
  const accountId = DEMO_ACCOUNT_ID;
  const expiry = new Date(now);

  const profiles = await Promise.all(
    demo.profiles.map(async (profile, index) => ({
      id: profile.id,
      accountId,
      name: profile.name,
      avatarId: profile.avatarId,
      isKids: profile.isKids,
      maturityCeiling: profile.maturityCeiling,
      pinHash: profile.pin ? await deps.passwords.hash(profile.pin) : null,
      settings: { ...DEFAULT_PROFILE_SETTINGS, ...profile.settings },
      // Oldest first, in seed order.
      createdAt: now - 365 * DAY_MS + index * 60_000,
      updatedAt: now,
    })),
  );

  const progress: ProgressRecord[] = [];
  const history: AccountWrite["history"] = [];
  for (const profile of demo.profiles) {
    for (const entry of profile.viewing) {
      const title = titles.get(entry.titleId);
      if (!title) continue;
      const episode = entry.episodeId ? episodes.get(entry.episodeId) : undefined;
      const itemId = episode?.id ?? title.id;
      // Measured on the stream Play will open (fast-profile media is minutes long, whatever
      // the catalog runtime says), so the resume point exists in it.
      const assetId = episode?.videoAssetId ?? title.videoAssetId;
      const durationSec =
        (assetId ? assets.get(assetId)?.durationSec : null) ??
        episode?.runtimeSec ??
        title.runtimeSec ??
        0;
      const watchedAt = now - entry.daysAgo * DAY_MS;
      progress.push({
        profileId: profile.id,
        itemId,
        titleId: title.id,
        episodeId: episode?.id ?? null,
        positionSec: Math.round(durationSec * entry.progress),
        durationSec,
        completed: entry.completed,
        hidden: false,
        updatedAt: watchedAt,
      });
      history.push({
        id: deps.ids.next(),
        profileId: profile.id,
        itemId,
        titleId: title.id,
        episodeId: episode?.id ?? null,
        watchedAt,
      });
    }
  }

  return {
    account: {
      id: accountId,
      email: demo.email,
      passwordHash: await deps.passwords.hash(demo.password),
      createdAt: now - 400 * DAY_MS,
      updatedAt: now,
    },
    subscription: {
      accountId,
      planId: plan.id,
      startedAt: now - 400 * DAY_MS,
      currentPeriodEnd: now + BILLING_PERIOD_MS / 2,
      canceledAt: null,
      card: { ...DEMO_CARD, expYear: expiry.getUTCFullYear() + 3 },
      updatedAt: now,
    },
    profiles,
    myList: demo.profiles.flatMap((profile) =>
      profile.myList
        .filter((titleId) => titles.has(titleId))
        .map((titleId, index) => ({
          profileId: profile.id,
          titleId,
          addedAt: now - (index + 1) * 3_600_000,
        })),
    ),
    ratings: demo.profiles.flatMap((profile) =>
      profile.ratings
        .filter((rating) => titles.has(rating.titleId))
        .map((rating, index) => ({
          profileId: profile.id,
          titleId: rating.titleId,
          value: rating.value,
          ratedAt: now - (index + 1) * DAY_MS,
        })),
    ),
    // One row per item: the seed may list an item twice; the latest entry wins.
    progress: dedupeBy(
      progress,
      (entry) => `${entry.profileId}:${entry.itemId}`,
      (entry) => entry.updatedAt,
    ),
    history: dedupeBy(
      history,
      (entry) => `${entry.profileId}:${entry.itemId}`,
      (entry) => entry.watchedAt,
    ),
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string, time: (item: T) => number): T[] {
  const latest = new Map<string, T>();
  for (const item of items) {
    const existing = latest.get(key(item));
    if (!existing || time(item) > time(existing)) latest.set(key(item), item);
  }
  return [...latest.values()];
}

// --- The seeder -------------------------------------------------------------------------------

export async function seedHash(input: SeedInput): Promise<string> {
  return sha256Hex(
    utf8Encode(
      JSON.stringify({
        format: SEED_FORMAT_VERSION,
        catalog: input.catalog,
        demoAccount: input.demoAccount ?? null,
        manifest: input.manifest ?? null,
      }),
    ),
  );
}

/**
 * Idempotent loader: catalog (atomically replaced), search index, synthetic stats and the
 * demo account (reset to its seeded state). Skips everything when the same inputs were
 * already applied, unless `force`; even then the demo account is reset if what visitors must
 * not change has drifted (a takeover before the API protected it, or a manual edit).
 */
export function createSeeder(deps: ServiceDependencies, state: ServiceState) {
  const { repos, search, clock, logger, passwords } = deps;

  /** The protected parts of the demo account that differ from the seed. */
  async function demoDrift(demo: DemoAccountSeed): Promise<string[]> {
    const loaded = await repos.accounts.get(DEMO_ACCOUNT_ID);
    if (!loaded) return ["account"];
    const { account, subscription } = loaded;
    const drift: string[] = [];
    if (account.email !== demo.email) drift.push("email");
    // The demo password is public: checking it here is no oracle.
    if (!(await passwords.verify(demo.password, account.passwordHash)).valid) {
      drift.push("password");
    }
    if (
      subscription.planId !== demo.planId ||
      subscription.canceledAt !== null ||
      effectiveSubscription(subscription, clock.now()).status !== "active" ||
      subscription.card?.last4 !== DEMO_CARD.last4
    ) {
      drift.push("membership");
    }
    const stored = new Map(
      (await repos.profiles.list(DEMO_ACCOUNT_ID)).map((profile) => [profile.id, profile]),
    );
    let profilesDrifted = stored.size !== demo.profiles.length;
    for (const seeded of demo.profiles) {
      const profile = stored.get(seeded.id);
      profilesDrifted ||=
        !profile ||
        profile.name !== seeded.name ||
        profile.avatarId !== seeded.avatarId ||
        profile.isKids !== seeded.isKids ||
        profile.maturityCeiling !== seeded.maturityCeiling ||
        (seeded.pin === null
          ? profile.pinHash !== null
          : profile.pinHash === null ||
            !(await passwords.verify(seeded.pin, profile.pinHash)).valid);
    }
    if (profilesDrifted) drift.push("profiles");
    return drift;
  }

  return {
    async seed(input: SeedInput, options: { force?: boolean } = {}): Promise<SeedResult> {
      const hash = await seedHash(input);
      const write = buildCatalogWrite(
        input.catalog,
        input.manifest ?? null,
        clock.now(),
        hash.slice(0, 16),
      );
      const result: SeedResult = {
        skipped: false,
        hash,
        titles: write.titles.length,
        episodes: write.episodes.length,
        packagedAssets: write.videoAssets.filter((asset) => asset.kind === "packaged").length,
        externalAssets: write.videoAssets.filter((asset) => asset.kind === "external").length,
        unavailableAssets: write.videoAssets.filter((asset) => asset.kind === "unavailable").length,
        demoAccount: Boolean(input.demoAccount),
        demoRestored: [],
      };
      if (!options.force && (await repos.meta.get(SEED_HASH_KEY)) === hash) {
        const drift = input.demoAccount ? await demoDrift(input.demoAccount) : [];
        if (input.demoAccount && drift.length > 0) {
          await repos.seed.replaceAccount(
            await buildDemoAccount(input.demoAccount, write, deps, clock.now()),
          );
          logger.warn("seed.demo_restored", { drift });
        }
        return { ...result, skipped: true, demoRestored: drift };
      }

      const now = clock.now();
      const previousIds = await repos.catalog.listTitleIds();
      await repos.seed.replaceCatalog(write);

      const current = new Set(write.titles.map((title) => title.id));
      const stale = previousIds.filter((id) => !current.has(id));
      if (stale.length > 0) await search.remove(stale);
      await search.upsert(buildSearchDocuments(write));

      const today = utcDay(now);
      const days = Array.from({ length: BASELINE_DAYS }, (_, index) => addDays(today, -index));
      await repos.seed.replaceBaselineStats(baselineStats(write.titles, days));

      if (input.demoAccount) {
        await repos.seed.replaceAccount(
          await buildDemoAccount(input.demoAccount, write, deps, now),
        );
      }
      await repos.meta.set(SEED_HASH_KEY, hash, now);
      await Promise.all([
        state.catalog.invalidate(),
        state.popularity.invalidate(),
        state.showcase.invalidate(),
      ]);
      logger.info("seed.applied", { ...result });
      return result;
    },
  };
}

export type Seeder = ReturnType<typeof createSeeder>;
