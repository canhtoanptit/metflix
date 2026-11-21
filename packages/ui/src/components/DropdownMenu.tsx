import { DropdownMenu as RadixMenu, Slot } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import type { IconComponent } from "../icons/createIcon.tsx";
import { CheckIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";

export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;
export const DropdownMenuGroup = RadixMenu.Group;

export function DropdownMenuContent({
  sideOffset = 8,
  collisionPadding = 12,
  className,
  ...rest
}: ComponentProps<typeof RadixMenu.Content>) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cx(
          "z-(--z-dropdown) min-w-52 rounded-menu border border-line bg-surface-2 p-1.5 text-fg shadow-lg outline-none",
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out",
          className,
        )}
        {...rest}
      />
    </RadixMenu.Portal>
  );
}

const ITEM = cx(
  "relative flex min-h-10 cursor-pointer select-none items-center gap-3 rounded-sm px-2.5 py-2 type-body-sm text-fg outline-none",
  "data-[highlighted]:bg-surface-4 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
);

export interface DropdownMenuItemProps extends ComponentProps<typeof RadixMenu.Item> {
  icon?: IconComponent;
  /** Leading visual other than an icon (a profile avatar). */
  leading?: ReactNode;
  tone?: "default" | "danger";
}

export function DropdownMenuItem({
  icon: Icon,
  leading,
  tone = "default",
  className,
  children,
  ...rest
}: DropdownMenuItemProps) {
  return (
    <RadixMenu.Item className={cx(ITEM, tone === "danger" && "text-danger", className)} {...rest}>
      {leading ?? (Icon ? <Icon size="md" className="text-fg-muted" /> : null)}
      {/* Slottable keeps `asChild` working with a leading icon (router links as items). */}
      <Slot.Slottable>{children}</Slot.Slottable>
    </RadixMenu.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...rest
}: ComponentProps<typeof RadixMenu.CheckboxItem>) {
  return (
    <RadixMenu.CheckboxItem className={cx(ITEM, "ps-9", className)} {...rest}>
      <RadixMenu.ItemIndicator className="absolute start-2.5 inline-flex text-accent">
        <CheckIcon size="sm" />
      </RadixMenu.ItemIndicator>
      {children}
    </RadixMenu.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, ...rest }: ComponentProps<typeof RadixMenu.Label>) {
  return (
    <RadixMenu.Label
      className={cx("px-2.5 py-1.5 type-overline text-fg-subtle", className)}
      {...rest}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof RadixMenu.Separator>) {
  return <RadixMenu.Separator className={cx("-mx-1.5 my-1.5 h-px bg-line", className)} {...rest} />;
}
