import { RadioGroup as RadixRadioGroup } from "radix-ui";
import { type ReactNode, useId } from "react";
import { CheckIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";

export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  children: ReactNode;
  className?: string;
}

/**
 * One choice from a few. Every arrow key moves between options, as in a native radio group, so
 * cards laid out in a row (plans) answer Left and Right as well as Up and Down; pass
 * `orientation` only to limit the keys to one axis. Children: `RadioItem` or `RadioCard`.
 * Stacks by default; pass layout utilities to arrange cards (`className="grid md:grid-cols-3"`).
 */
export function RadioGroup({ className, orientation, ...rest }: RadioGroupProps) {
  return (
    <RadixRadioGroup.Root
      orientation={orientation}
      className={cx("wf-radio-group", className)}
      {...rest}
    />
  );
}

export interface RadioItemProps {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function RadioItem({ value, label, description, disabled }: RadioItemProps) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <RadixRadioGroup.Item
        id={id}
        value={value}
        disabled={disabled}
        className={cx(
          "focus-ring mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-line-strong",
          "transition-colors duration-fast hover:border-fg-subtle data-[state=checked]:border-accent disabled:opacity-40",
        )}
      >
        <RadixRadioGroup.Indicator className="block size-2.5 rounded-full bg-accent data-[state=checked]:animate-scale-in" />
      </RadixRadioGroup.Item>
      <label htmlFor={id} className="flex cursor-pointer flex-col gap-0.5 select-none">
        <span className="type-body text-fg">{label}</span>
        {description ? <span className="type-body-sm text-fg-subtle">{description}</span> : null}
      </label>
    </div>
  );
}

export interface RadioCardProps {
  value: string;
  /** Card content (plan name, price, features…). */
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * A whole card as a radio option (plan selection). Selected: amber outline, glow and a check.
 * The card's text content is its accessible name.
 */
export function RadioCard({ value, children, disabled, className }: RadioCardProps) {
  return (
    <RadixRadioGroup.Item
      value={value}
      disabled={disabled}
      className={cx(
        "group focus-ring relative flex w-full flex-col items-stretch rounded-xl border border-line bg-surface-1 p-5 text-start",
        "transition-[border-color,box-shadow,background-color,transform] duration-base ease-standard",
        "hover:border-line-strong hover:bg-surface-2",
        "data-[state=checked]:border-accent data-[state=checked]:bg-surface-2 data-[state=checked]:shadow-glow",
        "disabled:opacity-40",
        className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          "absolute end-4 top-4 grid size-6 place-items-center rounded-full border-2 border-line-strong",
          "transition-colors duration-fast group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent",
          "group-data-[state=checked]:text-fg-on-accent",
        )}
      >
        <RadixRadioGroup.Indicator>
          <CheckIcon size="xs" strokeWidth={3} />
        </RadixRadioGroup.Indicator>
      </span>
      {children}
    </RadixRadioGroup.Item>
  );
}
