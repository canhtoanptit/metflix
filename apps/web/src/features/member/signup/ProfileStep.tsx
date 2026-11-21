import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type Avatar as AvatarDto,
  KIDS_MATURITY_CEILING,
  MAX_PROFILES_PER_ACCOUNT,
} from "@webflix/contracts";
import {
  ArrowRightIcon,
  Avatar,
  Button,
  Checkbox,
  ErrorState,
  Spinner,
  TextField,
} from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { validateProfileName } from "../shared/validation.ts";
import { StepBody, StepHeading } from "./SignupLayout.tsx";

interface Row {
  name: string;
  isKids: boolean;
  /** Set once the profile exists, so a retry after a partial failure never duplicates it. */
  createdId: string | null;
}

const EMPTY_ROW: Row = { name: "", isKids: false, createdId: null };

/** Give each row a different avatar: grown-ups from the first group, kids from the next. */
export function pickAvatars(
  groups: ReadonlyArray<{ avatars: AvatarDto[] }>,
  rows: Row[],
): AvatarDto[] {
  const all = groups.flatMap((group) => group.avatars);
  const adults = groups[0]?.avatars ?? all;
  const kids = groups[1]?.avatars ?? all;
  const used = new Set<string>();
  return rows.map((row, index) => {
    const pool = row.isKids ? kids : adults;
    const pick =
      pool.find((avatar, position) => position >= index % pool.length && !used.has(avatar.id)) ??
      all.find((avatar) => !used.has(avatar.id)) ??
      all[0];
    if (!pick) throw new Error("No avatars available");
    used.add(pick.id);
    return pick;
  });
}

/**
 * Step 4, after the account exists: name the people who watch. The first profile is required;
 * up to four more are optional, each can be a kids profile. Profiles are created one by one
 * (remembering which already exist), then the first is selected and the member lands in the app.
 *
 * Adding a profile needs the account password once parental controls are in use, so every
 * profile is created first and the kids ones become kids profiles afterwards (restricting a
 * profile needs no proof): the member is never asked for the password they just chose.
 */
export function ProfileStep() {
  const navigate = useNavigate();
  const applySession = useApplySession();
  const avatars = useQuery(queries.avatars());
  const [rows, setRows] = useState<Row[]>(() =>
    Array.from({ length: MAX_PROFILES_PER_ACCOUNT }, () => ({ ...EMPTY_ROW })),
  );
  const [checked, setChecked] = useState(false);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const alertRef = useRef<HTMLDivElement>(null);
  const flight = useSingleFlight();

  const filled = rows.filter((row, index) => index === 0 || row.name.trim().length > 0);
  const errorAt = (index: number): string | null => {
    const row = rows[index];
    if (!row || (index > 0 && row.name.trim() === "")) return null;
    const others = rows.filter((_, other) => other < index).map((other) => other.name);
    return validateProfileName(row.name, others);
  };

  const create = useMutation({
    mutationFn: async () => {
      const groups = avatars.data?.groups ?? [];
      const picks = pickAvatars(groups, rows);
      let firstId: string | null = null;
      const kids: string[] = [];
      for (const [index, row] of rows.entries()) {
        if (index > 0 && row.name.trim() === "") continue;
        let id = row.createdId;
        if (!id) {
          const avatar = picks[index];
          if (!avatar) throw new Error("No avatar for profile");
          const profile = await api().createProfile({
            body: { name: row.name.trim(), avatarId: avatar.id },
          });
          id = profile.id;
          const createdId = id;
          setRows((current) =>
            current.map((item, position) => (position === index ? { ...item, createdId } : item)),
          );
        }
        firstId ??= id;
        if (row.isKids) kids.push(id);
      }
      // Idempotent, so a retry after a partial failure simply applies it again.
      for (const id of kids) {
        await api().updateProfile({
          params: { id },
          body: { isKids: true, maturityCeiling: KIDS_MATURITY_CEILING },
        });
      }
      if (!firstId) throw new Error("No profile created");
      return api().selectProfile({ body: { profileId: firstId } });
    },
    meta: { silent: true },
    onSuccess: async (session) => {
      await applySession(session);
      await navigate({ to: "/browse", replace: true });
    },
  });

  useFocusOnError(create.error, () => alertRef);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (flight.isBusy() || create.isSuccess) return;
    const firstInvalid = rows.findIndex((_, index) => errorAt(index) !== null);
    if (firstInvalid !== -1) {
      inputs.current[firstInvalid]?.focus();
      return;
    }
    flight.run(() => create.mutateAsync());
  };

  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );

  const picks = avatars.data ? pickAvatars(avatars.data.groups, rows) : [];

  return (
    <StepBody>
      <StepHeading
        step={4}
        title="Who's watching?"
        description="Everyone gets their own recommendations, My List and settings. Add up to five people now, or later in Manage profiles."
      />
      {avatars.isPending ? (
        <div className="grid place-items-center py-16">
          <Spinner size="lg" label="Loading" />
        </div>
      ) : avatars.isError ? (
        <ErrorState
          title="We couldn't load profile pictures"
          description={describeError(avatars.error).description}
          action={
            <Button variant="primary" onClick={() => void avatars.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <form onSubmit={submit} noValidate className="flex flex-col gap-6" aria-label="Profiles">
          {create.isError ? (
            <FormAlert ref={alertRef} title="We couldn't finish setting up your profiles">
              {describeError(create.error).description} Profiles that were saved stay saved.
            </FormAlert>
          ) : null}
          <ol className="flex flex-col gap-5">
            {rows.map((row, index) => {
              const error = checked ? errorAt(index) : null;
              const avatar = picks[index];
              return (
                <li key={index} className="flex items-start gap-3 sm:gap-4">
                  <span className="size-14 shrink-0 text-xl">
                    <Avatar
                      src={avatar?.imageUrl}
                      name={row.name || (index === 0 ? "You" : "Profile")}
                      size="fill"
                      decorative
                    />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                    <TextField
                      ref={(node) => {
                        inputs.current[index] = node;
                      }}
                      label={index === 0 ? "Your name" : "Name (optional)"}
                      aria-label={index === 0 ? undefined : `Profile ${index + 1} name (optional)`}
                      autoComplete={index === 0 ? "given-name" : "off"}
                      autoCapitalize="words"
                      maxLength={30}
                      value={row.name}
                      disabled={row.createdId !== null}
                      onChange={(event) => update(index, { name: event.target.value })}
                      error={error}
                    />
                    {index > 0 && (row.name.trim() || row.isKids) ? (
                      <Checkbox
                        label="Kids profile"
                        checked={row.isKids}
                        disabled={row.createdId !== null}
                        onCheckedChange={(isKids) => update(index, { isKids })}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <Button
            type="submit"
            variant="accent"
            size="lg"
            fullWidth
            iconAfter={ArrowRightIcon}
            loading={create.isPending || create.isSuccess}
          >
            {filled.length > 1 ? `Create ${filled.length} profiles` : "Start watching"}
          </Button>
          <p className="type-body-sm text-fg-subtle">
            Kids profiles only show titles rated 7+ and under. You can change pictures, add a PIN
            lock or set maturity ratings for any profile later.
          </p>
        </form>
      )}
    </StepBody>
  );
}
