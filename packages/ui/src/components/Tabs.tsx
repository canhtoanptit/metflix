import { Tabs as RadixTabs } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "../lib/cx.ts";

export const Tabs = RadixTabs.Root;

export interface TabsListProps extends ComponentProps<typeof RadixTabs.List> {
  /** `underline` (section switchers) or `pill` (compact filters). */
  variant?: "underline" | "pill";
}

export function TabsList({ variant = "underline", className, ...rest }: TabsListProps) {
  return (
    <RadixTabs.List
      data-variant={variant}
      className={cx(
        "group/tabs flex",
        variant === "underline" ? "gap-6 border-b border-line" : "gap-2",
        className,
      )}
      {...rest}
    />
  );
}

export function TabsTrigger({ className, ...rest }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cx(
        "focus-ring relative inline-flex items-center gap-2 whitespace-nowrap type-label text-fg-subtle",
        "transition-colors duration-fast ease-standard hover:text-fg data-[state=active]:text-fg",
        // underline
        "group-data-[variant=underline]/tabs:h-11 group-data-[variant=underline]/tabs:after:absolute",
        "group-data-[variant=underline]/tabs:after:inset-x-0 group-data-[variant=underline]/tabs:after:-bottom-px",
        "group-data-[variant=underline]/tabs:after:h-0.5 group-data-[variant=underline]/tabs:after:scale-x-0",
        "group-data-[variant=underline]/tabs:after:bg-accent group-data-[variant=underline]/tabs:after:transition-transform",
        "group-data-[variant=underline]/tabs:after:duration-base group-data-[variant=underline]/tabs:data-[state=active]:after:scale-x-100",
        // pill
        "group-data-[variant=pill]/tabs:h-9 group-data-[variant=pill]/tabs:rounded-full group-data-[variant=pill]/tabs:border",
        "group-data-[variant=pill]/tabs:border-line-strong group-data-[variant=pill]/tabs:px-4",
        "group-data-[variant=pill]/tabs:data-[state=active]:border-fg group-data-[variant=pill]/tabs:data-[state=active]:bg-fg",
        "group-data-[variant=pill]/tabs:data-[state=active]:text-fg-inverse",
        className,
      )}
      {...rest}
    />
  );
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content
      className={cx("focus-ring rounded-sm pt-6 data-[state=active]:animate-fade-in", className)}
      {...rest}
    />
  );
}
