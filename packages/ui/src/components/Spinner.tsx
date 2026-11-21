import { cx } from "../lib/cx.ts";

export interface SpinnerProps {
  /** sm 16, md 24 (default), lg 40, xl 56 px; `inherit` follows the font size (inside buttons). */
  size?: "sm" | "md" | "lg" | "xl" | "inherit";
  /**
   * Announced to screen readers (as a polite status). Pass `null` when the spinner sits inside a
   * control that already reports its busy state (`aria-busy`).
   */
  label?: string | null;
  /** `accent` (default) or `current` to inherit the text colour (inside buttons). */
  tone?: "accent" | "current";
  className?: string;
}

/** Indeterminate loading indicator. Under reduced motion it rotates slowly instead of spinning. */
export function Spinner({
  size = "md",
  label = "Loading",
  tone = "accent",
  className,
}: SpinnerProps) {
  const svg = (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      data-size={size}
      className={cx("wf-spinner animate-spin", className)}
      data-spinner=""
    >
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5"
        stroke={tone === "accent" ? "var(--color-accent)" : "currentColor"}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
  if (label === null) return svg;
  return (
    <span role="status" className="inline-flex">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}
