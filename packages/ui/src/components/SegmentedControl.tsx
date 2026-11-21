import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";

export interface SegmentedControlProps<V extends string> {
  value: V;
  onValueChange: (value: V) => void;
  options: ReadonlyArray<{ value: V; label: ReactNode }>;
  /** Accessible name of the group ("Show", "Sort by"). */
  "aria-label": string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * One choice among a few, applied immediately (Movies / Series filter, view switches). Not tabs:
 * nothing is shown or hidden as panels. Arrow keys move between options.
 */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  size = "sm",
  className,
  ...aria
}: SegmentedControlProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        // Radix allows deselecting; a segmented control always has a value.
        if (next) onValueChange(next as V);
      }}
      className={cx("inline-flex gap-1 rounded-full border border-line p-1", className)}
      {...aria}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className={cx(
            "focus-ring inline-flex items-center rounded-full font-semibold whitespace-nowrap text-fg-muted",
            "transition-colors duration-fast ease-standard hover:text-fg",
            "data-[state=on]:bg-fg data-[state=on]:text-fg-inverse",
            size === "sm" ? "h-7 px-3 text-xs" : "h-9 px-4 text-sm",
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
