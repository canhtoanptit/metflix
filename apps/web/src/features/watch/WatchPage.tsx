import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import type { NextEpisode, PlaybackSession, Profile } from "@webflix/contracts";
import {
  type EpisodesSource,
  Player,
  type PlayerHandle,
  type PlayerPreferences,
} from "@webflix/player";
import { ArrowLeftIcon, IconButton, Spinner, WifiOffIcon } from "@webflix/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../app/api.ts";
import { useDocumentTitle } from "../../app/head/DocumentTitle.tsx";
import { qk } from "../../app/query/keys.ts";
import { queries } from "../../app/query/queries.ts";
import {
  sessionCache,
  useActiveProfile,
  useAuthenticatedSession,
} from "../../app/session/session.ts";
import { upsertSessionProfile } from "../member/shared/sessionProfiles.ts";
import { WatchEndScreen } from "./EndScreen.tsx";
import { isSameItem, type WatchLifecycle } from "./lifecycle.ts";
import { PLAYER_THEME } from "./playerTheme.ts";
import { useWatchLifecycle } from "./useWatchLifecycle.ts";
import { WatchStatus } from "./WatchStatus.tsx";

const route = getRouteApi("/profile/watch/$titleId");

/** Consecutive autoplayed episodes without any input before autoplay pauses ("still watching?"). */
const UNATTENDED_AUTOPLAY_LIMIT = 3;
const LEAVE_TIMEOUT_MS = 1500;

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
  ]);
}

function episodeCode(session: PlaybackSession): string | null {
  const episode = session.display.episode;
  return episode ? `S${episode.seasonNumber}:E${episode.number}` : null;
}

/**
 * The watch page: creates the playback session, hands it to `<Player>` and runs the session's
 * whole life (see `lifecycle.ts`): heartbeats from the player's progress reports, episode
 * switches in place (URL replaced, not pushed), transparent recovery from an expired media
 * token, designed screens for every refusal, and a clean exit that saves the position before
 * returning the member where they came from.
 */
export function WatchPage() {
  const { titleId } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useAuthenticatedSession();
  const profile = useActiveProfile();
  const playerRef = useRef<PlayerHandle>(null);
  const title = useQuery(queries.title(titleId));
  const leavingRef = useRef(false);

  /** Continue Watching, the title's progress and the home rows change with what was watched. */
  const refreshLibrary = useCallback(
    () =>
      Promise.all([
        queryClient.refetchQueries({ queryKey: qk.profile.continueWatching(), type: "all" }),
        queryClient.refetchQueries({ queryKey: qk.profile.browse("home"), type: "all" }),
        queryClient.invalidateQueries({ queryKey: qk.profile.titles() }),
        queryClient.invalidateQueries({ queryKey: qk.profile.history() }),
      ]),
    [queryClient],
  );

  const { lifecycle, state } = useWatchLifecycle(
    {
      api: api(),
      snapshot: (reason) => playerRef.current?.getProgress(reason) ?? null,
      onSessionChange: (next) => {
        // Reflect what is playing, so refresh and share resume it; replace, never push.
        void navigate({
          to: "/watch/$titleId",
          params: { titleId: next.titleId },
          search: { episode: next.episodeId ?? undefined },
          replace: true,
        });
      },
    },
    {
      start: (instance: WatchLifecycle) =>
        void instance.open({ titleId, episodeId: search.episode, startPositionSec: search.t }),
      // Left by the browser's Back button or any other navigation: refresh once saved.
      left: (finished) => {
        if (!leavingRef.current) void finished.then(refreshLibrary);
      },
    },
  );

  // The URL changed to something else (a recommendation, the address bar): load it in place.
  // Keyed on the URL only: our own `replace` after a switch lands on what is already playing.
  useEffect(() => {
    const playing = lifecycle.getState().session;
    if (!playing || leavingRef.current) return;
    const target = { titleId, episodeId: search.episode };
    if (!isSameItem(target, playing)) void lifecycle.open(target);
  }, [titleId, search.episode, lifecycle]);

  const leave = useCallback(async () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    await withTimeout(lifecycle.finish(), LEAVE_TIMEOUT_MS);
    await withTimeout(refreshLibrary(), LEAVE_TIMEOUT_MS);
    if (router.history.canGoBack()) router.history.back();
    else await navigate({ to: "/browse", replace: true });
  }, [lifecycle, refreshLibrary, router, navigate]);

  const current = state.session;
  const display = current?.display;
  useDocumentTitle(
    display
      ? [display.titleName, current ? episodeCode(current) : null].filter(Boolean).join(" · ")
      : (title.data?.name ?? null),
  );

  // Series: the episodes panel, and the playing episode's synopsis for the paused overlay.
  const detail = title.data;
  const episodes = useMemo<EpisodesSource | null>(
    () =>
      detail && detail.type === "series" && detail.seasons.length > 0
        ? {
            seasons: detail.seasons,
            currentEpisodeId: current?.episodeId ?? null,
            loadEpisodes: async (seasonNumber) =>
              (await queryClient.fetchQuery(queries.episodes(detail.id, seasonNumber))).items,
          }
        : null,
    [detail, current?.episodeId, queryClient],
  );
  const season = display?.episode?.seasonNumber;
  const seasonEpisodes = useQuery({
    ...queries.episodes(titleId, season ?? 1),
    enabled: season !== undefined,
  });
  const synopsis =
    (current?.episodeId
      ? seasonEpisodes.data?.items.find((episode) => episode.id === current.episodeId)?.synopsis
      : null) ??
    detail?.synopsis ??
    null;

  const autoplay = useUnattendedAutoplayGuard(current);
  const preferences = useProfilePlayerPreferences(profile);

  const onNextEpisode = useCallback(
    (next: NextEpisode, reason: "autoplay" | "user") => {
      autoplay.count(reason);
      void lifecycle.open({ titleId, episodeId: next.episode.id });
    },
    [autoplay, lifecycle, titleId],
  );

  const returnTo = `/watch/${encodeURIComponent(titleId)}${current?.episodeId ? `?episode=${encodeURIComponent(current.episodeId)}` : ""}`;
  const status = state.block ? (
    <WatchStatus
      block={state.block}
      title={detail}
      profile={profile}
      planName={session.plan.name}
      returnTo={returnTo}
      retrying={state.switching}
      onRetry={() => void lifecycle.retry()}
      onBack={() => void leave()}
      onSignedOut={() => {
        sessionCache.signOut(queryClient);
        void router.invalidate();
      }}
      variant={current ? "overlay" : "page"}
    />
  ) : null;

  if (!current) {
    if (status) return status;
    return <WatchLoading titleName={detail?.name ?? null} onBack={() => void leave()} />;
  }

  return (
    <div className="fixed inset-0 bg-black" data-testid="watch-page" data-session={current.id}>
      <Player
        ref={playerRef}
        session={current}
        progressIntervalSec={state.heartbeatIntervalSec}
        autoplayNextEpisode={autoplay.paused ? false : undefined}
        synopsis={synopsis}
        episodes={episodes}
        onBack={() => void leave()}
        onProgress={(report) => void lifecycle.report(report)}
        onStateChange={(phase) => lifecycle.phase(phase)}
        onError={(error) => void lifecycle.playerError(error)}
        onNextEpisode={onNextEpisode}
        onSelectEpisode={(episode) => {
          autoplay.count("user");
          void lifecycle.open({ titleId, episodeId: episode.id });
        }}
        preferences={preferences.value}
        preferenceStorage={`webflix.player.${profile.id}`}
        onPreferencesChange={preferences.onChange}
        renderEndScreen={(context) => <WatchEndScreen title={detail} context={context} />}
        blockingOverlay={status}
        style={PLAYER_THEME}
      />
      {state.connection === "offline" && !state.block ? <ConnectionBanner /> : null}
    </div>
  );
}

