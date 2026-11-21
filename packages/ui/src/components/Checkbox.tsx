import { Checkbox as RadixCheckbox } from "radix-ui";
import { type ReactNode, useId } from "react";
import { CheckIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";

export interface CheckboxProps {
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Visible label (clicking it toggles). Omit only when labelled elsewhere via `aria-label`. */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  value?: string;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

export function Checkbox({
  label,
  description,
  onCheckedChange,
  id: idProp,
  className,
  ...rest
}: CheckboxProps) {
  const generated = useId();
  const id = idProp ?? generated;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <div className={cx("flex items-start gap-3", className)}>
      <RadixCheckbox.Root
        id={id}
        aria-describedby={descriptionId}
        onCheckedChange={(state) => onCheckedChange?.(state === true)}
        className={cx(
          "focus-ring mt-0.5 grid size-5 shrink-0 place-items-center rounded-xs border-2 border-line-strong bg-canvas/60",
          "transition-[background-color,border-color] duration-fast ease-standard hover:border-fg-subtle",
          "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-fg-on-accent",
          "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
          "disabled:opacity-40",
        )}
        {...rest}
      >
        <RadixCheckbox.Indicator className="data-[state=checked]:animate-scale-in">
          {rest.checked === "indeterminate" ? (
            <span className="block h-0.5 w-2.5 rounded-full bg-fg-on-accent" />
          ) : (
            <CheckIcon size="xs" strokeWidth={3} />
          )}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {label || description ? (
        <div className="flex flex-col gap-0.5">
          {label ? (
            <label htmlFor={id} className="cursor-pointer select-none type-body text-fg">
              {label}
            </label>
          ) : null}
          {description ? (
            <p id={descriptionId} className="type-body-sm text-fg-subtle">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
