import type { Plan } from "@webflix/contracts";
import { Badge, CheckIcon, cx, Skeleton } from "@webflix/ui";
import { formatMoney } from "./format.ts";

/**
 * The content of a plan card: name, quality, price and the server's feature list. Used inside
 * a `RadioCard` (sign-up, change plan) and as a static card (landing page); the card must be
 * `relative` (the badge sits on its top edge).
 */
export function PlanSummary({
  plan,
  badge,
  className,
}: {
  plan: Plan;
  /** Overrides the "Most popular" badge (e.g. "Your plan"). */
  badge?: string | null;
  className?: string;
}) {
  const label = badge === undefined ? (plan.highlighted ? "Most popular" : null) : badge;
  return (
    <span className={cx("flex flex-col gap-4", className)}>
      {label ? (
        // Sits on the card's top edge, so every card's content lines up.
        <Badge tone="accent" size="sm" className="absolute -top-2.5 start-5 shadow-sm">
          {label}
        </Badge>
      ) : null}
      <span className="type-title pe-8 text-fg">{plan.name}</span>
      <span className="flex items-baseline gap-1">
        <span className="type-headline text-fg tabular-nums">{formatMoney(plan.monthlyPrice)}</span>
        <span className="type-body-sm text-fg-subtle">/month</span>
      </span>
      <span className="h-px w-full bg-line-subtle" aria-hidden />
      <span className="flex flex-col gap-2.5">
        {plan.features.map((feature) => (
          <span key={feature} className="flex items-start gap-2.5 type-body-sm text-fg-muted">
            <CheckIcon size="sm" className="mt-0.5 text-accent" />
            <span>{feature}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** Same geometry as a plan card, while plans load. */
export function PlanSummarySkeleton() {
  return (
    <span className="flex flex-col gap-4 rounded-xl border border-line-subtle bg-surface-1 p-5">
      <Skeleton className="h-6 w-28" />
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-32" />
      <span className="h-px w-full bg-line-subtle" aria-hidden />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="h-4 w-2/3" />
    </span>
  );
}
