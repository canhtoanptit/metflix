import type {
  Account,
  Avatar,
  ContinueWatchingItem,
  DeviceSession,
  EpisodeRef,
  GenreRef,
  ImageSet,
  Notification,
  PaymentMethod,
  PlayTarget,
  Profile,
  Progress,
  Subscription,
  TitleCard,
  TitleDetail,
} from "@webflix/contracts";
import type { CatalogSnapshot } from "../catalog/snapshot.ts";
import { toIsoString } from "../ports/clock.ts";
import type {
  CardSurface,
  ContinueWatchingPlan,
  Personalization,
  PlayTargetPlan,
} from "../recommendations/engine.ts";
import type { NotificationView } from "../repositories/ports.ts";
import type {
  AccountRecord,
  AvatarRecord,
  EpisodeSummary,
  ProfileRecord,
  ProgressRecord,
  SessionRecord,
  SubscriptionRecord,
  TitleRecord,
} from "../repositories/records.ts";
import { isDemoAccount } from "./privileges.ts";
import { effectiveSubscription } from "./subscriptions.ts";

/** Records → contract DTOs. Pure; every response body is built here or from these pieces. */

export function presentAccount(account: AccountRecord): Account {
  return {
    id: account.id,
    email: account.email,
    createdAt: toIsoString(account.createdAt),
    ...(isDemoAccount(account.id) ? { isDemo: true as const } : {}),
  };
}

export function presentSubscription(subscription: SubscriptionRecord, now: number): Subscription {
  const effective = effectiveSubscription(subscription, now);
  return {
    planId: subscription.planId,
    status: effective.status,
    startedAt: toIsoString(subscription.startedAt),
    currentPeriodEnd: toIsoString(effective.currentPeriodEnd),
    canceledAt: subscription.canceledAt === null ? null : toIsoString(subscription.canceledAt),
  };
}

export function presentPaymentMethod(subscription: SubscriptionRecord): PaymentMethod | null {
  return subscription.card ? { ...subscription.card } : null;
}

const FALLBACK_AVATAR_GROUP = "default";

export function presentAvatar(avatar: AvatarRecord): Avatar {
  return { id: avatar.id, name: avatar.name, imageUrl: avatar.imageUrl, groupId: avatar.groupId };
}

export function presentProfile(profile: ProfileRecord): Profile {
  return {
    id: profile.id,
    name: profile.name,
    // An avatar removed from the catalog still renders (the CDN path of its old image).
    avatar: profile.avatar
      ? presentAvatar(profile.avatar)
      : {
          id: profile.avatarId,
          name: "Avatar",
          imageUrl: `/cdn/img/avatars/${profile.avatarId}.webp`,
          groupId: FALLBACK_AVATAR_GROUP,
        },
    isKids: profile.isKids,
    maturityCeiling: profile.maturityCeiling,
    isLocked: profile.pinHash !== null,
    settings: { ...profile.settings },
    createdAt: toIsoString(profile.createdAt),
  };
}

export function presentDevice(session: SessionRecord, currentSessionId: string): DeviceSession {
  return {
    id: session.id,
    current: session.id === currentSessionId,
    label: session.deviceLabel,
    deviceType: session.deviceType,
    createdAt: toIsoString(session.createdAt),
    lastSeenAt: toIsoString(session.lastSeenAt),
  };
}

export function presentEpisodeRef(episode: EpisodeSummary): EpisodeRef {
  return {
    id: episode.id,
    seasonNumber: episode.seasonNumber,
    number: episode.number,
    name: episode.name,
  };
}

export function presentProgress(progress: {
  positionSec: number;
  durationSec: number;
  completed: boolean;
  updatedAt: number;
}): Progress {
  return {
    positionSec: Math.max(0, progress.positionSec),
    durationSec: Math.max(0, progress.durationSec),
    completed: progress.completed,
    updatedAt: toIsoString(progress.updatedAt),
  };
}

export function presentProgressRecord(progress: ProgressRecord): Progress {
  return presentProgress(progress);
}

function genreRefs(snapshot: CatalogSnapshot, title: TitleRecord): GenreRef[] {
  return title.genreIds.flatMap((id) => {
    const genre = snapshot.genre(id);
    return genre ? [{ slug: genre.slug, name: genre.name }] : [];
  });
}

/**
 * One card as it appears on `surface` (which decides the badge and the Top 10 list its rank
 * refers to; see `Personalization.cardSurface`).
 */
