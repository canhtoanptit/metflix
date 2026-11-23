/**
 * The console's building blocks on top of `@webflix/ui`: page and section frames, key/value
 * lists, status badges, times, money and copyable identifiers. Dense and quiet: the member app's
 * tokens without its theatre.
 */
import { Badge, type BadgeTone, CheckIcon, createIcon, cx, IconButton } from "@webflix/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  formatDate,
  formatDateInSentence,
  formatDateTime,
  formatMoney,
  formatRelative,
  formatTimeSeconds,
  formatUtc,
} from "../lib/format.ts";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <div className="type-caption text-fg-subtle">{eyebrow}</div> : null}
        <h1 className="type-title-lg break-words text-fg">{title}</h1>
        {description ? (
          <p className="type-body-sm max-w-prose text-fg-muted">{description}</p>
        ) : null}
        {children}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 md:justify-end">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  id,
  headingLevel = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const generated = useId();
  // Every section is a named region (landmark navigation, and specs find it by its title).
  const headingId = id ? `${id}-title` : generated;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cx(
        "min-w-0 rounded-lg border border-line-subtle bg-surface-1 p-4 sm:p-5",
        className,
      )}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Heading id={headingId} className="type-label text-fg">
            {title}
          </Heading>
          {description ? <p className="type-caption text-fg-subtle">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface KeyValue {
  label: ReactNode;
  value: ReactNode;
}

export function KeyValueList({ items, className }: { items: KeyValue[]; className?: string }) {
  return (
    <dl
      className={cx(
        "grid grid-cols-[minmax(6.5rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2.5 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] sm:gap-x-6",
        className,
      )}
    >
      {items.map((item, index) => (
        // Labels are not unique across lists; their position in a fixed list is.
        <div key={index} className="contents">
          <dt className="type-caption pt-0.5 text-fg-subtle">{item.label}</dt>
          <dd className="type-body-sm min-w-0 wrap-anywhere text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <Badge tone={tone} size="sm">
      {children}
    </Badge>
  );
}

export function DateTime({
  value,
  relativeTo,
  seconds,
  fallback = "—",
}: {
  value: string | null | undefined;
  /** Also say how far from now ("in 48 s"). */
  relativeTo?: number;
  seconds?: boolean;
  fallback?: ReactNode;
}) {
  if (!value) return <span className="text-fg-subtle">{fallback}</span>;
  return (
    <time dateTime={value} title={formatUtc(value)} className="tabular-nums">
      {formatDateTime(value, { seconds: seconds ?? false })}
      {relativeTo !== undefined ? (
        <span className="text-fg-subtle"> ({formatRelative(value, relativeTo)})</span>
      ) : null}
    </time>
  );
}

/**
 * A day, without the time of day: when a membership renews or ends, when an account was opened.
 * "Dec 30, 2026" in a list or table; `inSentence`, "December 30, 2026" (docs/DESIGN_SYSTEM.md
 * "Dates and amounts"). The exact instant stays on hover, in UTC, like every other time here.
 */
export function DateOnly({
  value,
  inSentence = false,
  fallback = "—",
}: {
  value: string | null | undefined;
  inSentence?: boolean;
  fallback?: ReactNode;
}) {
  if (!value) return <span className="text-fg-subtle">{fallback}</span>;
  return (
    <time dateTime={value} title={formatUtc(value)} className="tabular-nums">
      {inSentence ? formatDateInSentence(value) : formatDate(value)}
    </time>
  );
}

/**
 * A log's timestamp: the date, then the time with seconds, side by side where there is room and
 * on two lines in a narrow column (a phone's table), never broken mid-date.
 */
export function Stamp({ value }: { value: string }) {
  return (
    <time
      dateTime={value}
      title={formatUtc(value)}
      className="inline-flex flex-col tabular-nums sm:flex-row sm:gap-1"
    >
      <span className="whitespace-nowrap">{formatDate(value)},</span>
      <span className="whitespace-nowrap">{formatTimeSeconds(value)}</span>
    </time>
  );
}

export function Money({ amount }: { amount: { amountMinor: number; currency: string } }) {
  return <span className="tabular-nums">{formatMoney(amount)}</span>;
}

/** An identifier in a monospace face, selectable, with a copy button. */
export function Identifier({
  value,
  label,
  truncate = false,
}: {
  value: string;
  /** What it is, for the copy button's name ("account ID"). */
  label: string;
  truncate?: boolean;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 align-middle">
      <code
        className={cx(
          "rounded-xs bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-fg-muted select-all",
          truncate && "max-w-40 truncate",
        )}
        title={truncate ? value : undefined}
      >
        {value}
      </code>
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <IconButton
      size="sm"
      variant="ghost"
      label={copied ? "Copied" : label}
      icon={copied ? CheckIcon : CopyIcon}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
    />
  );
}

/** Two overlapping sheets (the design system has no copy icon yet). */
const CopyIcon = /* @__PURE__ */ createIcon(
  "Copy",
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </>,
);

/** Text for screen readers only. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}

/** A small "yes / no" with an icon-free word, for dense lists. */
export function YesNo({
  value,
  yes = "Yes",
  no = "No",
}: {
  value: boolean;
  yes?: string;
  no?: string;
}) {
  return <span className={value ? "text-fg" : "text-fg-subtle"}>{value ? yes : no}</span>;
}
