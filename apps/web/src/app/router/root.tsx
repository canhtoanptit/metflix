import { useQuery } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { SkipLink } from "@webflix/ui";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NotFoundPage, RouteErrorPage } from "../errors/ErrorPages.tsx";
import { DocumentTitle } from "../head/DocumentTitle.tsx";
import { queries } from "../query/queries.ts";
import { Splash } from "../Splash.tsx";
import { PrivacyShell } from "../telemetry/PrivacyShell.tsx";
import type { RouterContext } from "./context.ts";

const MockToolbar = __WEBFLIX_DEVTOOLS__
  ? lazy(() => import("../dev/MockToolbar.tsx").then((module) => ({ default: module.MockToolbar })))
  : null;

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  // The session is the input of every guard: load it once before anything renders.
  beforeLoad: ({ context }) =>
    context.queryClient.ensureQueryData(queries.session()).then(() => {}),
  component: RootLayout,
  pendingComponent: Splash,
  pendingMs: 0,
  errorComponent: RouteErrorPage,
  notFoundComponent: NotFoundPage,
});

function RootLayout() {
  return (
    <>
      <SkipLink />
      <DocumentTitle />
      <SessionWatcher />
      <RouteProgress />
      {/* Before the page: after the skip link, the consent prompt is the first stop for a keyboard. */}
      <PrivacyShell />
      <Outlet />
      {MockToolbar ? (
        <Suspense fallback={null}>
          <MockToolbar />
        </Suspense>
      ) : null}
    </>
  );
}

/**
 * Re-run the guards when the session identity changes underneath us (signed out in another tab,
 * a 401 cleared it, a background refetch found a different profile).
 */
function SessionWatcher() {
  const router = useRouter();
  const { data } = useQuery(queries.session());
  const identity = data
    ? data.authenticated
      ? `${data.account.id}:${data.activeProfile?.id ?? "-"}`
      : "anonymous"
    : null;
  const previous = useRef(identity);
  useEffect(() => {
    if (identity !== null && previous.current !== null && identity !== previous.current) {
      void router.invalidate();
    }
    previous.current = identity;
  }, [identity, router]);
  return null;
}

/** Thin amber bar while a navigation is pending for longer than a moment. */
function RouteProgress() {
  const pending = useRouterState({ select: (state) => state.status === "pending" });
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!pending) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [pending]);
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-(--z-toast) h-0.5 origin-left bg-accent transition-[opacity,transform] duration-slow ease-standard"
      style={{ opacity: visible ? 1 : 0, transform: `scaleX(${visible ? 0.7 : 0})` }}
    />
  );
}
