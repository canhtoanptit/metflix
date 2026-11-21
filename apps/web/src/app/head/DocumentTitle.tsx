import { useMatches } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Document title of the route ("Home" → "Home · Webflix"). */
    title?: string;
  }
}

const BRAND = "Webflix";

export function formatDocumentTitle(title: string | null | undefined): string {
  return title ? `${title} · ${BRAND}` : BRAND;
}

let overrides: Array<{ id: number; title: string }> = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

/**
 * Set the document title from a component (dynamic titles: the open title's name, a search
 * query). The most recently mounted caller wins; unmounting restores the previous title.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return;
    nextId += 1;
    const id = nextId;
    overrides = [...overrides, { id, title }];
    emit();
    return () => {
      overrides = overrides.filter((entry) => entry.id !== id);
      emit();
    };
  }, [title]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mounted once at the root: route `staticData.title`, overridden by `useDocumentTitle`. */
export function DocumentTitle() {
  const routeTitle = useMatches({
    select: (matches) => matches.findLast((match) => match.staticData.title)?.staticData.title,
  });
  const override = useSyncExternalStore(
    subscribe,
    () => overrides[overrides.length - 1]?.title,
    () => undefined,
  );
  const title = formatDocumentTitle(override ?? routeTitle);
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}
