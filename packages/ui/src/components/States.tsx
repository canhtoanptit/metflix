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
    </div>
  );
}

export interface ErrorStateProps extends Omit<EmptyStateProps, "icon"> {
  icon?: IconComponent;
  /** Support reference shown small under the message (the problem's `requestId`). */
  reference?: string | null;
}

/** Something failed. Say what happened in plain words and offer retry. */
export function ErrorState({
  icon = AlertTriangleIcon,
  reference,
  description,
  ...rest
}: ErrorStateProps) {
  return (
    <EmptyState
      icon={icon}
      description={
        description || reference ? (
          <>
            {description}
            {reference ? (
              <span className="mt-2 block type-caption text-fg-subtle">Reference: {reference}</span>
            ) : null}
          </>
        ) : undefined
      }
      {...rest}
    />
  );
}
