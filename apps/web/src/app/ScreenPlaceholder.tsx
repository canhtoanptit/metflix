import { Badge, Wordmark } from "@webflix/ui";
import type { ReactNode } from "react";

export interface ScreenPlaceholderProps {
  /** Screen name as users know it ("Who's watching?"). */
  title: string;
  owner: "browse" | "member-watch";
  /** The file that replaces this placeholder. */
  file: string;
  /** What the finished screen must do (from blueprint §1 and §9). */
  spec: string[];
  /** Live values worth showing while the screen is a stub (route params, session facts). */
  facts?: Array<[string, ReactNode]>;
  /** Wrap in minimal chrome (screens outside the browse shell). */
  chrome?: boolean;
  children?: ReactNode;
}

/**
 * Stand-in for a screen the next wave builds. It renders inside the real route tree (guards,
 * params, titles all live) and states what the finished screen needs.
 */
export function ScreenPlaceholder({
  title,
  owner,
  file,
  spec,
  facts = [],
  chrome = false,
  children,
}: ScreenPlaceholderProps) {
  const body = (
    <section
      className="mx-auto flex w-full max-w-prose flex-col gap-5 px-gutter py-16"
      data-testid="screen-placeholder"
      data-screen={title}
    >
      <div className="flex items-center gap-3">
        <Badge tone="outline" size="sm">
          Placeholder
        </Badge>
        <Badge tone={owner === "browse" ? "accent" : "neutral"} size="sm">
          {owner === "browse" ? "Browse" : "Member + watch"}
        </Badge>
      </div>
      <h1 className="type-display-md text-fg">{title}</h1>
      <ul className="flex list-disc flex-col gap-1.5 ps-5 type-body text-fg-muted marker:text-accent">
        {spec.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {facts.length > 0 ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 rounded-lg border border-line-subtle bg-surface-1 p-4 type-body-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-fg-subtle">{label}</dt>
              <dd className="font-mono text-fg">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
      <p className="type-caption text-fg-subtle">
        Replace <code className="font-mono text-fg-muted">apps/web/src/{file}</code>
      </p>
    </section>
  );
  if (!chrome) return <main id="main">{body}</main>;
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="flex h-nav items-center px-gutter">
        <a href="/" className="focus-ring rounded-sm" aria-label="Webflix home">
          <Wordmark className="h-5 sm:h-6" />
        </a>
      </header>
      <main id="main">{body}</main>
    </div>
  );
}
