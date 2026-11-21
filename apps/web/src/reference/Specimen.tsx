import { cx } from "@webflix/ui";
import type { ReactNode } from "react";

export function Section({
  id,
  title,
  description,
  children,
  bleed = false,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Full-width content (sliders). */
  bleed?: boolean;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-24 border-t border-line-subtle py-14 first:border-t-0"
    >
      <div className={cx("px-gutter", !bleed && "lg:ps-0")}>
        <h2 id={`${id}-title`} className="type-headline text-fg">
          {title}
        </h2>
        {description ? (
          <p className="mt-2 max-w-prose type-body text-fg-muted">{description}</p>
        ) : null}
      </div>
      <div className={cx("mt-8 flex flex-col gap-10", !bleed && "px-gutter lg:ps-0")}>
        {children}
      </div>
    </section>
  );
}

export function Demo({
  title,
  note,
  children,
  className,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="type-label text-fg">{title}</h3>
        {note ? <p className="type-caption text-fg-subtle">{note}</p> : null}
      </div>
      <div className={cx("flex flex-wrap items-center gap-4", className)}>{children}</div>
    </div>
  );
}

export function Caption({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[0.6875rem] leading-tight text-fg-subtle">{children}</span>
  );
}

export function Labeled({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-start gap-2", className)}>
      {children}
      <Caption>{label}</Caption>
    </div>
  );
}
