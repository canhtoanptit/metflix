import { Avatar as RadixAvatar } from "radix-ui";
import { cx } from "../lib/cx.ts";

const SIZES = {
  xs: "size-7 text-xs",
  sm: "size-8 text-sm",
  md: "size-12 text-lg",
  lg: "size-20 text-3xl",
  gate: "size-avatar-gate text-5xl",
  /** Fills a sized parent (pickers, custom layouts); the initial scales with the parent's font. */
  fill: "size-full text-[length:inherit]",
} as const;
export type AvatarSize = keyof typeof SIZES;

export interface AvatarProps {
  /** Image URL (a profile's `avatar.imageUrl`). */
  src?: string | null;
  /** Profile name: alt text and the fallback initial. */
  name: string;
  size?: AvatarSize;
  /** Hide from assistive tech when the name is already next to it. */
  decorative?: boolean;
  className?: string;
}

/** Profile picture: rounded square, falls back to the initial while loading or on error. */
export function Avatar({ src, name, size = "sm", decorative = false, className }: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <RadixAvatar.Root
      className={cx(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden",
        "rounded-avatar bg-surface-3 align-middle",
        size === "xs" || size === "sm" ? "rounded-sm" : null,
        SIZES[size],
        className,
      )}
      aria-hidden={decorative || undefined}
    >
      {src ? (
        <RadixAvatar.Image
          src={src}
          alt={decorative ? "" : name}
          className="size-full object-cover"
          draggable={false}
        />
      ) : null}
      <RadixAvatar.Fallback
        delayMs={src ? 400 : 0}
        className="flex size-full items-center justify-center bg-brand-gradient font-display font-black text-fg-on-accent"
      >
        <span aria-hidden>{initial}</span>
        {decorative ? null : <span className="sr-only">{name}</span>}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
}
