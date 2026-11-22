import {
  createContext,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useContext,
  useId,
} from "react";
import { AlertCircleIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Props a control inside `<Field>` needs (id, aria-describedby, aria-invalid). Explicit props
 * passed to the control win, so controls also work outside a Field.
 */
export function useFieldControl<P extends { id?: string; "aria-describedby"?: string }>(
  props: P,
): P & { id?: string; "aria-describedby"?: string; "aria-invalid"?: true; required?: boolean } {
  const field = useContext(FieldContext);
  if (!field) return props;
  return {
    ...props,
    id: props.id ?? field.id,
    "aria-describedby": props["aria-describedby"] ?? field.describedBy,
    ...(field.invalid ? { "aria-invalid": true as const } : {}),
    ...(field.required ? { required: true } : {}),
  };
}

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  ref?: Ref<HTMLLabelElement>;
}

export function Label({ className, ...rest }: LabelProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is supplied by the caller or Field.
    <label className={cx("type-label text-fg", className)} {...rest} />
  );
}

export interface FieldMessageProps {
  id?: string;
  tone?: "hint" | "error";
  children: ReactNode;
  className?: string;
}

/** Hint or validation message under a control. Errors carry an icon (colour is not enough). */
export function FieldMessage({ id, tone = "hint", children, className }: FieldMessageProps) {
  return (
    <p
      id={id}
      className={cx(
        "flex items-start gap-1.5 type-body-sm",
        tone === "error" ? "text-danger" : "text-fg-subtle",
        className,
      )}
    >
      {tone === "error" ? <AlertCircleIcon size="sm" className="mt-0.5" /> : null}
      <span>{children}</span>
    </p>
  );
}

export interface FieldProps {
  label: ReactNode;
  /** Help text under the control (hidden while an error shows). */
  hint?: ReactNode;
  /** Validation message; marks the control invalid. */
  error?: ReactNode;
  required?: boolean;
  /** Visually hide the label (it stays the accessible name). */
  hideLabel?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Stacked label + control + message, for settings forms. The control (`Input`, `Select`,
 * `PinInput`…) picks up its id and descriptions from context.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  hideLabel = false,
  children,
  className,
}: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const hasMessage = Boolean(error || hint);
  return (
    <FieldContext
      value={{
        id,
        describedBy: hasMessage ? messageId : undefined,
        invalid: Boolean(error),
        required,
      }}
    >
      <div className={cx("flex flex-col gap-1.5", className)}>
        <Label htmlFor={id} className={hideLabel ? "sr-only" : undefined}>
          {label}
        </Label>
        {children}
        {error ? (
          <FieldMessage id={messageId} tone="error">
            {error}
          </FieldMessage>
        ) : hint ? (
          <FieldMessage id={messageId}>{hint}</FieldMessage>
        ) : null}
      </div>
    </FieldContext>
  );
}

export const CONTROL_SURFACE = cx(
  "w-full rounded-control border border-line-strong bg-canvas/70 text-fg",
  "transition-[border-color,background-color,box-shadow] duration-fast ease-standard",
  "placeholder:text-fg-subtle hover:border-fg-subtle focus:border-fg focus-ring",
  "aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50",
  "autofill:shadow-[inset_0_0_0_100px_var(--color-surface-2)] autofill:[-webkit-text-fill-color:var(--color-fg)]",
);

const INPUT_SIZES = {
  /** Dense tools (the staff console): 36px, like `Button size="sm"` plus its border. */
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-3.5 text-md",
  lg: "h-14 px-4 text-md",
} as const;

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: keyof typeof INPUT_SIZES;
  ref?: Ref<HTMLInputElement>;
}

/** Plain text input (settings forms). For auth screens use `TextField` (floating label). */
export function Input({ size = "md", className, ...rest }: InputProps) {
  const props = useFieldControl(rest);
  return <input className={cx(CONTROL_SURFACE, INPUT_SIZES[size], className)} {...props} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: "sm" | "md";
  ref?: Ref<HTMLTextAreaElement>;
}

/** Multi-line text (a reason, a note), wired to its `Field` like `Input`. */
export function Textarea({ size = "md", className, rows = 3, ...rest }: TextareaProps) {
  const props = useFieldControl(rest);
  return (
    <textarea
      rows={rows}
      className={cx(
        CONTROL_SURFACE,
        "block resize-y",
        size === "sm" ? "px-3 py-2 text-sm" : "px-3.5 py-2.5 text-md",
        className,
      )}
      {...props}
    />
  );
}