export function presentCard(
  personalization: Personalization,
  title: TitleRecord,
  surface: CardSurface,
): TitleCard {
  const rank = personalization.top10Rank(title.id, surface.view);
  const quality = personalization.bestVideoQuality(title.id);
  return {
    id: title.id,
    type: title.type,
    name: title.name,
    releaseYear: title.releaseYear,
    maturity: title.maturity,
    runtimeSec: title.type === "movie" ? title.runtimeSec : null,
    seasonCount: title.type === "series" && title.seasonCount ? title.seasonCount : null,
    genres: genreRefs(personalization.snapshot, title).slice(0, 3),
    moods: title.moods.slice(0, 3),
    matchScore: personalization.matchScore(title.id),
    isOriginal: title.isOriginal,
    badge: surface.badges.get(title.id) ?? null,
    ...(rank === null ? {} : { top10Rank: rank }),
    ...(quality === null ? {} : { bestVideoQuality: quality }),
    images: { card: title.images.card, poster: title.images.poster, logo: title.images.logo },
    preview: title.preview,
    viewer: {
      inMyList: personalization.inMyList(title.id),
      rating: personalization.rating(title.id),
    },
  };
}

/** Cards for ids on one surface, skipping any the snapshot no longer has. */
export function presentCards(
  personalization: Personalization,
  ids: readonly string[],
  surface: CardSurface,
): TitleCard[] {
  return ids.flatMap((id) => {
    const title = personalization.snapshot.title(id);
    return title ? [presentCard(personalization, title, surface)] : [];
  });
}

export function presentPlayTarget(plan: PlayTargetPlan | null): PlayTarget | null {
  if (!plan) return null;
  return {
    action: plan.action,
    episode: plan.episode ? presentEpisodeRef(plan.episode) : null,
    positionSec: plan.positionSec,
    progress: plan.progress ? presentProgressRecord(plan.progress) : null,
  };
}

export function presentContinueItem(
  personalization: Personalization,
  item: ContinueWatchingPlan,
  surface: CardSurface,
): ContinueWatchingItem | null {
  const title = personalization.snapshot.title(item.titleId);
  if (!title) return null;
  return {
    title: presentCard(personalization, title, surface),
    episode: item.episode ? presentEpisodeRef(item.episode) : null,
    progress: presentProgress(item),
  };
}

export function presentTitleDetail(
  personalization: Personalization,
  title: TitleRecord,
): TitleDetail {
  const { snapshot } = personalization;
  const credits = snapshot.credits(title.id);
  const people = (role: string) =>
    credits
      .filter((credit) => credit.role === role)
      .sort((a, b) => a.position - b.position)
      .map((credit) => ({ id: credit.personId, name: credit.personName }));
  const progress = personalization.progress(title.id);
  // Movies: the movie's own progress once it was watched far enough to count (a sample is not
  // a resume point). Series: progress of the episode Play would resume.
  const progressRecord =
    title.type === "movie" ? progress?.anchor : (progress?.next?.progress ?? undefined);
  const progressDto = progressRecord ? presentProgressRecord(progressRecord) : null;
  return {
    ...presentCard(
      personalization,
      title,
      personalization.cardSurface([title.id], "home", "single"),
    ),
    synopsis: title.synopsis,
    tagline: title.tagline,
    genres: genreRefs(snapshot, title),
    moods: [...title.moods],
    maturityDescriptors: [...title.maturityDescriptors],
    images: { ...title.images },
    cast: credits
      .filter((credit) => credit.role === "cast")
      .sort((a, b) => a.position - b.position)
      .map((credit) => ({
        id: credit.personId,
        name: credit.personName,
        character: credit.character,
      })),
    directors: people("director"),
    creators: people("creator"),
    writers: people("writer"),
    seasons: snapshot.seasons(title.id).map((season) => ({
      number: season.number,
      name: season.name,
      episodeCount: season.episodeCount,
      releaseYear: season.releaseYear,
    })),
    audioLanguages: [...title.audioLanguages],
    subtitleLanguages: [...title.subtitleLanguages],
    attribution: title.attribution,
    addedAt: toIsoString(title.addedAt),
    isPlayable: title.isPlayable,
    playTarget: presentPlayTarget(personalization.playTarget(title.id)),
    viewer: {
      inMyList: personalization.inMyList(title.id),
      rating: personalization.rating(title.id),
      progress: progressDto,
    },
  };
}

export function presentNotification(
  snapshot: CatalogSnapshot,
  notification: NotificationView,
): Notification {
  const title = notification.titleId ? snapshot.title(notification.titleId) : undefined;
  return {
    id: notification.id,
    kind: notification.kind,
    createdAt: toIsoString(notification.createdAt),
    readAt: notification.readAt === null ? null : toIsoString(notification.readAt),
    headline: notification.headline,
    body: notification.body,
    title: title ? { id: title.id, name: title.name } : null,
    image: notification.image satisfies ImageSet | null,
  };
}
