import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Profile } from "@webflix/contracts";
import { Button, Dialog, DialogContent, DialogFooter, PinInput, toast } from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { IdentityNotConfirmed } from "../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { describeMemberError } from "../shared/privileges.ts";
import { upsertSessionProfile } from "../shared/sessionProfiles.ts";
import { useFocusAfterBusy } from "../shared/useFocusAfterBusy.ts";

/** Runs a request and, when the server asks for the account-holder proof, asks for it first. */
type RunWithProof = <T>(action: () => Promise<T>) => Promise<T>;

/**
 * Add, change or remove a profile's PIN. Any PIN change loosens parental controls, so the
 * server wants the account-holder proof: `run` (from `useConfirmIdentity`) sends the change and,
 * when it is refused for want of one, asks the member to confirm it's them ("Confirm it's you",
 * over this dialog) and sends it again. The PIN stays typed while they do; after a fresh
 * sign-in at a provider (the page reloads) the dialog opens again and asks for it once more.
 */
export function PinLockDialog({
  profile,
  mode,
  onOpenChange,
  run,
  resumed = false,
}: {
  profile: Profile;
  mode: "set" | "remove" | null;
  onOpenChange: (open: boolean) => void;
  run: RunWithProof;
  /** Opened again after confirming at a provider: say so. */
  resumed?: boolean;
}) {
  const queryClient = useQueryClient();
  const [pin, setPin] = useState("");

  const close = () => {
    onOpenChange(false);
    setPin("");
    update.reset();
  };

  const update = useMutation({
    mutationFn: (next: string | null) =>
      run(() => api().updateProfile({ params: { id: profile.id }, body: { pin: next } })),
    meta: { silent: true },
    onSuccess: (updated) => {
      upsertSessionProfile(queryClient, updated);
      toast.success(
        mode === "remove" ? `${profile.name} is no longer locked` : `${profile.name} is locked`,
        mode === "remove"
          ? undefined
          : { description: "You'll need the PIN to open this profile." },
      );
      close();
    },
  });

  const saveRef = useRef<HTMLButtonElement>(null);
  useFocusAfterBusy(update.isPending, saveRef);
  const open = mode !== null;
  const title =
    mode === "remove"
      ? "Remove profile lock"
      : profile.isLocked
        ? "Change PIN"
        : "Lock this profile";
  // Closing "Confirm it's you" without confirming is not a failure worth a message here.
  const failure =
    update.error && !(update.error instanceof IdentityNotConfirmed)
      ? describeMemberError(update.error)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (update.isPending) return;
    if (mode === "remove") update.mutate(null);
    else if (pin.length === 4) update.mutate(pin);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {open ? (
        <DialogContent title={title} size="sm">
          <form className="flex flex-col gap-5" onSubmit={submit}>
            {resumed && !update.isSuccess ? (
              <FormAlert tone="positive" title="You're confirmed">
                {mode === "remove"
                  ? "Remove the lock to finish."
                  : "Enter the PIN again to save it."}
              </FormAlert>
            ) : null}
            {failure ? <FormAlert title={failure.title}>{failure.description}</FormAlert> : null}
            {mode === "remove" ? (
              <p className="type-body text-fg-muted">
                Anyone using this account will be able to open {profile.name} without a PIN. You'll
                be asked to confirm it's you.
              </p>
            ) : (
              <>
                <p className="type-body text-fg-muted">
                  Choose a 4-digit PIN. It will be needed to open {profile.name} on every device,
                  including any using {profile.name} right now. You'll be asked to confirm it's you.
                </p>
                <PinInput
                  aria-label={`New PIN for ${profile.name}`}
                  value={pin}
                  onChange={setPin}
                  autoFocus
                  mask={false}
                  disabled={update.isPending}
                  className="self-center"
                />
              </>
            )}
            <DialogFooter className="mt-2">
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                ref={saveRef}
                type="submit"
                variant={mode === "remove" ? "danger" : "accent"}
                loading={update.isPending}
                disabled={mode !== "remove" && pin.length !== 4}
              >
                {mode === "remove" ? "Remove lock" : "Save PIN"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
