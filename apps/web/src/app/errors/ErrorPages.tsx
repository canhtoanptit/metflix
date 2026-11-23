import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { ApiError } from "@webflix/contracts";
import { Button, ErrorState, Gutter, Wordmark } from "@webflix/ui";
import { Component, type ErrorInfo, type ReactNode, useEffect } from "react";
import { useDocumentTitle } from "../head/DocumentTitle.tsx";
import { describeError, isUnreachable } from "../query/errors.ts";

/** Minimal chrome for full-page states (no session-dependent navigation). */
export function StatusPageLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <Gutter as="header" className="flex h-nav items-center">
        <a href="/" className="focus-ring rounded-sm" aria-label="Webflix home">
          <Wordmark className="h-5 sm:h-6" title="Webflix" />
        </a>
      </Gutter>
      <main id="main" className="flex flex-1 items-center justify-center pb-nav">
        {children}
      </main>
    </div>
  );
}

/** Default route error boundary: plain-language message, retry, and a way home. */
export function RouteErrorPage({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const queryReset = useQueryErrorResetBoundary();
  const described = describeError(error);
  const unreachable = isUnreachable(error);
  useDocumentTitle(described.title);

  useEffect(() => {
    if (!ApiError.is(error)) console.error(error);
  }, [error]);

  return (
    <StatusPageLayout>
      <ErrorState
        layout="inline"
        headingLevel={2}
        title={described.title}
        description={
          unreachable && import.meta.env.DEV && !__WEBFLIX_MOCK__
            ? `${described.description} No API is answering on this origin: start one (pnpm dev) or run the web app in mock mode (pnpm --filter @webflix/web dev:mock).`
            : described.description
        }
        reference={described.reference}
        action={
          <>
            <Button
              variant="accent"
              onClick={() => {
                queryReset.reset();
                reset();
                void router.invalidate();
              }}
            >
              Try again
            </Button>
            <Button variant="outline" asChild>
              <a href="/">Go to home</a>
            </Button>
          </>
        }
      />
    </StatusPageLayout>
  );
}

/** Unknown URL. */
export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <StatusPageLayout>
      <div className="flex max-w-prose flex-col items-center gap-4 px-gutter text-center">
        <p className="type-overline text-accent">Error 404</p>
        <h1 className="type-display-md text-fg">Lost your way?</h1>
        <p className="type-body-lg text-fg-muted">
          Sorry, we can't find that page. You'll find lots to explore on the home page.
        </p>
        <Button variant="accent" size="lg" className="mt-4" asChild>
          <Link to="/">Webflix home</Link>
        </Button>
      </div>
    </StatusPageLayout>
  );
}

interface SectionErrorBoundaryProps {
  children: ReactNode;
  /** Render a compact fallback; `retry` resets the boundary (and failed queries). */
  fallback: (props: { error: unknown; retry: () => void }) => ReactNode;
  onReset?: () => void;
}

interface SectionErrorBoundaryState {
  error: unknown;
}

/**
 * Contain a failure to one section (a row, the episode list) instead of the whole page. Pair
 * with `QueryErrorResetBoundary` or pass `onReset` to refetch.
 */
export class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  SectionErrorBoundaryState
> {
  override state: SectionErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SectionErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    if (!ApiError.is(error)) console.error(error, info.componentStack);
  }

  retry = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error !== null) {
      return this.props.fallback({ error: this.state.error, retry: this.retry });
    }
    return this.props.children;
  }
}
