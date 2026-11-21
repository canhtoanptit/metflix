import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError } from "@webflix/contracts";
import { Button, ChevronRightIcon, cx, TextField } from "@webflix/ui";
import { type FormEvent, useId, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { normalizeEmail, validateEmail } from "../shared/validation.ts";

/**
 * "Get started" email capture. Known emails go to sign-in, new ones into sign-up, both with
 * the email carried over. If the lookup is rate limited we still move on (sign-up checks the
 * email again before anything is created).
 */
export function EmailCapture({ className, label }: { className?: string; label: string }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [checked, setChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();

  const status = useMutation({
    mutationFn: (value: string) => api().getEmailStatus({ query: { email: value } }),
    meta: { silent: true },
    onSuccess: ({ next }, value) =>
      next === "login"
        ? navigate({ to: "/login", search: { email: value } })
        : navigate({ to: "/signup", search: { email: value } }),
    onError: (error, value) => {
      if (ApiError.is(error, "rate_limited"))
        void navigate({ to: "/signup", search: { email: value } });
      else inputRef.current?.focus();
    },
  });

  const error = checked
    ? (validateEmail(email) ??
      (status.isError && !ApiError.is(status.error, "rate_limited")
        ? describeError(status.error).description
        : null))
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (status.isPending) return;
    if (validateEmail(email)) {
      inputRef.current?.focus();
      return;
    }
    status.mutate(normalizeEmail(email));
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby={labelId}
      className={cx("flex w-full flex-col gap-4", className)}
    >
      <p id={labelId} className="type-body-lg text-fg">
        {label}
      </p>
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-start">
        <TextField
          ref={inputRef}
          label="Email address"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (status.isError) status.reset();
          }}
          error={error}
          className="flex-1 text-start"
        />
        <Button
          type="submit"
          variant="accent"
          size="xl"
          iconAfter={ChevronRightIcon}
          loading={status.isPending}
          className="h-14"
        >
          Get started
        </Button>
      </div>
    </form>
  );
}
