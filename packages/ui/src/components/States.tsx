import type { ReactNode } from "react";
import type { IconComponent } from "../icons/createIcon.tsx";
import { AlertTriangleIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";

export interface EmptyStateProps {
  icon?: IconComponent;
  title: ReactNode;
  description?: ReactNode;
  /** Primary way forward (a Button). */
  action?: ReactNode;
  /** `page` centres in the viewport area; `inline` fits a section. */
  layout?: "page" | "inline";
  /** Heading level of the title (default 2). */
  headingLevel?: 2 | 3;
  /** Small print under the actions (an error's support reference). */
  footer?: ReactNode;
  className?: string;
}

/** Nothing here yet (empty My List, no search results). Always offer a next step. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  layout = "inline",
  headingLevel = 2,
  footer,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div
      className={cx(
        "mx-auto flex max-w-prose flex-col items-center gap-3 text-center",
        layout === "page" ? "min-h-[50dvh] justify-center px-gutter py-16" : "py-12",
        className,
      )}
    >
      {Icon ? (
        <span className="mb-2 grid size-16 place-items-center rounded-full bg-surface-2 text-fg-muted">
          <Icon size="xl" />
        </span>
      ) : null}
      <Heading className="type-title-lg text-fg">{title}</Heading>
      {description ? <p className="type-body text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-3">{action}</div> : null}
      {footer}
    </div>
  );
}

export interface ErrorStateProps extends Omit<EmptyStateProps, "icon"> {
  icon?: IconComponent;
  /**
   * Support reference (the problem's `requestId`), kept behind a "Details" disclosure: useful
   * when reporting a problem, noise for everyone else.
   */
  reference?: string | null;
}

/** Something failed. Say what happened in plain words and offer retry. */
export function ErrorState({
  icon = AlertTriangleIcon,
  reference,
  footer,
  ...rest
}: ErrorStateProps) {
  return (
    <EmptyState
      icon={icon}
      footer={
        reference || footer ? (
          <>
            {footer}
            {reference ? <ErrorReference reference={reference} className="mt-2" /> : null}
          </>
        ) : undefined
      }
      {...rest}
    />
  );
}

/**
 * A support reference behind a "Details" disclosure (error states, failure screens). Collapsed
 * by default; the reference is selectable for copying into a support request.
 */
export function ErrorReference({
  reference,
  className,
}: {
  reference: string;
  className?: string;
}) {
  return (
    <details className={cx("group mx-auto type-caption text-fg-subtle", className)}>
      <summary className="focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded-xs marker:hidden hover:text-fg-muted [&::-webkit-details-marker]:hidden">
        Details
      </summary>
      <span className="mt-1 block select-all tabular-nums">Reference {reference}</span>
    </details>
  );
}
