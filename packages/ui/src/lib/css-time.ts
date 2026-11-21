/**
 * CSS `<time>` values in milliseconds, for script that reads a motion token.
 *
 * Never `parseFloat` a time token alone: production builds minify every time token to its
 * shortest form (`450ms` ships as `.45s`, `700ms` as `.7s`), so a unit-blind reader that works
 * against the dev server reads 0.45 ms in production.
 */
export function parseCssTime(raw: string): number | null {
  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(ms|s)?\s*$/i.exec(raw);
  const number = match?.[1];
  if (!number) return null;
  const value = Number.parseFloat(number);
  const unit = match?.[2]?.toLowerCase();
  // A unitless value is only meaningful as zero.
  if (unit === undefined) return value === 0 ? 0 : null;
  return unit === "s" ? value * 1000 : value;
}

/** A time custom property (`--duration-slow`) of `element` (default: the root), in ms. */
export function readCssTime(name: string, element?: Element): number | null {
  if (typeof document === "undefined") return null;
  const target = element ?? document.documentElement;
  return parseCssTime(getComputedStyle(target).getPropertyValue(name));
}
