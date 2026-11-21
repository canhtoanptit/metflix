import { Progress } from "radix-ui";
import { cx } from "../lib/cx.ts";

const SIZES = { xs: "h-0.5", sm: "h-0.75", md: "h-1", lg: "h-1.5" } as const;

export interface ProgressBarProps {
  /** Fraction complete, 0–1 (clamped). */
  value: number;
  /** Accessible name ("Watched", "Step 2 of 4"). Omit when decorative (`aria-hidden`). */
  label?: string;
  /** Human-readable value for screen readers ("21 of 45 minutes"). */
  valueText?: string;
  size?: keyof typeof SIZES;
  /** `onImage` uses a translucent track for artwork backgrounds. */
  track?: "surface" | "onImage";
  className?: string;
}

/** Determinate progress (Continue Watching, sign-up steps). */
export function ProgressBar({
  value,
  label,
  valueText,
  size = "sm",
  track = "surface",
  className,
}: ProgressBarProps) {
  const fraction = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const percent = Math.round(fraction * 100);
  return (
    <Progress.Root
      value={percent}
      max={100}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      getValueLabel={valueText ? () => valueText : undefined}
      className={cx(
        "relative w-full overflow-hidden rounded-full",
        SIZES[size],
        track === "onImage" ? "bg-track" : "bg-surface-4",
        className,
      )}
    >
      {/* Transform, not width: progress updates never trigger layout. */}
      <Progress.Indicator
        className="size-full rounded-full bg-accent transition-transform duration-slow ease-standard"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </Progress.Root>
  );
}
