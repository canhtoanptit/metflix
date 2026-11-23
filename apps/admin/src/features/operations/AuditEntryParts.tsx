/**
 * An audit entry's headline and target, as the audit log, your actions and the overview show
 * them: "Refunded $4.00" over "Member · jane@example.test". A member the console can open is a
 * link by account id (the URL carries the id, never the address).
 */
import { Link } from "@tanstack/react-router";
import type { AuditLogEntry } from "@webflix/contracts";
import { EyeIcon } from "@webflix/ui";
import { Fragment, type ReactNode } from "react";
import { auditError, auditHeadline, auditTarget } from "./audit-words.ts";

/**
 * Text that may break only after the given characters (an address after "@" and ".", a code
 * after "_"), never mid-word, so a narrow column wraps "jane.doe@" / "example.com".
 */
function softBreaks(text: string, after: RegExp): ReactNode {
  const parts = text.split(after);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

export function EntryWhat({
  entry,
  linkMembers,
}: {
  entry: AuditLogEntry;
  /** The staff member may open members (support or admin). */
  linkMembers: boolean;
}) {
  const target = auditTarget(entry);
  const read = entry.kind === "read";
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span
        className={
          read
            ? "inline-flex items-center gap-1.5 text-fg-muted"
            : "font-semibold break-words text-fg"
        }
      >
        {read ? (
          <>
            <EyeIcon size="xs" className="shrink-0" />
            <span className="sr-only">View: </span>
          </>
        ) : null}
        {auditHeadline(entry)}
      </span>
      <span className="type-caption break-words text-fg-subtle">
        {target.kind}
        {target.label ? (
          <>
            {" · "}
            {target.memberId && linkMembers ? (
              <Link
                to="/members/$accountId"
                params={{ accountId: target.memberId }}
                className="focus-ring rounded-xs text-fg-muted underline-offset-4 hover:text-fg hover:underline"
              >
                {softBreaks(target.label, /(?<=[@.])/)}
              </Link>
            ) : (
              <span className={target.erased ? "italic" : undefined}>
                {softBreaks(target.label, /(?<=[@.])/)}
              </span>
            )}
          </>
        ) : target.memberId && linkMembers ? (
          <>
            {" · "}
            <Link
              to="/members/$accountId"
              params={{ accountId: target.memberId }}
              className="focus-ring rounded-xs text-fg-muted underline-offset-4 hover:text-fg hover:underline"
            >
              Open
            </Link>
          </>
        ) : null}
      </span>
    </span>
  );
}

/** A failed or unknown action's error, in words with its code. */
export function EntryError({ entry }: { entry: AuditLogEntry }) {
  const error = auditError(entry);
  if (!error) return null;
  return (
    <span className="type-caption break-words text-fg-subtle">
      {error.title}
      {error.title !== error.code ? (
        <>
          {" "}
          <code className="font-mono text-xs">({softBreaks(error.code, /(?<=_)/)})</code>
        </>
      ) : null}
    </span>
  );
}
