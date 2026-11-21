import { type InputHTMLAttributes, type ReactNode, type Ref, useId, useState } from "react";
import { EyeIcon, EyeOffIcon } from "../icons/icons.tsx";
import { cx } from "../lib/cx.ts";
import { CONTROL_SURFACE, FieldMessage } from "./Field.tsx";

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "placeholder"> {
  /** Floating label: sits inside the field, lifts above the value on focus or when filled. */
  label: string;
  /** Validation message. Marks the field invalid and is announced with it. */
  error?: ReactNode;
  hint?: ReactNode;
  /** Trailing control inside the field (e.g. the password reveal toggle). */
  endAdornment?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/**
 * The floating-label field of the auth and sign-up screens. CSS-only float (`:placeholder-shown`
 * plus `:autofill`), so autofilled values never collide with the label.
 */
export function TextField({
  label,
  error,
  hint,
  endAdornment,
  id: idProp,
  className,
  "aria-describedby": describedByProp,
  ...rest
}: TextFieldProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const messageId = `${id}-message`;
  const describedBy =
    [describedByProp, error || hint ? messageId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="relative">
        <input
          id={id}
          // A single space keeps `:placeholder-shown` meaningful without visible placeholder text.
          placeholder=" "
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(
            CONTROL_SURFACE,
            "peer h-14 px-4 pt-5 pb-1.5 text-md",
            endAdornment ? "pe-12" : null,
          )}
          {...rest}
        />
        <label
          htmlFor={id}
          className={cx(
            "pointer-events-none absolute inset-y-0 start-4 flex origin-[0_50%] items-center",
            "text-md text-fg-subtle transition-transform duration-fast ease-standard",
            "peer-focus:-translate-y-3.25 peer-focus:scale-75",
            "peer-[:not(:placeholder-shown)]:-translate-y-3.25 peer-[:not(:placeholder-shown)]:scale-75",
            "peer-autofill:-translate-y-3.25 peer-autofill:scale-75",
          )}
        >
          {label}
        </label>
        {endAdornment ? (
          <div className="absolute inset-y-0 end-1.5 flex items-center">{endAdornment}</div>
        ) : null}
      </div>
      {error ? (
        <FieldMessage id={messageId} tone="error">
          {error}
        </FieldMessage>
      ) : hint ? (
        <FieldMessage id={messageId}>{hint}</FieldMessage>
      ) : null}
    </div>
  );
}

export type PasswordFieldProps = Omit<TextFieldProps, "type" | "endAdornment">;

/** `TextField` for passwords, with a show/hide toggle that keeps focus in the form. */
export function PasswordField(props: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOffIcon : EyeIcon;
  return (
    <TextField
      {...props}
      type={visible ? "text" : "password"}
      autoComplete={props.autoComplete ?? "current-password"}
      endAdornment={
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="focus-ring-inset grid size-10 place-items-center rounded-sm text-fg-muted transition-colors duration-fast hover:text-fg"
        >
          <Icon size="md" />
        </button>
      }
    />
  );
}
