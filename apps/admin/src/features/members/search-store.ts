/**
 * The last member search, in this tab's memory: coming back to Members shows the same results.
 * Not in the URL, because a search is usually an email address (personal data never goes in a
 * URL, which ends up in history, logs and referrers). Dropped with the session.
 */
import { useSyncExternalStore } from "react";

export interface MemberSearchState {
  /** The submitted query (trimmed); empty before the first search. */
  q: string;
  /** Cursors of the pages before the current one (the first page has none). */
  cursors: (string | null)[];
}

let state: MemberSearchState = { q: "", cursors: [null] };
const listeners = new Set<() => void>();

function set(next: MemberSearchState): void {
  state = next;
  for (const listener of listeners) listener();
}

export const memberSearch = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  search(q: string) {
    set({ q: q.trim(), cursors: [null] });
  },
  next(cursor: string) {
    set({ ...state, cursors: [...state.cursors, cursor] });
  },
  previous() {
    if (state.cursors.length > 1) set({ ...state, cursors: state.cursors.slice(0, -1) });
  },
  clear() {
    set({ q: "", cursors: [null] });
  },
};

export function useMemberSearch(): MemberSearchState {
  return useSyncExternalStore(memberSearch.subscribe, memberSearch.get, memberSearch.get);
}
