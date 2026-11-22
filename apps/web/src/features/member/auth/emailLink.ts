import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * The token of an emailed link (`/verify-email#token=…`, `/reset-password#token=…`). It is in the
 * fragment, so it never reaches a server, a log or a `Referer`. The page takes it once, keeps it
 * for this tab only (a reload still works), and removes it from the address bar and the history
 * entry, so it is not left on screen, in history or in a copied URL.
 */
export function useLinkToken(storageKey: string): string | null {
  const router = useRouter();
  const [token] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const fromFragment = new URLSearchParams(router.state.location.hash.replace(/^#/, "")).get(
      "token",
    );
    if (fromFragment !== null) {
      try {
        sessionStorage.setItem(storageKey, fromFragment);
      } catch {
        // Without storage, a reload asks for the link again: still correct.
      }
      return fromFragment;
    }
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const { hash, pathname, searchStr } = router.state.location;
    if (hash) router.history.replace(`${pathname}${searchStr}`, router.history.location.state);
    // Another link pasted into this tab changes only the fragment (no new page load): start
    // over with it, as opening it in a new tab would.
    const onHashChange = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).has("token")) window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [router]);
  return token;
}

/** Forget the token once the link has done its work (or turned out to be dead). */
export function forgetLinkToken(storageKey: string): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/** The shape every link token has (`EmailLinkToken`); anything else was cut or altered. */
export function looksLikeLinkToken(token: string | null): token is string {
  return token !== null && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}
