import { Switch as RadixSwitch } from "radix-ui";
import { type ReactNode, useId } from "react";
import { cx } from "../lib/cx.ts";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Visible label; the row is a settings line ("Autoplay previews"). */
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  name?: string;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

/** On/off setting that applies immediately (profile playback settings). */
export function Switch({ label, description, id: idProp, className, ...rest }: SwitchProps) {
  const generated = useId();
  const id = idProp ?? generated;
  const descriptionId = description ? `${id}-description` : undefined;
  const control = (
    <RadixSwitch.Root
      id={id}
      aria-describedby={descriptionId}
      className={cx(
        "focus-ring relative inline-flex h-6 w-10.5 shrink-0 items-center rounded-full bg-surface-4 p-0.5",
        "transition-colors duration-base ease-standard data-[state=checked]:bg-accent disabled:opacity-40",
      )}
      {...rest}
    >
      <RadixSwitch.Thumb
        className={cx(
          "block size-5 rounded-full bg-fg shadow-sm transition-transform duration-base ease-spring",
          "data-[state=checked]:translate-x-4.5 data-[state=checked]:bg-fg-on-accent",
        )}
      />
    </RadixSwitch.Root>
  );
  if (!label && !description) return <span className={className}>{control}</span>;
  return (
    <div className={cx("flex items-start justify-between gap-6", className)}>
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
      {control}
    </div>
  );
}
