/** Loading, failure, "no permission" and "nothing here" for every screen. */

import { Link } from "@tanstack/react-router";
import type { StaffRole } from "@webflix/contracts";
import {
  AlertTriangleIcon,
  Button,
  EmptyState,
  ErrorReference,
  LockIcon,
  RefreshIcon,
  Skeleton,
  WifiOffIcon,
} from "@webflix/ui";
import type { ReactNode } from "react";
import { ROLE_LABELS } from "../access/roles.ts";
import { describeError, isUnreachable } from "../api/errors.ts";

/** Skeleton rows with the final layout's rhythm (no layout shift when data lands). */
export function LoadingRows({ rows = 4, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function LoadingPage({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-4">
      <Skeleton className="h-8 w-64 max-w-full" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

/** A read that failed: what happened, and "Try again" when trying again can help. */
export function ErrorPanel({
  error,
  onRetry,
  layout = "inline",
  title,
}: {
  error: unknown;
  onRetry?: () => void;
  layout?: "inline" | "page";
  title?: string;
}) {
  const description = describeError(error);
  const unreachable = isUnreachable(error);
  return (
    <EmptyState
      layout={layout}
      icon={unreachable ? WifiOffIcon : AlertTriangleIcon}
      title={title ?? description.title}
      description={description.description}
      action={
        onRetry && description.retryable ? (
          <Button variant="outline" size="sm" icon={RefreshIcon} onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
      footer={
        description.reference ? (
          <ErrorReference reference={description.reference} className="mt-2" />
        ) : undefined
      }
    />
  );
}

/** A screen the staff member's roles do not open (also when a link to it is pasted). */
export function NoPermission({
  role,
  what,
  roles,
}: {
  role: StaffRole;
  what: string;
  roles: readonly StaffRole[];
}) {
  return (
    <EmptyState
      layout="page"
      icon={LockIcon}
      title={`You don't have access to ${what}`}
      description={`${what.charAt(0).toUpperCase()}${what.slice(1)} needs the ${ROLE_LABELS[role]} role. ${
        roles.length > 0
          ? `Your roles: ${roles.map((value) => ROLE_LABELS[value]).join(", ")}.`
          : "Your account has no staff role."
      } Ask an admin if you need it.`}
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/">Go to the overview</Link>
        </Button>
      }
    />
  );
}

/** Nothing here (inside a section): quiet, small, with the way forward when there is one. */
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-line-subtle px-4 py-6 text-center">
      <h3 className="type-label text-fg">{title}</h3>
      {description ? <p className="type-body-sm max-w-prose text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
