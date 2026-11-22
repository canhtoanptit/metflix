import { Field, Textarea } from "@webflix/ui";

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** The contract's `AuditReason`: trimmed, 3 to 500 characters. */
export function reasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REASON_MIN)
    return "Say why, in a few words: it goes in the audit log under your name.";
  if (length > REASON_MAX) return `Keep it under ${REASON_MAX} characters (${length} now).`;
  return null;
}

/** Why: required on every change, kept in the audit log with who did it. */
export function ReasonField({
  value,
  onChange,
  error,
  disabled,
  placeholder = "For example: member asked on the support line, ticket 4821",
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Field
      label="Reason"
      required
      error={error ?? undefined}
      hint={`Kept in the audit log under your name. ${value.trim().length}/${REASON_MAX}`}
    >
      <Textarea
        size="sm"
        rows={2}
        value={value}
        maxLength={REASON_MAX + 50}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
