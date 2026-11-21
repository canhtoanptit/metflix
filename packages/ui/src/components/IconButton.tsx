import { Slot } from "radix-ui";
import type { ButtonHTMLAttributes, ReactElement, Ref } from "react";
import type { IconComponent, IconSize } from "../icons/createIcon.tsx";
import { cx } from "../lib/cx.ts";
import { Spinner } from "./Spinner.tsx";

const VARIANTS = {
  /** White disc: the primary action in compact spaces (Play on a hover preview). */
  solid: "bg-fg text-fg-inverse hover:bg-fg/80",
  /** Ringed disc: secondary actions on previews (My List, rate, expand). */
  outline:
    "border-2 border-line-strong bg-surface-2/60 text-fg hover:border-fg hover:bg-surface-3/70",
  /** Frosted disc over artwork (mute, close on the detail modal). */
  glass: "bg-glass text-fg backdrop-blur-md hover:bg-glass-hover",
  /** No chrome until hovered (navigation icons). */
  ghost: "bg-transparent text-fg hover:bg-surface-3/70",
} as const;
export type IconButtonVariant = keyof typeof VARIANTS;

const SIZES = {
  sm: "size-8",
  md: "size-10",
  lg: "size-12",
  hero: "size-control-hero",
} as const;
const ICON_SIZE: Record<keyof typeof SIZES, IconSize> = {
  sm: "sm",
  md: "md",
  lg: "lg",
  hero: "lg",
};

/**
 * Round icon-only button. For a visible hint, compose a tooltip around it (kept separate so
 * screens without tooltips do not load the floating-UI code):
 *
 *   <Tooltip content="Add to My List"><IconButton label="Add to My List" icon={PlusIcon} /></Tooltip>
 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name. Required: the icon alone says nothing to assistive technology. */
  label: string;
  icon: IconComponent;
  variant?: IconButtonVariant;
  size?: keyof typeof SIZES;
  /** Toggle state (`aria-pressed`), e.g. "Added to My List". */
  pressed?: boolean;
  loading?: boolean;
  /** Render the child element (a router link) instead of a button. */
  asChild?: boolean;
  children?: ReactElement;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon: Icon,
  variant = "ghost",
  size = "md",
  pressed,
  loading = false,
  asChild = false,
  className,
  children,
  disabled,
  type,
  ...rest
}: IconButtonProps) {
  const classes = cx(
    "focus-ring inline-grid shrink-0 place-items-center rounded-full",
    "transition-[background-color,border-color,color,transform] duration-fast ease-standard",
    "active:scale-94 disabled:pointer-events-none disabled:opacity-40",
    SIZES[size],
    VARIANTS[variant],
    className,
  );
  const glyph = loading ? (
    <Spinner size="sm" tone="current" label={null} />
  ) : (
    <Icon size={ICON_SIZE[size]} />
  );

  const button = asChild ? (
    <Slot.Root className={classes} aria-label={label} {...rest}>
      {glyph}
      <Slot.Slottable>{children}</Slot.Slottable>
    </Slot.Root>
  ) : (
    <button
      type={type ?? "button"}
      className={classes}
      aria-label={label}
      aria-pressed={pressed}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...rest}
    >
      {glyph}
    </button>
  );

  return button;
}
