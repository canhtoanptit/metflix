import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { cx } from "@webflix/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { MemberFooter, MemberHeader } from "../shared/Chrome.tsx";

export const SIGNUP_STEPS = [
  { path: "/signup", label: "Account" },
  { path: "/signup/plan", label: "Plan" },
  { path: "/signup/payment", label: "Payment" },
  { path: "/signup/profile", label: "Profiles" },
] as const;

function stepIndexOf(pathname: string): number {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  const index = SIGNUP_STEPS.findIndex((step) => step.path === normalized);
  return index === -1 ? 0 : index;
}

/**
 * Chrome of the sign-up flow: wordmark, a way out (sign in, or sign out once the account
 * exists), a segmented progress bar and a narrow content column.
 */
export function SignupLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const step = stepIndexOf(pathname);
  const accountExists = step === SIGNUP_STEPS.length - 1;

  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-glow" />
      <MemberHeader
        className="border-b border-line-subtle"
        action={
          accountExists ? (
            <Link
              to="/logout"
              className="focus-ring rounded-sm type-label text-fg-muted hover:text-fg"
            >
              Sign out
            </Link>
          ) : (
            <Link
              to="/login"
              search={{}}
              className="focus-ring rounded-sm type-label text-fg hover:underline"
            >
              Sign in
            </Link>
          )
        }
      />
      <div
        className="relative z-(--z-raised) mx-auto flex w-full max-w-form gap-1.5 px-gutter pt-6"
        aria-hidden
      >
        {SIGNUP_STEPS.map((item, index) => (
          <span
            key={item.path}
            className={cx(
              "h-1 flex-1 rounded-full transition-colors duration-slow ease-standard",
              index <= step ? "bg-accent" : "bg-surface-3",
            )}
          />
        ))}
      </div>
      <main id="main" className="relative z-(--z-raised) flex flex-1 flex-col">
        <Outlet />
      </main>
      <MemberFooter className="mt-16" />
    </div>
  );
}

/**
 * Step title: "Step 2 of 4" overline and the heading. Focused when the step appears, so screen
 * readers announce where the member is and keyboard users start at the top of the step.
 */
export function StepHeading({
  step,
  title,
  description,
  wide = false,
}: {
  step: number;
  title: ReactNode;
  description?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header className={cx("flex flex-col gap-2", wide ? "text-center" : null)}>
      <p className="type-overline text-fg-subtle">
        Step {step} of {SIGNUP_STEPS.length}
      </p>
      <h1 ref={ref} tabIndex={-1} className="type-headline text-fg outline-none">
        {title}
      </h1>
      {description ? <div className="type-body-lg text-fg-muted">{description}</div> : null}
    </header>
  );
}

/** Content column of one step. */
export function StepBody({
  children,
  wide = false,
}: {
  children: ReactNode;
  /** Plan cards need more room than a form. */
  wide?: boolean;
}) {
  return (
    <div
      className={cx(
        "mx-auto flex w-full flex-col gap-8 px-gutter pt-8 sm:pt-12",
        wide ? "max-w-page" : "max-w-form",
      )}
    >
      {children}
    </div>
  );
}
