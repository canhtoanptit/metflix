import { cx, type IconComponent, Spinner } from "@webflix/ui";
import { type ReactNode, useEffect, useRef } from "react";

const TONES = {
  neutral: "bg-surface-2 text-fg-muted",
  positive: "bg-positive-subtle text-positive",
  danger: "bg-danger-subtle text-danger",
  accent: "bg-accent-subtle text-accent",
} as const;

/**
 * One state of a payment that is being confirmed (or has been): an icon or a spinner, a heading
 * that takes focus when the state changes (so screen readers hear the new situation and keyboard
 * users start on it), plain copy, and the way forward.
 */
export function StatusPanel({
  stateKey,
  icon: Icon,
  busy = false,
  tone = "neutral",
  title,
  children,
  actions,
  footer,
  headingLevel = 1,
}: {
  /** Changes when the state changes: the heading is focused again. */
  stateKey: string;
  icon?: IconComponent;
  /** Waiting on the server: a spinner instead of the icon. */
  busy?: boolean;
  tone?: keyof typeof TONES;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [stateKey]);
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      aria-labelledby={`status-${stateKey}`}
      className="flex flex-col items-center gap-5 rounded-xl border border-line-subtle bg-surface-1 px-5 py-10 text-center sm:px-8 sm:py-12"
      data-state={stateKey}
    >
      <span className={cx("grid size-16 place-items-center rounded-full", TONES[tone])}>
        {busy ? <Spinner size="lg" label={null} /> : Icon ? <Icon size="xl" /> : null}
      </span>
      <Heading
        ref={heading}
        id={`status-${stateKey}`}
        tabIndex={-1}
        className="type-card-headline text-fg outline-none"
      >
        {title}
      </Heading>
      {children ? (
        <div className="flex max-w-prose flex-col gap-3 type-body-lg text-fg-muted">{children}</div>
      ) : null}
      {actions ? (
        // Stacked, the way forward first: the panel is often narrow (the sign-up column).
        <div className="mt-2 flex w-full max-w-form flex-col gap-3">{actions}</div>
      ) : null}
      {footer ? (
        <div className="w-full max-w-prose type-body-sm text-fg-subtle">{footer}</div>
      ) : null}
    </section>
  );
}
