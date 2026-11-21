/**
 * Search-param validators for `validateSearch`. Every route validates its own params, so
 * `useSearch()` is typed and malformed URLs degrade to defaults instead of crashing. Wrap the
 * result in `optionalSearch` so absent params stay optional for links:
 *
 *   validateSearch: (search) => optionalSearch({ q: searchParam.string(search.q) })
 */

export type OptionalSearch<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Type every key as optional, so links need not pass absent params. Rejected values stay as
 * explicit `undefined`: the router merges a route's validated search over the raw URL params, so
 * a dropped key would let the raw (invalid, possibly hostile) value through.
 */
export function optionalSearch<T extends Record<string, unknown>>(values: T): OptionalSearch<T> {
  return values as OptionalSearch<T>;
}
export const searchParam = {
  string(value: unknown): string | undefined {
    if (typeof value === "number") return String(value);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  },
  int(value: unknown): number | undefined {
    const number = typeof value === "string" ? Number(value) : value;
    return typeof number === "number" && Number.isInteger(number) ? number : undefined;
  },
  oneOf<const T extends string>(values: readonly T[], value: unknown): T | undefined {
    return typeof value === "string" && (values as readonly string[]).includes(value)
      ? (value as T)
      : undefined;
  },
  /** A same-origin path to return to after sign-in; anything else is dropped (no open redirect). */
  redirect(value: unknown): string | undefined {
    return typeof value === "string" && isSafeRedirect(value) ? value : undefined;
  },
};

export function isSafeRedirect(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
