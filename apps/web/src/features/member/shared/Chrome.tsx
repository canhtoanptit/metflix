import { Link } from "@tanstack/react-router";
import { cx, Gutter, Wordmark } from "@webflix/ui";
import type { ReactNode } from "react";

/**
 * Header of the signed-out and setup screens: the wordmark (home) and one action on the right.
 * Transparent, so it sits over artwork or the canvas alike.
 */
export function MemberHeader({
  action,
  home = "/",
  className,
}: {
  action?: ReactNode;
  /** Where the wordmark leads: the landing page for guests, the app for members. */
  home?: "/" | "/browse" | "/profiles";
  className?: string;
}) {
  return (
    <Gutter
      as="header"
      className={cx("relative z-(--z-raised) flex h-nav items-center justify-between", className)}
    >
      <Link to={home} className="focus-ring -m-1 rounded-sm p-1" aria-label="Webflix home">
        <Wordmark className="h-5 sm:h-7" title="Webflix" />
      </Link>
      {action}
    </Gutter>
  );
}

/** Quiet footer for marketing and auth screens. Every link goes somewhere real. */
export function MemberFooter({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Gutter
      as="footer"
      className={cx("relative z-(--z-raised) border-t border-line-subtle py-10", className)}
    >
      <div className="flex w-full flex-col gap-6 type-body-sm text-fg-subtle [&>p]:max-w-prose">
        {children}
        <p>
          Webflix is a demonstration streaming service. Payments are simulated and no card is ever
          charged. Films are freely licensed open movies and original fiction.
        </p>
        <p>© {new Date().getFullYear()} Webflix</p>
      </div>
    </Gutter>
  );
}
