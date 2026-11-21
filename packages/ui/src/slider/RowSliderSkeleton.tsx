import type { RowLayout } from "@webflix/contracts";
import type { AnchorHTMLAttributes, ReactNode, Ref } from "react";
import { Skeleton } from "../components/Skeleton.tsx";
import { ChevronRightIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";
import { TitleTileSkeleton } from "./TitleTile.tsx";

export interface RowSliderSkeletonProps {
  layout?: RowLayout;
  /** Show a title instead of a title skeleton (the row title is known, items are loading). */
  title?: ReactNode;
  className?: string;
}

/**
 * Loading row with the slider's exact geometry (same container queries, gutter and gap), so
 * the real row replaces it without moving anything.
 */
export function RowSliderSkeleton({
  layout = "standard",
  title,
  className,
}: RowSliderSkeletonProps) {
  return (
    <div className={cx("wf-slider", className)} data-mode="paged" aria-busy="true">
      <div className="wf-slider__header">
        {title ? (
          <span className="type-row-title text-fg">{title}</span>
        ) : (
          <Skeleton radius="sm" className="h-[var(--text-row)] w-48 max-w-[40%]" />
        )}
      </div>
      <div className="wf-slider__viewport">
        <ul className="wf-slider__track" aria-hidden>
          {Array.from({ length: 7 }, (_, index) => (
            <li key={index} className="wf-slider__item">
              <TitleTileSkeleton layout={layout} />
            </li>
          ))}
        </ul>
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}

export interface RowHeaderLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode;
  ref?: Ref<HTMLAnchorElement>;
}

/**
 * "Explore all ›" next to a row title. Fades in while the row is hovered or the link is focused
 * (always visible on touch devices). Wrap with `createLink` for router links.
 */
export function RowHeaderLink({
  children = "Explore all",
  className,
  ref,
  ...rest
}: RowHeaderLinkProps) {
  return (
    <a
      ref={ref}
      className={cx(
        "focus-ring inline-flex items-center gap-1 rounded-sm text-sm font-semibold whitespace-nowrap text-accent",
        "-translate-x-1 opacity-0 transition-[opacity,transform] duration-base ease-standard",
        "focus-visible:translate-x-0 focus-visible:opacity-100",
        "[.wf-slider:hover_&]:translate-x-0 [.wf-slider:hover_&]:opacity-100",
        "[@media(hover:none)]:translate-x-0 [@media(hover:none)]:opacity-100",
        className,
      )}
      {...rest}
    >
      {children}
      <ChevronRightIcon size="sm" />
    </a>
  );
}
