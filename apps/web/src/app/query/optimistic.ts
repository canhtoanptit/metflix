import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * The optimistic-update pattern, in one helper:
 *
 *   onMutate: () => optimisticUpdate(queryClient, qk.profile.all(), (data) => patch(data)),
 *   onError: (_error, _vars, rollback) => rollback?.(),
 *   onSettled: () => queryClient.invalidateQueries({ queryKey: ... }),
 *
 * It cancels in-flight fetches under `prefix` (so a stale response cannot overwrite the
 * optimistic value), applies `update` to every cached entry under it, and returns a function
 * that restores the previous values exactly.
 */
export async function optimisticUpdate(
  queryClient: QueryClient,
  prefix: QueryKey,
  update: (data: unknown, key: QueryKey) => unknown,
): Promise<() => void> {
  await queryClient.cancelQueries({ queryKey: prefix });
  const snapshot = queryClient.getQueriesData({ queryKey: prefix });
  for (const [key, data] of snapshot) {
    if (data === undefined) continue;
    const next = update(data, key);
    if (next !== data) queryClient.setQueryData(key, next);
  }
  return () => {
    for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
  };
}

interface TitleLike {
  id: string;
  viewer: Record<string, unknown>;
  images: unknown;
}

function isTitleLike(value: object): value is TitleLike {
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.viewer === "object" &&
    record.viewer !== null &&
    "images" in record
  );
}

/**
 * Return `data` with `patch` merged into the `viewer` state of every title card/detail whose id
 * is `titleId`, wherever it sits (browse rows, ranked and continue items, search, My List,
 * detail). Unchanged branches keep their identity, so untouched components do not re-render.
 */
export function patchTitleViewer<T>(data: T, titleId: string, patch: Record<string, unknown>): T {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const updated = visit(item);
        if (updated !== item) changed = true;
        return updated;
      });
      return changed ? next : value;
    }
    if (typeof value !== "object" || value === null) return value;
    if (isTitleLike(value) && value.id === titleId) {
      return { ...value, viewer: { ...value.viewer, ...patch } };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const updated = visit(child);
      if (updated !== child) changed = true;
      next[key] = updated;
    }
    return changed ? next : value;
  };
  return visit(data) as T;
}