function WatchLoading({ titleName, onBack }: { titleName: string | null; onBack: () => void }) {
  return (
    <div className="fixed inset-0 flex flex-col bg-black" data-testid="watch-loading">
      <header className="flex h-nav items-center gap-4 px-gutter">
        <IconButton
          label="Back to browse"
          icon={ArrowLeftIcon}
          variant="ghost"
          size="lg"
          onClick={onBack}
        />
        {titleName ? <span className="truncate type-title text-fg-muted">{titleName}</span> : null}
      </header>
      <main id="main" className="grid flex-1 place-items-center pb-nav">
        <Spinner size="xl" label={titleName ? `Loading ${titleName}` : "Loading"} />
      </main>
    </div>
  );
}

/** Heartbeats are failing: say so quietly while the buffer keeps playing. */
function ConnectionBanner() {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-4 z-(--z-toast) flex justify-center px-gutter"
    >
      <span className="inline-flex items-center gap-2 rounded-full bg-surface-2/95 px-4 py-2 type-label text-fg shadow-lg">
        <WifiOffIcon size="sm" className="text-warning" />
        Connection lost. Reconnecting…
      </span>
    </div>
  );
}

/**
 * After several episodes autoplayed in a row with nobody touching anything, stop autoplaying
 * (the next one waits for a click), so an unattended screen doesn't stream all night.
 */
function useUnattendedAutoplayGuard(session: PlaybackSession | null) {
  const [unattended, setUnattended] = useState(0);
  useEffect(() => {
    const reset = () => setUnattended(0);
    window.addEventListener("pointerdown", reset);
    window.addEventListener("keydown", reset);
    return () => {
      window.removeEventListener("pointerdown", reset);
      window.removeEventListener("keydown", reset);
    };
  }, []);
  const paused = Boolean(session?.autoplayNextEpisode) && unattended >= UNATTENDED_AUTOPLAY_LIMIT;
  return useMemo(
    () => ({
      paused,
      count: (reason: "autoplay" | "user") =>
        setUnattended((value) => (reason === "autoplay" ? value + 1 : 0)),
    }),
    [paused],
  );
}

/**
 * Player preferences are remembered per profile (storage key) and the subtitle language is the
 * profile's own setting: choosing subtitles in the player saves it to the profile.
 */
function useProfilePlayerPreferences(profile: Profile) {
  const queryClient = useQueryClient();
  const subtitleLanguage = profile.settings.subtitleLanguage;
  const value = useMemo(() => ({ subtitleLanguage }), [subtitleLanguage]);
  const onChange = useCallback(
    (next: PlayerPreferences, changed: readonly (keyof PlayerPreferences)[]) => {
      if (!changed.includes("subtitleLanguage")) return;
      const language = next.subtitleLanguage ?? null;
      if (language === subtitleLanguage) return;
      void api()
        .updateProfile({
          params: { id: profile.id },
          body: { settings: { subtitleLanguage: language } },
        })
        .then((updated) => upsertSessionProfile(queryClient, updated))
        .catch(() => {
          // A preference: the player already applied it; the profile keeps the old default.
        });
    },
    [profile.id, subtitleLanguage, queryClient],
  );
  return { value, onChange };
}
