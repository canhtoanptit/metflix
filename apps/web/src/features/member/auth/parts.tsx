import { Fragment } from "react";

/**
 * The heading of a sign-in card (sign in, the landing, the emailed-link pages). The card is
 * narrower than a phone's screen on wide windows, so the heading keeps a phone's size there
 * instead of growing with the window and wrapping word by word (UX review 3.6).
 */
export const CARD_HEADING = "type-headline md:type-title-lg text-fg";

/**
 * An email address as the member typed it: may break only after "@" or ".", never mid-word, and
 * with Inter's contextual alternates off, so "3x06" stays "3x06" and is not drawn as "3×06"
 * (UX review 3.7).
 */
export function EmailText({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  const parts = children.split(/(?<=[@.])/);
  return (
    <span className="text-fg wrap-anywhere" style={{ fontFeatureSettings: '"calt" 0' }}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {/* Not at its hyphens either, unless a part alone is too long for any line. */}
          {part.length <= 24 ? <span className="whitespace-nowrap">{part}</span> : part}
        </Fragment>
      ))}
    </span>
  );
}
