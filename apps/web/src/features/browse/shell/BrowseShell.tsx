import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useRouterState } from "@tanstack/react-router";
import type { SessionState } from "@webflix/contracts";
import { toast, useMediaQuery } from "@webflix/ui";
import { useEffect, useState } from "react";
import { useTitleOverlay } from "../../../app/overlay/titleOverlay.ts";
import { qk } from "../../../app/query/keys.ts";
import { preloadable, useModule } from "../common/modules.ts";
import { previewStore, usePreviewRequest } from "../preview/store.ts";
import { Footer } from "./Footer.tsx";
import { MobileTabBar } from "./MobileTabBar.tsx";
import { browseMenuModule, profileMenuModule } from "./menus.tsx";
import { notificationsModule } from "./NotificationsBell.tsx";
import { PHONE_QUERY, TopNav } from "./TopNav.tsx";

const overlayModule = preloadable(() => import("../title/TitleDetailOverlay.tsx"));
const previewModule = preloadable(() => import("../preview/HoverPreview.tsx"));

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

function TitleOverlayHost() {
  const { titleId } = useTitleOverlay();
  const [shown, setShown] = useState<ShownOverlay | null>(
    titleId ? { id: titleId, closing: false } : null,
  );

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
