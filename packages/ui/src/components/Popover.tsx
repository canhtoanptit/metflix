import { Popover as RadixPopover } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "../lib/cx.ts";

export const Popover = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;
export const PopoverAnchor = RadixPopover.Anchor;

export interface PopoverContentProps extends ComponentProps<typeof RadixPopover.Content> {
  /** Small caret pointing at the trigger. */
  arrow?: boolean;
}

/** Floating panel anchored to a trigger (notifications, rating picker). Not modal. */
export function PopoverContent({
  arrow = false,
  sideOffset = 8,
  collisionPadding = 12,
  className,
  children,
  ...rest
}: PopoverContentProps) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cx(
          "z-(--z-dropdown) rounded-menu border border-line bg-surface-2 text-fg shadow-lg outline-none",
          "origin-(--radix-popover-content-transform-origin)",
          "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out",
          className,
        )}
        {...rest}
      >
        {children}
        {arrow ? <RadixPopover.Arrow className="fill-surface-2" width={14} height={7} /> : null}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}
