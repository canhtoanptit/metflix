import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Profile } from "@webflix/contracts";
import { Button, Dialog, DialogContent, DialogFooter, PinInput, toast } from "@webflix/ui";
import { useState } from "react";
import { api } from "../../../app/api.ts";
import { PasswordPrompt } from "../shared/PasswordPrompt.tsx";
import { upsertSessionProfile } from "../shared/sessionProfiles.ts";

/**
 * Add, change or remove a profile's PIN. Setting a PIN asks for the 4 digits first and the
 * account password last, so a wrong password is corrected where it happened without
 * re-entering the PIN (the server checks both in one request).
 */
export function PinLockDialog({
  profile,
  mode,
  onOpenChange,
}: {
  profile: Profile;
  mode: "set" | "remove" | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [pin, setPin] = useState("");
  const [step, setStep] = useState<"pin" | "password">("pin");

  const close = () => {
    onOpenChange(false);
    setPin("");
    setStep("pin");
  };

  const update = useMutation({
    mutationFn: (password: string) =>
      api().updateProfile({
        params: { id: profile.id },
        body: { pin: mode === "remove" ? null : pin, currentPassword: password },
      }),
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

  const open = mode !== null;
  const title =
    mode === "remove"
      ? "Remove profile lock"
      : profile.isLocked
        ? "Change PIN"
        : "Lock this profile";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        close();
        update.reset();
      }}
    >
      {open ? (
        <DialogContent title={title} size="sm">
          {mode === "set" && step === "pin" ? (
            <form
              className="flex flex-col gap-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (pin.length === 4) setStep("password");
              }}
            >
              <p className="type-body text-fg-muted">
                Choose a 4-digit PIN. It will be needed to open {profile.name} on every device,
                including any using {profile.name} right now.
              </p>
              <PinInput
                aria-label={`New PIN for ${profile.name}`}
                value={pin}
                onChange={setPin}
                autoFocus
                mask={false}
                onComplete={() => setStep("password")}
                className="self-center"
              />
              <DialogFooter className="mt-2">
                <Button variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="accent" disabled={pin.length !== 4}>
                  Continue
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <PasswordPrompt
              intro={
                mode === "remove"
                  ? `Enter your account password to remove the lock from ${profile.name}.`
                  : `Enter your account password to lock ${profile.name} with PIN ${pin}.`
              }
              submitLabel={mode === "remove" ? "Remove lock" : "Save PIN"}
              pending={update.isPending}
              error={update.error}
              onCancel={() => {
                close();
                update.reset();
              }}
              onSubmit={(password) => update.mutate(password)}
            />
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
