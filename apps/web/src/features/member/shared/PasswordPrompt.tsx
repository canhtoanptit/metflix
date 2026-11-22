import { ApiError } from "@webflix/contracts";
import { Button, DialogFooter, PasswordField } from "@webflix/ui";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { FormAlert } from "./FormAlert.tsx";
import { formatCountdown } from "./format.ts";
import { describeMemberError } from "./privileges.ts";
import { useRetryAfter } from "./useRetryAfter.ts";

/**
 * "Enter your account password" step, placed inside a dialog. Parental controls and sign-in
 * details need it (blueprint: setting a PIN, raising a maturity rating). `onSubmit` performs the
 * real request with the password; a wrong password is shown inline and the field is cleared.
 */
export function PasswordPrompt({
  intro,
  submitLabel,
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  intro: ReactNode;
  submitLabel: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
  pending: boolean;
  /** The last failure of `onSubmit`'s request. */
  error: unknown;
}) {
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rate = useRetryAfter();
  const { track } = rate;

  // A new wrong-password answer clears the field and refocuses it.
  useEffect(() => {
    if (!error) return;
    track(error);
    if (ApiError.is(error, "current_password_invalid")) {
      setPassword("");
      inputRef.current?.focus();
    }
  }, [error, track]);

  const wrong = ApiError.is(error, "current_password_invalid") && password === "";
  const fieldError = wrong
    ? "That password isn't right. Try again."
    : checked && password === ""
      ? "Enter your password."
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setChecked(true);
    if (pending || rate.limited) return;
    if (!password) return inputRef.current?.focus();
    onSubmit(password);
  };

  const other =
    error && !ApiError.is(error, "current_password_invalid") && !ApiError.is(error, "rate_limited")
      ? describeMemberError(error)
      : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="type-body text-fg-muted">{intro}</div>
      {other ? <FormAlert title={other.title}>{other.description}</FormAlert> : null}
      {rate.limited ? (
        <FormAlert title="Too many attempts">
          For your security, please wait a moment. The button shows when you can try again.
        </FormAlert>
      ) : null}
      <PasswordField
        ref={inputRef}
        label="Account password"
        name="current-password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setChecked(false);
        }}
        error={fieldError}
      />
      <DialogFooter className="mt-4">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="accent" loading={pending} disabled={rate.limited}>
          {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
