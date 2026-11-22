import { Select as RadixSelect } from "radix-ui";
import type { ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";
import { useFieldControl } from "./Field.tsx";

const TRIGGERS = {
  /** Form control, matches `Input`. */
  field:
    "h-11 w-full rounded-control border border-line-strong bg-canvas/70 px-3.5 text-md hover:border-fg-subtle",
  /** Compact solid dropdown (season selector, sort order). */
  solid:
    "h-10 rounded-control border border-line-strong bg-surface-3 px-3.5 text-md font-semibold hover:bg-surface-4",
  /** Dense form control (the staff console), matches `Input size="sm"`. */
  compact:
    "h-9 w-full rounded-control border border-line-strong bg-canvas/70 px-3 text-sm hover:border-fg-subtle",
} as const;

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  variant?: keyof typeof TRIGGERS;
  /** Accessible name when not inside a `Field` (e.g. "Season"). */
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  name?: string;
  children: ReactNode;
  className?: string;
}

/** Single-choice dropdown (Radix Select). Options are `<SelectItem>`s. */
export function Select({
  value,
  defaultValue,
  onValueChange,
  placeholder,
  variant = "field",
  disabled,
  name,
  children,
  className,
  ...aria
}: SelectProps) {
  const control = useFieldControl(aria);
  return (
    <RadixSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <RadixSelect.Trigger
        {...control}
        className={cx(
          "focus-ring inline-flex items-center justify-between gap-3 text-fg",
          "transition-[border-color,background-color] duration-fast ease-standard",
          "aria-invalid:border-danger disabled:opacity-50 data-[placeholder]:text-fg-subtle",
          TRIGGERS[variant],
          className,
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="text-fg-muted">
          <ChevronDownIcon size="sm" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          className={cx(
            "z-(--z-dropdown) max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width)",
            "overflow-hidden rounded-menu border border-line bg-surface-2 shadow-lg",
            "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out origin-(--radix-select-content-transform-origin)",
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-7 items-center justify-center text-fg-muted">
            <ChevronUpIcon size="sm" />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1.5">{children}</RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex h-7 items-center justify-center text-fg-muted">
            <ChevronDownIcon size="sm" />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export interface SelectItemProps {
  value: string;
  children: ReactNode;
  /** Secondary text on the right ("8 episodes"). */
  meta?: ReactNode;
  disabled?: boolean;
}

export function SelectItem({ value, children, meta, disabled }: SelectItemProps) {
  return (
    <RadixSelect.Item
      value={value}
      disabled={disabled}
      className={cx(
        "relative flex h-10 cursor-pointer select-none items-center gap-3 rounded-sm ps-8 pe-3 text-md text-fg outline-none",
        "data-[highlighted]:bg-surface-4 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
      )}
    >
      <RadixSelect.ItemIndicator className="absolute start-2 inline-flex text-accent">
        <CheckIcon size="sm" />
      </RadixSelect.ItemIndicator>
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
      {meta ? <span className="ms-auto text-sm text-fg-subtle">{meta}</span> : null}
    </RadixSelect.Item>
  );
}
