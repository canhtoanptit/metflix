import { Separator as RadixSeparator } from "radix-ui";
import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { useInView } from "../lib/hooks.ts";

type GapToken = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;
const GAP: Record<GapToken, string> = {
  0: "gap-0",
  1: "gap-1",
  2: "gap-2",
  3: "gap-3",
  4: "gap-4",
  5: "gap-5",
  6: "gap-6",
  8: "gap-8",
  10: "gap-10",
  12: "gap-12",
  16: "gap-16",
};

interface BoxProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
}

/** Horizontal page gutter shared by the nav, billboard and rows (`px-gutter`). */
export function Gutter({ as: Tag = "div", className, ...rest }: BoxProps) {
  return <Tag className={cx("px-gutter", className)} {...rest} />;
}

/** Centred column with the gutter and a maximum width (account, settings, legal pages). */
export function PageContainer({
  as: Tag = "div",
  width = "page",
  className,
  ...rest
}: BoxProps & { width?: "page" | "prose" | "form" }) {
  const max = width === "page" ? "max-w-page" : width === "prose" ? "max-w-prose" : "max-w-form";
  return <Tag className={cx("mx-auto w-full px-gutter", max, className)} {...rest} />;
}

export interface StackProps extends BoxProps {
  gap?: GapToken;
  align?: "start" | "center" | "end" | "stretch";
}

/** Vertical rhythm with a spacing token. */
export function Stack({
  as: Tag = "div",
  gap = 4,
  align = "stretch",
  className,
  ...rest
}: StackProps) {
  return (
    <Tag
      className={cx(
        "flex flex-col",
        GAP[gap],
        align === "start" && "items-start",
        align === "center" && "items-center",
        align === "end" && "items-end",
        className,
      )}
      {...rest}
    />
  );
}

export interface ClusterProps extends BoxProps {
  gap?: GapToken;
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
}

/** Horizontal group that wraps (button rows, metadata lines). */
export function Cluster({
  as: Tag = "div",
  gap = 3,
  justify = "start",
  wrap = true,
  className,
  ...rest
}: ClusterProps) {
  return (
    <Tag
      className={cx(
        "flex items-center",
        wrap && "flex-wrap",
        GAP[gap],
        justify === "center" && "justify-center",
        justify === "end" && "justify-end",
        justify === "between" && "justify-between",
        className,
      )}
      {...rest}
    />
  );
}

/** Raised panel for settings and account sections. */
export function Surface({ as: Tag = "section", className, ...rest }: BoxProps) {
  return (
    <Tag
      className={cx("rounded-xl border border-line-subtle bg-surface-1 p-5 sm:p-6", className)}
      {...rest}
    />
  );
}

export function Separator({ className, ...rest }: { className?: string; decorative?: boolean }) {
  return (
    <RadixSeparator.Root className={cx("h-px w-full bg-line", className)} decorative {...rest} />
  );
}

/** First focusable element of the page: jumps to the main landmark. */
export function SkipLink({
  href = "#main",
  children = "Skip to content",
}: {
  href?: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={href}
      className={cx(
        "focus-ring fixed start-4 top-4 z-(--z-skip) -translate-y-24 rounded-control bg-fg px-4 py-2.5 type-label text-fg-inverse",
        "transition-transform duration-fast focus:translate-y-0",
      )}
    >
      {children}
    </a>
  );
}

export interface LazyMountProps {
  children: ReactNode;
  /** Rendered until the area nears the viewport. Must have the final size (no layout shift). */
  placeholder: ReactNode;
  /** How early to mount, as an IntersectionObserver root margin. */
  rootMargin?: string;
  className?: string;
}

/** Mount expensive content (rows below the fold) shortly before it scrolls into view. */
export function LazyMount({
  children,
  placeholder,
  rootMargin = "800px 0px",
  className,
}: LazyMountProps) {
  const [ref, inView] = useInView<HTMLDivElement>({ rootMargin });
  return (
    <div ref={ref} className={className}>
      {inView ? children : placeholder}
    </div>
  );
}
