import { CreditCardIcon } from "@webflix/ui";
import type { ReactNode } from "react";

/**
 * This deployment has no payment provider (`GET /billing/config` answers `none`): a membership
 * cannot be started or paid for here, so no checkout is offered that could never finish.
 */
export function NoProviderNotice({
  title = "Memberships can't be started here right now",
  children,
  action,
  headingLevel = 2,
}: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  /** 1 when the notice is the page's only content (no page heading above it). */
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      aria-labelledby="no-provider-title"
      className="flex flex-col items-center gap-4 rounded-xl border border-line-subtle bg-surface-1 px-5 py-10 text-center sm:px-8"
      data-testid="billing-no-provider"
    >
      <span className="grid size-14 place-items-center rounded-full bg-surface-2 text-fg-muted">
        <CreditCardIcon size="lg" />
      </span>
      <Heading id="no-provider-title" className="type-title-lg text-fg">
        {title}
      </Heading>
      <p className="max-w-prose type-body text-fg-muted">
        {children ??
          "Webflix can't take payments right now, so there's no way to pay for a membership. Nothing has been charged."}
      </p>
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </section>
  );
}
