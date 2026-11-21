import { AlertCircleIcon, CheckCircleIcon, cx, type IconComponent, InfoIcon } from "@webflix/ui";
import type { ReactNode, Ref } from "react";

const TONES = {
  danger: { icon: AlertCircleIcon, box: "border-danger/40 bg-danger-subtle", ink: "text-danger" },
  info: { icon: InfoIcon, box: "border-line bg-surface-2", ink: "text-fg-muted" },
  positive: {
    icon: CheckCircleIcon,
    box: "border-positive/40 bg-positive-subtle",
    ink: "text-positive",
  },
  accent: { icon: InfoIcon, box: "border-accent/40 bg-accent-subtle", ink: "text-accent" },
} satisfies Record<string, { icon: IconComponent; box: string; ink: string }>;

export interface FormAlertProps {
  tone?: keyof typeof TONES;
  title?: ReactNode;
  children?: ReactNode;
  /** A way forward (link or button) under the message. */
  action?: ReactNode;
  icon?: IconComponent;
  id?: string;
  className?: string;
  /** Focus target after a failed submit, so screen readers hear it first. */
  ref?: Ref<HTMLDivElement>;
}

/**
 * Message about a whole form or page: declined card, wrong password, rate limits, account
 * notices. Errors are announced (`role="alert"`); other tones are polite status messages.
 */
export function FormAlert({
  tone = "danger",
  title,
  children,
  action,
  icon,
  id,
  className,
  ref,
}: FormAlertProps) {
  const style = TONES[tone];
  const Icon = icon ?? style.icon;
  return (
    <div
      ref={ref}
      id={id}
      tabIndex={-1}
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "flex gap-3 rounded-lg border px-4 py-3.5 text-start outline-none",
        style.box,
        className,
      )}
    >
      <Icon size="md" className={cx("mt-0.5", style.ink)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title ? <p className="type-label text-fg">{title}</p> : null}
        {children ? <div className="type-body-sm text-fg-muted">{children}</div> : null}
        {action ? <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">{action}</div> : null}
      </div>
    </div>
  );
}
