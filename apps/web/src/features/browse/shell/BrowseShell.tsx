import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import type { SessionState } from "@webflix/contracts";
import { toast, useMediaQuery } from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { useTitleOverlay } from "../../../app/overlay/titleOverlay.ts";
import { qk } from "../../../app/query/keys.ts";
import { preloadable, useModule } from "../common/modules.ts";
import { takeTitleOpen, track } from "../common/telemetry.ts";
import { previewModule } from "../preview/prepare.ts";
import { previewStore, usePreviewRequest } from "../preview/store.ts";
import { Footer } from "./Footer.tsx";
import { MobileTabBar } from "./MobileTabBar.tsx";
import { browseMenuModule, profileMenuModule } from "./menus.tsx";
import { notificationsModule } from "./NotificationsBell.tsx";
import { PHONE_QUERY, TopNav } from "./TopNav.tsx";

const overlayModule = preloadable(() => import("../title/TitleDetailOverlay.tsx"));

/**
 * The signed-in shell: top navigation, the page, footer, the phone tab bar, and the two layers
 * every page shares — the hover preview (portal, one at a time) and the `?title=` detail
 * overlay (kept mounted while it animates out, whichever way it was closed).
 */
export function BrowseShell() {
  const phone = useMediaQuery(PHONE_QUERY);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Leaving a page (or opening the player) takes any preview with it.
  useEffect(() => {
    void pathname;
    previewStore.close();
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => previewStore.noteScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The code-split layers are needed within moments of the first hover or click: load them
  // once the page is idle, so none ever waits on the network (or on Suspense).
  useEffect(() => {
    const idle =
      window.requestIdleCallback ?? ((callback: () => void) => setTimeout(callback, 1500));
    const handle = idle(() => {
      for (const module of [
        previewModule,
        overlayModule,
        profileMenuModule,
        notificationsModule,
        browseMenuModule,
      ]) {
        void module.load().catch(() => {});
      }
    });
    return () => {
      if (window.cancelIdleCallback && typeof handle === "number")
        window.cancelIdleCallback(handle);
    };
  }, []);

  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas max-sm:pb-[calc(var(--spacing)*14+env(safe-area-inset-bottom))]">
      <TopNav />
      <div className="flex-1">
        <Outlet />
      </div>
      <Footer />
      {phone ? <MobileTabBar /> : null}
      <PreviewLayer />
      <TitleOverlayHost />
      <SessionNotice />
    </div>
  );
}

function PreviewLayer() {
  const request = usePreviewRequest();
  const module = useModule(previewModule);
  useEffect(() => {
    if (request) void previewModule.load().catch(() => {});
  }, [request]);
  return module ? <module.HoverPreview /> : null;
}

interface ShownOverlay {
  id: string;
  closing: boolean;
}

/**
 * Reports `title.open` each time the overlay comes to show a title the member opened: from a card,
 * a preview, the billboard or a result (with that card's place, noted on the way:
 * `noteTitleOpen`), or a shared link the page was loaded with. Going Back or Forward to an
 * overlay is not an open.
 */
function useTitleOpenReports(titleId: string | undefined) {
  const router = useRouter();
  const traversed = useRef(false);
  const reported = useRef<string | null>(null);
  useEffect(
    () =>
      router.history.subscribe(({ action }) => {
        traversed.current =
          action.type === "BACK" || action.type === "FORWARD" || action.type === "GO";
      }),
    [router],
  );
  useEffect(() => {
    // Effects run twice for one change in development (StrictMode): one open, one report.
    if (titleId === reported.current) return;
    reported.current = titleId ?? null;
    if (!titleId) return;
    const context = takeTitleOpen(titleId);
    if (traversed.current && !context) return;
    track(
      "title.open",
      { titleId },
      context ?? { surface: surfaceOf(router.state.location.pathname) },
    );
  }, [titleId, router]);
}

/** The surface a page reports as, for an open that did not come from a card on it. */
function surfaceOf(pathname: string) {
  if (pathname === "/browse") return "home" as const;
  if (pathname === "/browse/series") return "series" as const;
  if (pathname === "/browse/movies") return "movies" as const;
  if (pathname === "/browse/new-popular") return "new-popular" as const;
  if (pathname.startsWith("/browse/genre/")) return "genre" as const;
  if (pathname === "/search") return "search" as const;
  if (pathname === "/my-list") return "my-list" as const;
  return null;
}

function TitleOverlayHost() {
  const { titleId } = useTitleOverlay();
  const [shown, setShown] = useState<ShownOverlay | null>(
    titleId ? { id: titleId, closing: false } : null,
  );
  useTitleOpenReports(titleId);

  useEffect(() => {
    if (titleId) {
      previewStore.close();
      setShown({ id: titleId, closing: false });
    } else {
      setShown((current) => (current ? { ...current, closing: true } : null));
    }
  }, [titleId]);

  const module = useModule(overlayModule);
  useEffect(() => {
    if (shown) void overlayModule.load().catch(() => {});
    // Closed before its code arrived: nothing to animate out.
    if (shown?.closing && !overlayModule.get()) setShown(null);
  }, [shown]);

  if (!shown || !module) return null;
  return (
    <module.TitleDetailOverlay
      titleId={shown.id}
      closing={shown.closing}
      onExited={() => setShown((current) => (current?.closing ? null : current))}
    />
  );
}

/**
 * The session can end underneath the page (signed out elsewhere, expired, profile removed).
 * The guards redirect; this says why, once, instead of leaving people wondering.
 */
function SessionNotice() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let before = queryClient.getQueryData<SessionState>(qk.session());
    // Synchronous cache events: the guards unmount this shell right after the change, before
    // a re-render could react to it.
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== JSON.stringify(qk.session())) {
        return;
      }
      const next = event.query.state.data as SessionState | undefined;
      const previous = before;
      before = next;
      if (!previous?.authenticated || !next) return;
      if (!next.authenticated) {
        toast.show({
          id: "session-ended",
          title: "You've been signed out",
          description: "Your session ended. Sign in again to pick up where you left off.",
        });
      } else if (previous.activeProfile && !next.activeProfile) {
        toast.show({
          id: "session-ended",
          title: "Choose a profile to continue",
          description: "This profile is no longer available on this device.",
        });
      }
    });
  }, [queryClient]);
  return null;
}
