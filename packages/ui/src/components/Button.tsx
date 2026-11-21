import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes, Ref } from "react";
import type { IconComponent, IconSize } from "../icons/createIcon.tsx";
import { cx } from "../lib/cx.ts";
import { Spinner } from "./Spinner.tsx";

export const BUTTON_VARIANTS = {
  /** Paper white, dark text: the primary action over artwork ("Play"). */
  primary: "bg-fg text-fg-inverse hover:bg-fg/80 active:bg-fg/70",
  /** Amber: brand calls to action ("Get started", "Sign in", "Continue"). */
  accent: "bg-accent text-fg-on-accent hover:bg-accent-hover active:bg-accent-active",
  /** Frosted glass over artwork ("More info"). */
  secondary: "bg-glass text-fg backdrop-blur-md hover:bg-glass-hover",
  /** Quiet bordered action ("Manage profiles", "Cancel"). */
  outline: "border border-line-strong bg-transparent text-fg hover:border-fg hover:bg-surface-3/40",
  /** Text-only until hovered (toolbars, menus). */
  ghost: "bg-transparent text-fg hover:bg-surface-3 active:bg-surface-4",
  /** Destructive confirmation. */
  danger: "bg-danger-solid text-white hover:bg-danger-solid/85 active:bg-danger-solid/75",
  /** Inline link styling with button semantics. */
  link: "bg-transparent text-fg underline-offset-4 hover:underline",
} as const;
export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

const SIZES = {
  sm: "h-8 px-3 gap-1.5 text-sm",
  md: "h-10 px-4 gap-2 text-md",
  lg: "h-12 px-6 gap-2.5 text-lg",
  xl: "h-14 px-8 gap-3 text-xl",
  /** Scales with the viewport (billboard, landing hero). */
  hero: "h-control-hero px-[1.1em] gap-[0.55em] text-control-hero",
} as const;
export type ButtonSize = keyof typeof SIZES;

const ICON_FOR_SIZE: Record<ButtonSize, IconSize | "inherit"> = {
  sm: "sm",
  md: "md",
  lg: "lg",
  xl: "lg",
  hero: "inherit",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon component rendered before the label (replaced by a spinner while loading). */
  icon?: IconComponent;
  /** Icon component rendered after the label. */
  iconAfter?: IconComponent;
  /** Busy state: shows a spinner, sets `aria-busy` and blocks clicks. */
  loading?: boolean;
  fullWidth?: boolean;
  /**
   * Render the single child element instead of a `<button>` (router links):
   * `<Button asChild><Link to="/browse">Browse</Link></Button>`.
   */
  asChild?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "primary",
  size = "md",
  icon: Icon,
  iconAfter: IconAfter,
  loading = false,
  fullWidth = false,
  asChild = false,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const iconSize = ICON_FOR_SIZE[size];
  const classes = cx(
    "focus-ring inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap",
    "rounded-control font-semibold leading-none",
    "transition-[background-color,border-color,color,box-shadow,transform] duration-fast ease-standard",
    "active:scale-98 disabled:pointer-events-none disabled:opacity-40",
    "aria-disabled:pointer-events-none aria-disabled:opacity-40",
    variant === "link" ? "h-auto px-0" : SIZES[size],
    variant === "link" && "text-[length:inherit]",
    BUTTON_VARIANTS[variant],
    fullWidth && "w-full",
    loading && "cursor-progress",
    className,
  );
  const leading = loading ? (
    <Spinner size={iconSize === "inherit" ? "inherit" : "sm"} tone="current" label={null} />
  ) : Icon ? (
    <Icon size={iconSize} />
  ) : null;
  const trailing = IconAfter && !loading ? <IconAfter size={iconSize} /> : null;

  if (asChild) {
    // Slot merges these props into the single child element (a router link); Slottable puts the
    // icons around that element's own children. No wrapper element or fragment in between.
    return (
      <Slot.Root className={classes} aria-busy={loading || undefined} {...rest}>
        {leading}
        <Slot.Slottable>{children}</Slot.Slottable>
        {trailing}
      </Slot.Root>
    );
  }

  return (
    <button
      type={type ?? "button"}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
}
