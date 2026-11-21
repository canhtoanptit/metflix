export type ClassValue = string | false | null | undefined | 0;

/**
 * Join class names, skipping falsy values: `cx("card", isActive && "card--active")`.
 * There is deliberately no utility-class merging: a component's `className` prop is for layout
 * (margin, width, grid placement); appearance comes from variant props.
 */
export function cx(...values: ClassValue[]): string {
  let out = "";
  for (const value of values) {
    if (value) out = out ? `${out} ${value}` : value;
  }
  return out;
}
