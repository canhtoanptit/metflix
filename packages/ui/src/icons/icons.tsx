import { createIcon } from "./createIcon.tsx";

// Every icon is `/* @__PURE__ */ createIcon(...)`: the annotation lets bundlers drop icons a
// bundle does not use. Keep it on new icons.

// Transport / player
export const PlayIcon = /* @__PURE__ */ createIcon(
  "Play",
  <path
    d="M9.26 5.34L18.32 10.71A1.5 1.5 0 0 1 18.32 13.29L9.26 18.66A1.5 1.5 0 0 1 7 17.37L7 6.63A1.5 1.5 0 0 1 9.26 5.34Z"
    fill="currentColor"
    stroke="none"
  />,
);
export const PauseIcon = /* @__PURE__ */ createIcon(
  "Pause",
  <>
    <rect x="6" y="5" width="4" height="14" rx="1.5" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1.5" fill="currentColor" stroke="none" />
  </>,
);
export const NextEpisodeIcon = /* @__PURE__ */ createIcon(
  "NextEpisode",
  <>
    <path
      d="M6.29 5.93L13.96 10.73A1.5 1.5 0 0 1 13.96 13.27L6.29 18.07A1.5 1.5 0 0 1 4 16.79L4 7.21A1.5 1.5 0 0 1 6.29 5.93Z"
      fill="currentColor"
      stroke="none"
    />
    <rect x="17" y="5" width="3" height="14" rx="1.5" fill="currentColor" stroke="none" />
  </>,
);
export const Replay10Icon = /* @__PURE__ */ createIcon(
  "Replay10",
  <>
    <path d="M12 5A8 8 0 1 1 4.48 10.26" />
    <path d="M14 3l-2 2 2 2" />
    <path d="M8 11l1.5-1v6" strokeWidth={1.5} />
    <rect x="12" y="10" width="4" height="6" rx="2" strokeWidth={1.5} />
  </>,
);
export const Forward10Icon = /* @__PURE__ */ createIcon(
  "Forward10",
  <>
    <path d="M12 5A8 8 0 1 0 19.52 10.26" />
    <path d="M10 3l2 2-2 2" />
    <path d="M8 11l1.5-1v6" strokeWidth={1.5} />
    <rect x="12" y="10" width="4" height="6" rx="2" strokeWidth={1.5} />
  </>,
);
export const VolumeHighIcon = /* @__PURE__ */ createIcon(
  "VolumeHigh",
  <>
    <path d="M11 5L6.5 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.5L11 19Z" />
    <path d="M15 9a5 5 0 0 1 0 6" />
    <path d="M17.5 5.5a9.2 9.2 0 0 1 0 13" />
  </>,
);
export const VolumeLowIcon = /* @__PURE__ */ createIcon(
  "VolumeLow",
  <>
    <path d="M11 5L6.5 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.5L11 19Z" />
    <path d="M15 9a5 5 0 0 1 0 6" />
  </>,
);
export const VolumeMuteIcon = /* @__PURE__ */ createIcon(
  "VolumeMute",
  <>
    <path d="M11 5L6.5 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.5L11 19Z" />
    <path d="M15.5 9.5l5 5M20.5 9.5l-5 5" />
  </>,
);
export const FullscreenIcon = /* @__PURE__ */ createIcon(
  "Fullscreen",
  <path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3" />,
);
export const FullscreenExitIcon = /* @__PURE__ */ createIcon(
  "FullscreenExit",
  <path d="M9 4v3a2 2 0 0 1-2 2H4M15 4v3a2 2 0 0 0 2 2h3M20 15h-3a2 2 0 0 0-2 2v3M4 15h3a2 2 0 0 1 2 2v3" />,
);
export const SubtitlesIcon = /* @__PURE__ */ createIcon(
  "Subtitles",
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 11h2M12 11h5M7 15h6M16 15h1" />
  </>,
);
export const SpeedIcon = /* @__PURE__ */ createIcon(
  "Speed",
  <>
    <path d="M5.64 19.36A9 9 0 1 1 18.36 19.36" />
    <path d="M12 13l4-4" />
    <circle cx="12" cy="13" r="2" fill="currentColor" stroke="none" />
  </>,
);
export const PictureInPictureIcon = /* @__PURE__ */ createIcon(
  "PictureInPicture",
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <rect x="12" y="11" width="6" height="5" rx="1" fill="currentColor" stroke="none" />
  </>,
);
export const EpisodesIcon = /* @__PURE__ */ createIcon(
  "Episodes",
  <>
    <rect x="3" y="11" width="18" height="10" rx="2" />
    <path d="M5 7h14M7 3h10" />
  </>,
);
export const SettingsIcon = /* @__PURE__ */ createIcon(
  "Settings",
  <>
    <path d="M10.08 5.53L10.59 3.11A9 9 0 0 1 13.41 3.11L13.92 5.53A6.75 6.75 0 0 1 15.22 6.07L17.29 4.72A9 9 0 0 1 19.28 6.71L17.93 8.78A6.75 6.75 0 0 1 18.47 10.08L20.89 10.59A9 9 0 0 1 20.89 13.41L18.47 13.92A6.75 6.75 0 0 1 17.93 15.22L19.28 17.29A9 9 0 0 1 17.29 19.28L15.22 17.93A6.75 6.75 0 0 1 13.92 18.47L13.41 20.89A9 9 0 0 1 10.59 20.89L10.08 18.47A6.75 6.75 0 0 1 8.78 17.93L6.71 19.28A9 9 0 0 1 4.72 17.29L6.07 15.22A6.75 6.75 0 0 1 5.53 13.92L3.11 13.41A9 9 0 0 1 3.11 10.59L5.53 10.08A6.75 6.75 0 0 1 6.07 8.78L4.72 6.71A9 9 0 0 1 6.71 4.72L8.78 6.07A6.75 6.75 0 0 1 10.08 5.53Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

// Actions
export const PlusIcon = /* @__PURE__ */ createIcon("Plus", <path d="M12 5v14M5 12h14" />);
export const CheckIcon = /* @__PURE__ */ createIcon("Check", <path d="M5 12.5l4.5 4.5L19 7" />);
export const CloseIcon = /* @__PURE__ */ createIcon("Close", <path d="M6 6l12 12M18 6L6 18" />);
export const ThumbsUpIcon = /* @__PURE__ */ createIcon(
  "ThumbsUp",
  <>
    <path d="M7 10L10.04 5.4A2.1 2.1 0 0 1 13.89 6.46L14 9H18.33A2 2 0 0 1 20.31 11.25L19.42 18.25A2 2 0 0 1 17.44 20H7Z" />
    <rect x="3" y="10" width="4" height="10" rx="1" />
  </>,
);
export const ThumbsDownIcon = /* @__PURE__ */ createIcon(
  "ThumbsDown",
  <>
    <path d="M7 14L10.04 18.6A2.1 2.1 0 0 0 13.89 17.54L14 15H18.33A2 2 0 0 0 20.31 12.75L19.42 5.75A2 2 0 0 0 17.44 4H7Z" />
    <rect x="3" y="4" width="4" height="10" rx="1" />
  </>,
);
export const ThumbsUpDoubleIcon = /* @__PURE__ */ createIcon(
  "ThumbsUpDouble",
  <>
    <path d="M10 12L12.43 8.32A1.68 1.68 0 0 1 15.51 9.17L15.6 11.2H19.06A1.6 1.6 0 0 1 20.65 13L19.94 18.6A1.6 1.6 0 0 1 18.35 20H10Z" />
    <rect x="6.8" y="12" width="3.2" height="8" rx=".8" />
    <path d="M4 17.4A.8 .8 0 0 1 3.2 16.6V10.2A.8 .8 0 0 1 4 9.4H5.6A.8 .8 0 0 1 6.33 9.86M6.4 9.4L8.83 5.72A1.68 1.68 0 0 1 11.67 5.78" />
  </>,
);
export const InfoIcon = /* @__PURE__ */ createIcon(
  "Info",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11.5v5" />
    <circle cx="12" cy="8" r="1.25" fill="currentColor" stroke="none" />
  </>,
);
export const ShareIcon = /* @__PURE__ */ createIcon(
  "Share",
  <>
    <path d="M12 3v11M8 7l4-4 4 4" />
    <path d="M8 10H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1" />
  </>,
);
export const EditIcon = /* @__PURE__ */ createIcon(
  "Edit",
  <>
    <path d="M4 16L15.5 4.5a2.83 2.83 0 0 1 4 4L8 20H4Z" />
    <path d="M13.5 6.5l4 4" />
  </>,
);
export const TrashIcon = /* @__PURE__ */ createIcon(
  "Trash",
  <>
    <path d="M4 6h16M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 6l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
    <path d="M10 11v5M14 11v5" />
  </>,
);
export const MoreHorizontalIcon = /* @__PURE__ */ createIcon(
  "MoreHorizontal",
  <>
    <circle cx="5" cy="12" r="1.75" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.75" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.75" fill="currentColor" stroke="none" />
  </>,
);
export const RefreshIcon = /* @__PURE__ */ createIcon(
  "Refresh",
  <>
    <path d="M20.37 13.48A8.5 8.5 0 1 1 19.36 7.75" />
    <path d="M20.27 4.37L19.36 7.75L15.98 6.84" />
  </>,
);
export const ExternalLinkIcon = /* @__PURE__ */ createIcon(
  "ExternalLink",
  <>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </>,
);

// Navigation
export const ChevronLeftIcon = /* @__PURE__ */ createIcon(
  "ChevronLeft",
  <path d="M15.5 5l-7 7 7 7" />,
);
export const ChevronRightIcon = /* @__PURE__ */ createIcon(
  "ChevronRight",
  <path d="M8.5 5l7 7-7 7" />,
);
export const ChevronUpIcon = /* @__PURE__ */ createIcon("ChevronUp", <path d="M5 15.5l7-7 7 7" />);
export const ChevronDownIcon = /* @__PURE__ */ createIcon(
  "ChevronDown",
  <path d="M5 8.5l7 7 7-7" />,
);
export const ArrowLeftIcon = /* @__PURE__ */ createIcon(
  "ArrowLeft",
  <path d="M19 12H5M11 6l-6 6 6 6" />,
);
export const ArrowRightIcon = /* @__PURE__ */ createIcon(
  "ArrowRight",
  <path d="M5 12h14M13 6l6 6-6 6" />,
);
export const SearchIcon = /* @__PURE__ */ createIcon(
  "Search",
  <>
    <circle cx="10.5" cy="10.5" r="7.5" />
    <path d="M16 16l5 5" />
  </>,
);
export const BellIcon = /* @__PURE__ */ createIcon(
  "Bell",
  <>
    <path d="M6 9a6 6 0 0 1 12 0v5.5l2 2.5H4l2-2.5Z" />
    <path d="M10 21h4" />
  </>,
);
export const MenuIcon = /* @__PURE__ */ createIcon("Menu", <path d="M4 6h16M4 12h16M4 18h16" />);
export const HomeIcon = /* @__PURE__ */ createIcon(
  "Home",
  <path d="M4 10L12 3.5L20 10V19a2 2 0 0 1-2 2h-3v-6H9v6H6a2 2 0 0 1-2-2Z" />,
);
export const FilmIcon = /* @__PURE__ */ createIcon(
  "Film",
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" />
  </>,
);
export const TvIcon = /* @__PURE__ */ createIcon(
  "Tv",
  <>
    <rect x="3" y="7" width="18" height="14" rx="2" />
    <path d="M8 3l4 4 4-4" />
  </>,
);
export const SparkleIcon = /* @__PURE__ */ createIcon(
  "Sparkle",
  <>
    <path d="M10.5 6Q11 13 18 13.5Q11 14 10.5 21Q10 14 3 13.5Q10 13 10.5 6Z" />
    <path
      d="M18 3Q18.3 5.7 21 6Q18.3 6.3 18 9Q17.7 6.3 15 6Q17.7 5.7 18 3Z"
      fill="currentColor"
      stroke="none"
    />
  </>,
);
export const ListIcon = /* @__PURE__ */ createIcon(
  "List",
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.5" fill="currentColor" stroke="none" />
  </>,
);
export const GridIcon = /* @__PURE__ */ createIcon(
  "Grid",
  <>
    <rect x="3" y="3" width="7" height="7" rx="2" />
    <rect x="14" y="3" width="7" height="7" rx="2" />
    <rect x="3" y="14" width="7" height="7" rx="2" />
    <rect x="14" y="14" width="7" height="7" rx="2" />
  </>,
);

// Account / people
export const UserIcon = /* @__PURE__ */ createIcon(
  "User",
  <>
    <circle cx="12" cy="7.5" r="4" />
    <path d="M4.5 21a7.5 6 0 0 1 15 0" />
  </>,
);
export const UsersIcon = /* @__PURE__ */ createIcon(
  "Users",
  <>
    <circle cx="9" cy="7.5" r="3.5" />
    <path d="M3 20a6 5.5 0 0 1 12 0" />
    <path d="M15.48 4.55A3 3 0 0 1 15.48 10.45M16 15a5 5 0 0 1 5 5" />
  </>,
);
export const UserPlusIcon = /* @__PURE__ */ createIcon(
  "UserPlus",
  <>
    <circle cx="9" cy="7.5" r="3.5" />
    <path d="M3 20a6 5.5 0 0 1 12 0" />
    <path d="M18.5 8.5v5M16 11h5" />
  </>,
);
export const LockIcon = /* @__PURE__ */ createIcon(
  "Lock",
  <>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2" />
  </>,
);
export const UnlockIcon = /* @__PURE__ */ createIcon(
  "Unlock",
  <>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0M12 15v2" />
  </>,
);
export const KeyIcon = /* @__PURE__ */ createIcon(
  "Key",
  <>
    <circle cx="8" cy="16" r="4.5" />
    <path d="M11.2 12.8L20 4M18 6l2.5 2.5M15.5 8.5l2 2" />
  </>,
);
export const LogOutIcon = /* @__PURE__ */ createIcon(
  "LogOut",
  <>
    <path d="M10 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
    <path d="M10 12h10M16 8l4 4-4 4" />
  </>,
);
export const CreditCardIcon = /* @__PURE__ */ createIcon(
  "CreditCard",
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M7 15h3" />
  </>,
);
export const DevicesIcon = /* @__PURE__ */ createIcon(
  "Devices",
  <>
    <path d="M17 7.4V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8.4" />
    <path d="M10 15v3.5M7 18.5h6" />
    <rect x="15" y="9" width="6" height="12" rx="1.5" />
  </>,
);
export const MonitorIcon = /* @__PURE__ */ createIcon(
  "Monitor",
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M12 16v4M8 20h8" />
  </>,
);
export const SmartphoneIcon = /* @__PURE__ */ createIcon(
  "Smartphone",
  <>
    <rect x="6" y="3" width="12" height="18" rx="2" />
    <path d="M11 17h2" />
  </>,
);
export const TabletIcon = /* @__PURE__ */ createIcon(
  "Tablet",
  <>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M11 17h2" />
  </>,
);
export const GlobeIcon = /* @__PURE__ */ createIcon(
  "Globe",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3a4 9 0 0 0 0 18a4 9 0 0 0 0-18M3 12h18" />
  </>,
);
export const HelpIcon = /* @__PURE__ */ createIcon(
  "Help",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 1 1 3.4 2.33c-.55.22-.9.75-.9 1.34V13" />
    <circle cx="12" cy="16.75" r="1.25" fill="currentColor" stroke="none" />
  </>,
);
export const MailIcon = /* @__PURE__ */ createIcon(
  "Mail",
  <>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M4 7.5l8 6 8-6" />
  </>,
);
export const EyeIcon = /* @__PURE__ */ createIcon(
  "Eye",
  <>
    <path d="M3 12C5.5 7.5 8.5 5.5 12 5.5S18.5 7.5 21 12C18.5 16.5 15.5 18.5 12 18.5S5.5 16.5 3 12Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const EyeOffIcon = /* @__PURE__ */ createIcon(
  "EyeOff",
  <>
    <path d="M3 12C3.61 10.91 4.24 9.96 4.91 9.16M9.98 5.74C10.64 5.58 11.31 5.5 12 5.5M12 5.5C15.5 5.5 18.5 7.5 21 12M21 12C20.39 13.09 19.76 14.04 19.09 14.84M14.02 18.26C13.36 18.42 12.69 18.5 12 18.5M12 18.5C8.5 18.5 5.5 16.5 3 12" />
    <path d="M11.21 14.89A3 3 0 0 1 9.11 12.79M12.79 9.11A3 3 0 0 1 14.89 11.21" />
    <path d="M3 3l18 18" />
  </>,
);
export const ShieldIcon = /* @__PURE__ */ createIcon(
  "Shield",
  <path d="M12 3l7 2.5V11c0 4.6-2.9 8.3-7 10c-4.1-1.7-7-5.4-7-10V5.5Z" />,
);
export const KidsIcon = /* @__PURE__ */ createIcon(
  "Kids",
  <>
    <path d="M12 15.5c-3.2 0-5.75-3.1-5.75-6.75a5.75 5.75 0 0 1 11.5 0c0 3.65-2.55 6.75-5.75 6.75Z" />
    <path d="M12 15.5l1.25 1.75h-2.5Z" fill="currentColor" stroke="none" />
    <path d="M12 17.25c-.9 1.1-.9 2.4 0 3.5" />
    <path d="M9 8.5a3 3 0 0 1 2-2.5" />
  </>,
);
export const HistoryIcon = /* @__PURE__ */ createIcon(
  "History",
  <>
    <path d="M4.21 16.5A9 9 0 1 0 4.21 7.5" />
    <path d="M7.1 6.72L4.21 7.5L3.43 4.6" />
    <path d="M12 7.5v4.5l3 2" />
  </>,
);
export const ClockIcon = /* @__PURE__ */ createIcon(
  "Clock",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const CalendarIcon = /* @__PURE__ */ createIcon(
  "Calendar",
  <>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M8 3v4M16 3v4M3 10h18" />
  </>,
);

// Status
export const AlertCircleIcon = /* @__PURE__ */ createIcon(
  "AlertCircle",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5" />
    <circle cx="12" cy="16" r="1.25" fill="currentColor" stroke="none" />
  </>,
);
export const AlertTriangleIcon = /* @__PURE__ */ createIcon(
  "AlertTriangle",
  <>
    <path d="M13.73 5.51L19.77 16A2 2 0 0 1 18.04 19L5.96 19A2 2 0 0 1 4.23 16L10.27 5.51A2 2 0 0 1 13.73 5.51Z" />
    <path d="M12 9v3.5" />
    <circle cx="12" cy="15.75" r="1.25" fill="currentColor" stroke="none" />
  </>,
);
export const CheckCircleIcon = /* @__PURE__ */ createIcon(
  "CheckCircle",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.5 2.5L16 9.5" />
  </>,
);
export const XCircleIcon = /* @__PURE__ */ createIcon(
  "XCircle",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </>,
);
export const WifiOffIcon = /* @__PURE__ */ createIcon(
  "WifiOff",
  <>
    <path d="M8.99 15.16A4.5 4.5 0 0 1 10.35 14.31M5.98 11.81A9 9 0 0 1 7.03 11M13.61 9.65A9 9 0 0 1 18.02 11.81M2.97 8.47A13.5 13.5 0 0 1 3.8 7.77M9.25 5.28A13.5 13.5 0 0 1 21.03 8.47" />
    <circle cx="12" cy="18.5" r="1.25" fill="currentColor" stroke="none" />
    <path d="M3 3l18 18" />
  </>,
);
export const FlagIcon = /* @__PURE__ */ createIcon(
  "Flag",
  <path d="M5 21V3h14l-3.5 4.5L19 12H5" />,
);

// Misc
export const StarIcon = /* @__PURE__ */ createIcon(
  "Star",
  <path d="M12 3.6L14.41 9.59L20.84 10.03L15.89 14.16L17.47 20.42L12 16.99L6.53 20.42L8.11 14.16L3.16 10.03L9.59 9.59Z" />,
);
export const HeartIcon = /* @__PURE__ */ createIcon(
  "Heart",
  <path d="M12 20C8.5 17.5 3 14 3 8.75A4.75 4.75 0 0 1 12 6.63A4.75 4.75 0 0 1 21 8.75C21 14 15.5 17.5 12 20Z" />,
);
export const MicIcon = /* @__PURE__ */ createIcon(
  "Mic",
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </>,
);
export const FilterIcon = /* @__PURE__ */ createIcon(
  "Filter",
  <path d="M4 4h16l-6 7.5v6l-4 3v-9Z" />,
);
export const SortIcon = /* @__PURE__ */ createIcon(
  "Sort",
  <path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4" />,
);
export const DotIcon = /* @__PURE__ */ createIcon(
  "Dot",
  <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />,
);
