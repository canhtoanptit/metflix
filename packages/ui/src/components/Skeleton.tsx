import type { CSSProperties } from "react";
import { cx } from "../lib/cx.ts";

const RADII = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  card: "rounded-card",
  full: "rounded-full",
} as const;

export interface SkeletonProps {
  className?: string;
  radius?: keyof typeof RADII;
  /** Reserve space from an aspect ratio (width / height) instead of a fixed height. */
  aspectRatio?: number;
  style?: CSSProperties;
}

/**
 * Placeholder block with a soft shimmer (static under reduced motion). Size it exactly like the
 * content it stands in for, so nothing moves when the content arrives.
 */
export function Skeleton({ className, radius = "md", aspectRatio, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cx("wf-skeleton block", RADII[radius], className)}
      style={aspectRatio ? { aspectRatio, ...style } : style}
    />
  );
}

export interface SkeletonTextProps {
  lines?: number;
  className?: string;
}

/** Lines of text-height skeletons; the last line is shorter, like a real paragraph. */
export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <span aria-hidden className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          radius="sm"
          className={cx("h-[0.9em]", index === lines - 1 && lines > 1 ? "w-3/5" : "w-full")}
        />
      ))}
    </span>
  );
}
