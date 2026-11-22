import { ApiError, type Profile } from "@webflix/contracts";
import { Avatar, Button, PinInput } from "@webflix/ui";
import { useEffect, useState } from "react";
import { FormAlert } from "../shared/FormAlert.tsx";
import { possessive } from "../shared/format.ts";
import { describeMemberError, type ProfileProof } from "../shared/privileges.ts";
import { RetryTimer } from "../shared/RetryTimer.tsx";
import { useRetryAfter } from "../shared/useRetryAfter.ts";

/**
 * Proof for changing or deleting a locked profile from another profile or the gate, placed
 * inside a dialog: its PIN, or "Confirm it's you" as the account holder instead (which unlocks
 * every profile). `onSubmit` performs the real request with the PIN; its failures come back as
 * `error`. `onAccountHolder` closes this prompt and asks for the account-holder proof
 * (`useConfirmIdentity`), then repeats the request without a PIN.
 */
export function UnlockPrompt({
  profile,
  purpose,
  pending,
  error,
  onSubmit,
  onAccountHolder,
}: {
  profile: Profile;
  /** Completes "Enter Theo's PIN to …": "save your changes". */
  purpose: string;
  pending: boolean;
  /** The last failure of `onSubmit`'s request. */
  error: unknown;
  onSubmit: (proof: ProfileProof) => void;
  onAccountHolder: () => void;
}) {
  const [sentWith, setSentWith] = useState<"pin" | null>(null);
  const [pin, setPin] = useState("");
  const [attempt, setAttempt] = useState(0);
  const rate = useRetryAfter();
  const { track } = rate;
  const pinFailure = sentWith === "pin" ? error : null;

  // A refused PIN clears the boxes and shakes them, ready for another try.
  useEffect(() => {
    if (!pinFailure) return;
    track(pinFailure);
    setPin("");
    setAttempt((count) => count + 1);
  }, [pinFailure, track]);

  const message = ApiError.is(pinFailure, "profile_pin_invalid")
    ? "Incorrect PIN. Please try again."
    : pinFailure && !ApiError.is(pinFailure, "rate_limited")
      ? describeMemberError(pinFailure).description
      : null;

  return (
    <div className="flex flex-col items-center gap-5 pt-2">
      <p className="type-body text-center text-fg-muted">
        {profile.name} is locked. Enter {possessive(profile.name)} PIN to {purpose}.
      </p>
      <Avatar src={profile.avatar.imageUrl} name={profile.name} size="lg" decorative />
      <PinInput
        aria-label={`PIN for ${profile.name}`}
        aria-describedby={message || rate.limited ? "unlock-message" : undefined}
        value={pin}
        onChange={setPin}
        autoFocus
        error={Boolean(message)}
        shakeKey={attempt}
        disabled={rate.limited}
        onComplete={(value) => {
          if (pending) return;
          setSentWith("pin");
          onSubmit({ currentPin: value });
        }}
      />
      {rate.limited ? (
        <FormAlert id="unlock-message" title="Too many attempts">
          For your security, try again in <RetryTimer seconds={rate.waiting} />.
        </FormAlert>
      ) : message ? (
        <p id="unlock-message" role="alert" className="type-body-sm text-danger">
          {message}
        </p>
      ) : (
        <p className="min-h-5 type-body-sm text-fg-subtle" aria-live="polite">
          {pending ? "Checking the PIN…" : ""}
        </p>
      )}
      <Button variant="link" size="sm" onClick={onAccountHolder}>
        Confirm it's you instead
      </Button>
    </div>
  );
}
