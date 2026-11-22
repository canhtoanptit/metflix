/**
 * The player's icon set: 24×24 grid, 2.5-unit rounded strokes, solid glyphs for transport
 * (play, pause, next, the ±10 arrowheads, skip) so they carry visual weight over video.
 * Decorative: buttons carry the labels.
 */
import type { ReactNode } from "react";

function Svg({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <svg
      className={className ? `wfp-icon ${className}` : "wfp-icon"}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export type IconName =
  | "play"
  | "pause"
  | "replay"
  | "back10"
  | "forward10"
  | "volumeHigh"
  | "volumeLow"
  | "volumeOff"
  | "subtitles"
  | "speed"
  | "quality"
  | "episodes"
  | "next"
  | "pip"
  | "pipExit"
  | "fullscreen"
  | "fullscreenExit"
  | "back"
  | "check"
  | "chevronDown"
  | "close"
  | "skip"
  | "alert";

const PATHS: Record<IconName, ReactNode> = {
  play: (
    <path
      d="M7.5 5.2v13.6a1 1 0 0 0 1.53.85l10.9-6.8a1 1 0 0 0 0-1.7L9.03 4.35A1 1 0 0 0 7.5 5.2Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  replay: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4 3.5v4h4" />
    </>
  ),
  // ±10: an open circle (r 8.5 around 12,13) with a solid arrowhead at 12 o'clock, "10" centred.
  back10: (
    <>
      <path d="M12 4.5A8.5 8.5 0 1 1 4.64 8.75" />
      <path d="M14.4 1.4 10.6 4.5l3.8 3.1Z" fill="currentColor" strokeWidth={1.5} />
      <text
        x="12"
        y="16.1"
        fontSize="8.2"
        fontWeight="700"
        letterSpacing="-0.3"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="inherit"
      >
        10
      </text>
    </>
  ),
  forward10: (
    <>
      <path d="M12 4.5A8.5 8.5 0 1 0 19.36 8.75" />
      <path d="M9.6 1.4 13.4 4.5 9.6 7.6Z" fill="currentColor" strokeWidth={1.5} />
      <text
        x="12"
        y="16.1"
        fontSize="8.2"
        fontWeight="700"
        letterSpacing="-0.3"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="inherit"
      >
        10
      </text>
    </>
  ),
  volumeHigh: (
    <>
      <path d="M3.5 9.5v5h3.8l4.7 4V5.5l-4.7 4H3.5Z" fill="currentColor" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6" />
      <path d="M18.3 6.2a8.2 8.2 0 0 1 0 11.6" />
    </>
  ),
  volumeLow: (
    <>
      <path d="M3.5 9.5v5h3.8l4.7 4V5.5l-4.7 4H3.5Z" fill="currentColor" />
      <path d="M15.5 9a4.2 4.2 0 0 1 0 6" />
    </>
  ),
  volumeOff: (
    <>
      <path d="M3.5 9.5v5h3.8l4.7 4V5.5l-4.7 4H3.5Z" fill="currentColor" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  subtitles: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
      <path d="M6.5 10.5h4M14 10.5h3.5M6.5 14.5h7M17 14.5h.5" />
    </>
  ),
  speed: (
    <>
      <path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" />
      <path d="m12 13.5 4-4.5" />
      <circle cx="12" cy="14" r="1.4" fill="currentColor" />
      <path d="M12 5v1.4M5.6 8 6.7 9M18.4 8l-1.1 1" />
    </>
  ),
  // Three sliders with solid knobs; the tracks stop short of each knob.
  quality: (
    <>
      <path d="M3.5 5.5h8M18.5 5.5h2M10.5 12h10M3.5 18.5h5M15.5 18.5h5" />
      <circle cx="15" cy="5.5" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="7" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="2.4" fill="currentColor" stroke="none" />
    </>
  ),
  episodes: (
    <>
      <rect x="3" y="8" width="13" height="12" rx="1.8" />
      <path d="M7 4.5h11.2A2.3 2.3 0 0 1 20.5 6.8V16" />
    </>
  ),
  next: (
    <>
      <path
        d="M5 5.7v12.6a1 1 0 0 0 1.55.83l9.15-6.3a1 1 0 0 0 0-1.66L6.55 4.87A1 1 0 0 0 5 5.7Z"
        fill="currentColor"
        stroke="none"
      />
      <rect x="17.2" y="4.5" width="2.8" height="15" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  pip: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <rect x="12" y="11.5" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  pipExit: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="m8 9 5 5M8 13V9h4" />
    </>
  ),
  fullscreen: (
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  ),
  fullscreenExit: (
    <path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" />
  ),
  back: <path d="M19.5 12h-15M10.5 5.5 4 12l6.5 6.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  skip: (
    <>
      <path d="M4 6.8v10.4l6.2-5.2L4 6.8Z" fill="currentColor" strokeWidth={1.5} />
      <path d="M12.5 6.8v10.4l6.2-5.2-6.2-5.2Z" fill="currentColor" strokeWidth={1.5} />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <circle cx="12" cy="16.4" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <Svg className={className}>{PATHS[name]}</Svg>;
}
