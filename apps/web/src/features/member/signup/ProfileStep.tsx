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
  EditIcon,
  ErrorState,
  Spinner,
  TextField,
} from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { discardPendingEvents } from "../../../app/telemetry/index.ts";
import { AvatarPicker } from "../profiles/AvatarPicker.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { validateProfileName } from "../shared/validation.ts";
import { StepBody, StepHeading } from "./SignupLayout.tsx";

export interface Row {
  name: string;
  isKids: boolean;
  /** A picture the member chose; otherwise one is picked for the row. */
  avatarId: string | null;
  /** Set once the profile exists, so a retry after a partial failure never duplicates it. */
  createdId: string | null;
}

const EMPTY_ROW: Row = { name: "", isKids: false, avatarId: null, createdId: null };

/**
 * One picture per row, all different: the member's own choices first, then grown-ups get one
 * from the first group and kids from the next.
 */
export function pickAvatars(
  groups: ReadonlyArray<{ avatars: AvatarDto[] }>,
  rows: ReadonlyArray<Pick<Row, "isKids" | "avatarId">>,
): AvatarDto[] {
  const all = groups.flatMap((group) => group.avatars);
  const adults = groups[0]?.avatars ?? all;
  const kids = groups[1]?.avatars ?? all;
  const chosen = rows.map((row) => all.find((avatar) => avatar.id === row.avatarId) ?? null);
  const used = new Set(chosen.flatMap((avatar) => (avatar ? [avatar.id] : [])));
  return rows.map((row, index) => {
    const own = chosen[index];
    if (own) return own;
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
    if (!row) return null;
    if (index > 0 && row.name.trim() === "") {
      return row.isKids ? "Add a name for this kids profile, or uncheck Kids profile." : null;
    }
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
      // The session's profile changes: nothing queued at the gate goes out under the profile.
      discardPendingEvents();
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
  const [picking, setPicking] = useState<number | null>(null);

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
            <Button variant="accent" onClick={() => void avatars.refetch()}>
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
              const locked = row.createdId !== null;
              return (
                <li key={index} className="flex items-start gap-3 sm:gap-4">
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => setPicking(index)}
                    aria-label={
                      row.name.trim()
                        ? `Choose a picture for ${row.name.trim()}`
                        : index === 0
                          ? "Choose your picture"
                          : `Choose a picture for profile ${index + 1}`
                    }
                    className="group focus-ring relative size-14 shrink-0 rounded-avatar text-xl disabled:cursor-default"
                  >
                    <Avatar
                      src={avatar?.imageUrl}
                      name={row.name || (index === 0 ? "You" : "Profile")}
                      size="fill"
                      decorative
                    />
                    {locked ? null : (
                      <span className="absolute -end-1.5 -bottom-1.5 grid size-6 place-items-center rounded-full border-2 border-canvas bg-fg text-fg-inverse shadow-sm transition-transform duration-fast group-hover:scale-110">
                        <EditIcon size="xs" />
                      </span>
                    )}
                  </button>
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
                      disabled={locked}
                      onChange={(event) => update(index, { name: event.target.value })}
                      error={error}
                    />
                    {index > 0 ? (
                      <Checkbox
                        label="Kids profile"
                        aria-label={`Profile ${index + 1} is a kids profile`}
                        checked={row.isKids}
                        disabled={locked}
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
            Kids profiles show only titles rated 7+ and under. Select a picture to change it. PIN
            locks and maturity ratings can be set for any profile later, in Manage profiles.
          </p>
          <AvatarPicker
            open={picking !== null}
            onOpenChange={(open) => {
              if (!open) setPicking(null);
            }}
            current={picking !== null ? (picks[picking] ?? null) : null}
            name={picking !== null ? (rows[picking]?.name ?? "") : ""}
            onChoose={(chosen) => {
              if (picking !== null) update(picking, { avatarId: chosen.id });
            }}
          />
        </form>
      )}
    </StepBody>
  );
}
