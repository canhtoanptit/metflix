import { Fragment } from "react";
import { cx } from "../lib/cx.ts";

export interface EmailTextProps {
  children: string | null | undefined;
  /** Extra classes for layout only; the colour follows the surrounding text unless `tone`. */
  className?: string;
  /** `strong` (default): the address stands out from its sentence. `inherit`: as the text around. */
  tone?: "strong" | "inherit";
}

/**
 * An email address as someone typed it, anywhere it appears in text: in a sentence, a heading, a
 * key/value list. It may break only after "@" or "." (never at a hyphen or mid-word, unless one
 * part alone is longer than any line), and with Inter's contextual alternates off, so "3x06"
 * stays "3x06" instead of being drawn as "3×06" (UX review 3.7).
 */
export function EmailText({ children, className, tone = "strong" }: EmailTextProps) {
  if (!children) return null;
  const parts = children.split(/(?<=[@.])/);
  return (
    <span
      className={cx("wf-user-text wrap-anywhere", tone === "strong" && "text-fg", className)}
      translate="no"
    >
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {part.length <= 24 ? <span className="whitespace-nowrap">{part}</span> : part}
        </Fragment>
      ))}
    </span>
  );
}
