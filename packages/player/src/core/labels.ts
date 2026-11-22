/**
 * Every user-visible string, in one overridable object (English defaults). Hosts pass a
 * partial `labels` prop to localise or adjust copy.
 */
export interface PlayerLabels {
  player: string;
  play: string;
  pause: string;
  replay: string;
  back: string;
  seekBack: (seconds: number) => string;
  seekForward: (seconds: number) => string;
  mute: string;
  unmute: string;
  volume: string;
  seekSlider: string;
  /** "12:03 of 45:00" — slider value text, given spoken durations. */
  timeOf: (current: string, total: string) => string;
  remaining: (time: string) => string;
  fullscreen: string;
  exitFullscreen: string;
  pip: string;
  exitPip: string;
  pipActive: string;
  audioAndSubtitles: string;
  audio: string;
  subtitles: string;
  subtitlesOff: string;
  subtitlesOn: (label: string) => string;
  speed: string;
  speedNormal: string;
  quality: string;
  qualityAuto: string;
  qualityAutoCurrent: (label: string) => string;
  /** Quality menu note when the title, not the plan, tops out lower: "Best available for this title: HD". */
  qualityTitleLimit: (label: string) => string;
  episodes: string;
  season: string;
  seasonOption: (seasonNumber: number, name: string) => string;
  nowPlaying: string;
  episodesLoading: string;
  episodesError: string;
  retry: string;
  nextEpisode: string;
  nextEpisodeIn: (seconds: number) => string;
  playNextEpisode: string;
  watchCredits: string;
  skipIntro: string;
  skipRecap: string;
  close: string;
  youAreWatching: string;
  episodeLabel: (season: number, episode: number) => string;
  maturityRated: (rating: string) => string;
  buffering: string;
  playing: string;
  paused: string;
  ended: string;
  volumeLevel: (percent: number) => string;
  muted: string;
  speedChanged: (label: string) => string;
  qualityChanged: (label: string) => string;
  audioChanged: (label: string) => string;
  seekedTo: (time: string) => string;
  skipAvailable: (label: string) => string;
  errorTitle: string;
  errorMessages: Record<
    "network" | "forbidden" | "not_found" | "media" | "unsupported" | "unknown" | "offline",
    string
  >;
  tryAgain: string;
  errorCode: (code: string) => string;
  tapToPlay: string;
}

export const DEFAULT_LABELS: PlayerLabels = {
  player: "Video player",
  play: "Play",
  pause: "Pause",
  replay: "Replay",
  back: "Back",
  seekBack: (s) => `Back ${s} seconds`,
  seekForward: (s) => `Forward ${s} seconds`,
  mute: "Mute",
  unmute: "Unmute",
  volume: "Volume",
  seekSlider: "Seek",
  timeOf: (current, total) => `${current} of ${total}`,
  remaining: (time) => `${time} remaining`,
  fullscreen: "Full screen",
  exitFullscreen: "Exit full screen",
  pip: "Picture in picture",
  exitPip: "Exit picture in picture",
  pipActive: "Playing in picture in picture",
  audioAndSubtitles: "Audio & Subtitles",
  audio: "Audio",
  subtitles: "Subtitles",
  subtitlesOff: "Off",
  subtitlesOn: (label) => `Subtitles: ${label}`,
  speed: "Playback speed",
  speedNormal: "1× (Normal)",
  quality: "Quality",
  qualityAuto: "Auto",
  qualityAutoCurrent: (label) => `Auto (${label})`,
  qualityTitleLimit: (label) => `Best available for this title: ${label}`,
  episodes: "Episodes",
  season: "Season",
  seasonOption: (n, name) => (name ? name : `Season ${n}`),
  nowPlaying: "Now playing",
  episodesLoading: "Loading episodes",
  episodesError: "Episodes couldn't be loaded.",
  retry: "Retry",
  nextEpisode: "Next Episode",
  nextEpisodeIn: (s) => `Next episode in ${s}`,
  playNextEpisode: "Play Next Episode",
  watchCredits: "Watch Credits",
  skipIntro: "Skip Intro",
  skipRecap: "Skip Recap",
  close: "Close",
  youAreWatching: "You're watching",
  episodeLabel: (season, episode) => `S${season}:E${episode}`,
  maturityRated: (rating) => `Rated ${rating}`,
  buffering: "Loading",
  playing: "Playing",
  paused: "Paused",
  ended: "Finished",
  volumeLevel: (percent) => `Volume ${percent}%`,
  muted: "Muted",
  speedChanged: (label) => `Speed ${label}`,
  qualityChanged: (label) => `Quality ${label}`,
  audioChanged: (label) => `Audio: ${label}`,
  seekedTo: (time) => `${time}`,
  skipAvailable: (label) => `${label} available. Press S.`,
  errorTitle: "Playback stopped",
  errorMessages: {
    network: "We're having trouble reaching Webflix. Check your connection and try again.",
    forbidden: "This playback session has expired.",
    not_found: "This video isn't available right now.",
    media: "This video couldn't be played on this device.",
    unsupported: "This browser can't play this video.",
    unknown: "Something went wrong while playing this video.",
    offline: "You're offline. Playback resumes when your connection is back.",
  },
  tryAgain: "Try Again",
  errorCode: (code) => `Error code: ${code}`,
  tapToPlay: "Play",
};

export function resolveLabels(overrides: Partial<PlayerLabels> | undefined): PlayerLabels {
  if (!overrides) return DEFAULT_LABELS;
  return {
    ...DEFAULT_LABELS,
    ...overrides,
    errorMessages: { ...DEFAULT_LABELS.errorMessages, ...overrides.errorMessages },
  };
}
