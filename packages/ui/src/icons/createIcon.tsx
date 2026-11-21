import type { ReactNode, SVGProps } from "react";
import { cx } from "../lib/cx.ts";

/** Token sizes: xs 14, sm 16, md 20, lg 24, xl 32 px (CSS in the components layer). */
export const ICON_SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
export type IconSize = (typeof ICON_SIZES)[number];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children" | "ref"> {
  /** Token size (default `md`, 20px). `inherit` sizes the icon with `1em` (follows the text). */
  size?: IconSize | "inherit";
  /**
   * Accessible name. Omit for decorative icons (the default): they are hidden from assistive
   * technology and the surrounding control carries the label.
   */
  label?: string;
}

export type IconComponent = ((props: IconProps) => ReactNode) & { displayName: string };

/**
 * Build an icon component from 24×24 artwork. The SVG defaults to the Webflix stroke style
 * (2px, round caps and joins, `currentColor`); filled shapes set `fill="currentColor"` and
 * `stroke="none"` on their own elements. Each icon is its own export, so bundles only carry the
 * icons they use.
 */
export function createIcon(name: string, artwork: ReactNode): IconComponent {
  function Icon({ size = "md", label, className, ...rest }: IconProps) {
    return (
      // biome-ignore lint/a11y/noSvgWithoutTitle: decorative by default (aria-hidden); role="img" + aria-label when `label` is given.
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
        data-icon={name}
        data-size={size}
        className={cx("wf-icon", className)}
        {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
        {...rest}
      >
        {artwork}
      </svg>
    );
  }
  Icon.displayName = `${name}Icon`;
  return Icon;
}
