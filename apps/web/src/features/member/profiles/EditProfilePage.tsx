import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ApiError,
  type Avatar as AvatarDto,
  DEFAULT_MATURITY_CEILING,
  DEFAULT_PROFILE_SETTINGS,
  KIDS_MATURITY_CEILING,
  MATURITY_LEVELS,
  MAX_PROFILES_PER_ACCOUNT,
  type Profile,
  type UpdateProfileBody,
} from "@webflix/contracts";
import {
  ArrowLeftIcon,
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EditIcon,
  EmptyState,
  Field,
  Input,
  LockIcon,
  RadioGroup,
  RadioItem,
  Select,
  SelectItem,
  Surface,
  Switch,
  TrashIcon,
  toast,
  UnlockIcon,
  UserIcon,
} from "@webflix/ui";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { queries } from "../../../app/query/queries.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { MemberHeader } from "../shared/Chrome.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { languageName, possessive } from "../shared/format.ts";
import { PasswordPrompt } from "../shared/PasswordPrompt.tsx";
import {
  describeMemberError,
  hasParentalControls,
  needsUnlock,
  type ProfileProof,
  useIsDemoAccount,
} from "../shared/privileges.ts";
import { removeSessionProfile, upsertSessionProfile } from "../shared/sessionProfiles.ts";
import { useToastOffset } from "../shared/useToastOffset.ts";
import { validateProfileName } from "../shared/validation.ts";
import { AvatarPicker } from "./AvatarPicker.tsx";
import {
  clampForKids,
  MATURITY_COPY,
  type MaturityLevel,
  maturityRank,
  raisesCeiling,
  SUBTITLE_LANGUAGES,
} from "./maturity.ts";
import { PinLockDialog } from "./PinLockDialog.tsx";
import { UnlockPrompt } from "./UnlockPrompt.tsx";

const editRoute = getRouteApi("/account/profiles/$profileId/edit");

interface ProfileForm {
  name: string;
  avatar: AvatarDto | null;
  isKids: boolean;
  maturityCeiling: MaturityLevel;
  autoplayNextEpisode: boolean;
  autoplayPreviews: boolean;
  subtitleLanguage: string | null;
}

function formFrom(profile: Profile): ProfileForm {
  return {
    name: profile.name,
    avatar: profile.avatar,
    isKids: profile.isKids,
    maturityCeiling: profile.maturityCeiling,
    ...profile.settings,
  };
}

/** Only what changed, so an unchanged ceiling never asks for a password. */
export function profileChanges(profile: Profile, form: ProfileForm): UpdateProfileBody {
  const body: UpdateProfileBody = {};
  if (form.name.trim() !== profile.name) body.name = form.name.trim();
  if (form.avatar && form.avatar.id !== profile.avatar.id) body.avatarId = form.avatar.id;
  if (form.isKids !== profile.isKids) body.isKids = form.isKids;
  if (form.maturityCeiling !== profile.maturityCeiling) body.maturityCeiling = form.maturityCeiling;
  const settings: NonNullable<UpdateProfileBody["settings"]> = {};
  if (form.autoplayNextEpisode !== profile.settings.autoplayNextEpisode)
    settings.autoplayNextEpisode = form.autoplayNextEpisode;
  if (form.autoplayPreviews !== profile.settings.autoplayPreviews)
    settings.autoplayPreviews = form.autoplayPreviews;
  if (form.subtitleLanguage !== profile.settings.subtitleLanguage)
    settings.subtitleLanguage = form.subtitleLanguage;
  if (Object.keys(settings).length > 0) body.settings = settings;
  return body;
}

/** Leave the editor: back where the member came from (gate or manage), else Manage profiles. */
function useLeave() {
  const router = useRouter();
  const navigate = useNavigate();
  return () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/profiles/manage", replace: true });
  };
}

/**
 * Add a profile. While parental controls are in use (a kids profile, a lowered maturity rating
 * or a lock), adding one needs the account password, asked for in place on save. A PIN can be
 * added once the profile exists (it needs the account password).
 */
export function NewProfilePage() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const queryClient = useQueryClient();
  const leave = useLeave();
  const avatars = useQuery(queries.avatars());
  const list = useQuery(queries.profiles());
  const parentalControls = list.data?.parentalControls ?? hasParentalControls(session.profiles);
  const [askPassword, setAskPassword] = useState(false);
  const taken = new Set(session.profiles.map((profile) => profile.avatar.id));
  const suggested =
    avatars.data?.groups
      .flatMap((group) => group.avatars)
      .find((avatar) => !taken.has(avatar.id)) ?? null;
  const [form, setForm] = useState<ProfileForm>({
    name: "",
    avatar: null,
    isKids: false,
    maturityCeiling: DEFAULT_MATURITY_CEILING,
    ...DEFAULT_PROFILE_SETTINGS,
  });
  const values = { ...form, avatar: form.avatar ?? suggested };

  const create = useMutation({
    mutationFn: (currentPassword: string | undefined) => {
      if (!values.avatar) throw new Error("No avatar");
      return api().createProfile({
        body: {
          name: values.name.trim(),
          avatarId: values.avatar.id,
          isKids: values.isKids,
          maturityCeiling: values.maturityCeiling,
          settings: {
            autoplayNextEpisode: values.autoplayNextEpisode,
            autoplayPreviews: values.autoplayPreviews,
            subtitleLanguage: values.subtitleLanguage,
          },
          ...(currentPassword ? { currentPassword } : {}),
        },
      });
    },
    meta: { silent: true },
    // Parental controls may have been turned on from another device since the page loaded.
    onError: (error) => {
      if (ApiError.is(error, "password_required")) setAskPassword(true);
    },
    onSuccess: (profile) => {
      setAskPassword(false);
      upsertSessionProfile(queryClient, profile);
      toast.success(`${profile.name} is ready`, { description: "Choose it on Who's watching." });
      leave();
    },
  });

  const save = () => {
    create.reset();
    if (parentalControls) setAskPassword(true);
    else create.mutate(undefined);
  };

  const closePassword = () => {
    setAskPassword(false);
    create.reset();
  };

  if (demo) {
    return (
      <EditorShell title="Add a profile">
        <EmptyState
          icon={UserIcon}
          title="Profiles can't be added to the demo account"
          description="Everyone who tries Webflix shares this account, so its profiles stay as they are. Sign up for your own account to add the people you watch with."
          action={
            <Button variant="primary" asChild>
              <Link to="/profiles/manage">Manage profiles</Link>
            </Button>
          }
        />
      </EditorShell>
    );
  }

  if (session.profiles.length >= MAX_PROFILES_PER_ACCOUNT) {
    return (
      <EditorShell title="Add a profile">
        <EmptyState
          icon={UserIcon}
          title="This account already has five profiles"
          description="Five is the most an account can have. Delete a profile you no longer use to make room for a new one."
          action={
            <Button variant="primary" asChild>
              <Link to="/profiles/manage">Manage profiles</Link>
            </Button>
          }
        />
      </EditorShell>
    );
  }

  return (
    <EditorShell
      title="Add a profile"
      description="Add a profile for another person who watches Webflix."
    >
      <ProfileEditor
        mode="create"
        form={values}
        onChange={setForm}
        otherNames={session.profiles.map((profile) => profile.name)}
        saving={create.isPending && !askPassword}
        error={askPassword ? null : create.error}
        onSave={save}
        onCancel={leave}
        loosening={false}
        notice={
          parentalControls ? (
            <FormAlert tone="info" icon={LockIcon}>
              Parental controls are on for this account, so you'll be asked for your account
              password when you add the profile.
            </FormAlert>
          ) : null
        }
      />

      <Dialog
        open={askPassword}
        onOpenChange={(open) => {
          if (!open) closePassword();
        }}
      >
        <DialogContent title="Confirm it's you" size="sm">
          <PasswordPrompt
            intro="Parental controls are on for this account, so adding a profile needs your account password."
            submitLabel="Add profile"
            pending={create.isPending}
            error={ApiError.is(create.error, "password_required") ? null : create.error}
            onCancel={closePassword}
            onSubmit={(password) => create.mutate(password)}
          />
        </DialogContent>
      </Dialog>
    </EditorShell>
  );
}

/** Edit an existing profile: details, parental controls, lock, playback, delete. */
export function EditProfilePage() {
  const { profileId } = editRoute.useParams();
  const session = useAuthenticatedSession();
  const profile = session.profiles.find((candidate) => candidate.id === profileId) ?? null;
  if (!profile) {
    return (
      <EditorShell title="Edit profile">
        <EmptyState
          icon={UserIcon}
          title="This profile doesn't exist"
          description="It may have been deleted on another device."
          action={
            <Button variant="primary" asChild>
              <Link to="/profiles/manage">Manage profiles</Link>
            </Button>
          }
        />
      </EditorShell>
    );
  }
  return <ExistingProfileEditor key={profile.id} profile={profile} />;
}

/**
 * Proof is asked for only where the server needs it: the account password to loosen parental
 * controls (higher rating, Kids off, any PIN change), and the PIN or password to change or
 * delete a locked profile from another profile or the gate. The server's answer still decides:
 * a profile locked elsewhere since the page loaded asks for its proof on the first refusal.
 */
function ExistingProfileEditor({ profile }: { profile: Profile }) {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const leave = useLeave();
  const [form, setForm] = useState<ProfileForm>(() => formFrom(profile));
  const [proof, setProof] = useState<"password" | "unlock" | null>(null);
  const [lockDialog, setLockDialog] = useState<"set" | "remove" | null>(null);
  const [deleting, setDeleting] = useState<"confirm" | "unlock" | null>(null);
  const isLast = session.profiles.length <= 1;
  const isActive = session.activeProfile?.id === profile.id;
  const locked = needsUnlock(session.activeProfile, profile);
  const raising = raisesCeiling(profile.maturityCeiling, form.maturityCeiling);
  const kidsOff = profile.isKids && !form.isKids;

  const save = useMutation({
    mutationFn: (given: ProfileProof | undefined) =>
      api().updateProfile({
        params: { id: profile.id },
        body: { ...profileChanges(profile, form), ...given },
      }),
    meta: { silent: true },
    onError: (error) => {
      if (ApiError.is(error, "password_required")) setProof("password");
      else if (ApiError.is(error, "profile_unlock_required")) setProof("unlock");
    },
    onSuccess: (updated) => {
      setProof(null);
      upsertSessionProfile(queryClient, updated);
      toast.success("Profile saved");
      leave();
    },
  });

  const remove = useMutation({
    mutationFn: (given: ProfileProof | undefined) =>
      api().deleteProfile({ params: { id: profile.id }, body: given }),
    meta: { silent: true },
    onError: (error) => {
      if (ApiError.is(error, "profile_unlock_required")) setDeleting("unlock");
    },
    onSuccess: () => {
      setDeleting(null);
      removeSessionProfile(queryClient, profile.id);
      toast.success(`${profile.name} was deleted`);
      void navigate({ to: "/profiles/manage", replace: true });
    },
  });

  const submit = () => {
    const changes = profileChanges(profile, form);
    if (Object.keys(changes).length === 0) {
      leave();
      return;
    }
    save.reset();
    if (raising || kidsOff) setProof("password");
    else if (locked) setProof("unlock");
    else save.mutate(undefined);
  };

  const closeProof = () => {
    setProof(null);
    save.reset();
  };

  // The refusal that opened a proof dialog is its question, not an error to show in it.
  const proofError =
    ApiError.is(save.error, "password_required") ||
    ApiError.is(save.error, "profile_unlock_required")
      ? null
      : save.error;

  return (
    <EditorShell title="Edit profile">
      <ProfileEditor
        mode="edit"
        form={form}
        onChange={setForm}
        otherNames={session.profiles
          .filter((item) => item.id !== profile.id)
          .map((item) => item.name)}
        saving={save.isPending && proof === null}
        error={proof ? null : save.error}
        onSave={submit}
        onCancel={leave}
        loosening={raising || kidsOff}
        detailsFixed={demo}
        notice={
          demo ? (
            <FormAlert tone="info" title="This is the shared demo account">
              Its profiles keep their name, picture, maturity rating and lock. Playback settings are
              yours to change.
            </FormAlert>
          ) : locked ? (
            <FormAlert tone="info" icon={LockIcon}>
              {profile.name} is locked. You'll be asked for {possessive(profile.name)} PIN or your
              account password when you save.
            </FormAlert>
          ) : null
        }
        lock={
          <Section
            title="Profile lock"
            description={
              profile.isLocked
                ? `A 4-digit PIN is needed to open ${profile.name}.`
                : `Anyone using this account can open ${profile.name}. Add a PIN to keep it private.`
            }
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 type-label text-fg">
                {profile.isLocked ? (
                  <LockIcon size="sm" className="text-accent" />
                ) : (
                  <UnlockIcon size="sm" className="text-fg-subtle" />
                )}
                {profile.isLocked ? "Locked with a PIN" : "Not locked"}
              </span>
              <span className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                disabled={demo}
                onClick={() => setLockDialog("set")}
              >
                {profile.isLocked ? "Change PIN" : "Add a PIN"}
              </Button>
              {profile.isLocked ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={demo}
                  onClick={() => setLockDialog("remove")}
                >
                  Remove lock
                </Button>
              ) : null}
            </div>
          </Section>
        }
        danger={
          <div className="flex flex-col items-start gap-2 border-t border-line-subtle pt-8">
            <Button
              variant="outline"
              icon={TrashIcon}
              disabled={isLast || demo}
              onClick={() => {
                remove.reset();
                setDeleting("confirm");
              }}
            >
              Delete profile
            </Button>
            <p className="type-body-sm text-fg-subtle">
              {demo
                ? "Profiles on the demo account can't be deleted."
                : isLast
                  ? "This is the only profile on the account, so it can't be deleted."
                  : "Deleting a profile also deletes its viewing activity, My List and ratings."}
            </p>
          </div>
        }
      />

      <Dialog
        open={proof !== null}
        onOpenChange={(open) => {
          if (!open) closeProof();
        }}
      >
        {proof === "password" ? (
          <DialogContent title="Confirm it's you" size="sm">
            <PasswordPrompt
              intro={
                <>
                  {raising ? (
                    <>
                      {kidsOff ? "Turning off Kids profile and raising " : "Raising "}
                      {possessive(profile.name)} maturity rating to{" "}
                      <span className="text-fg">{MATURITY_COPY[form.maturityCeiling].label}</span>{" "}
                      lets it show more mature titles.
                    </>
                  ) : kidsOff ? (
                    `Turning off Kids profile gives ${profile.name} the regular Webflix home.`
                  ) : null}{" "}
                  Enter your account password to confirm.
                </>
              }
              submitLabel="Save changes"
              pending={save.isPending}
              error={proofError}
              onCancel={closeProof}
              onSubmit={(password) => save.mutate({ currentPassword: password })}
            />
          </DialogContent>
        ) : proof === "unlock" ? (
          <DialogContent title="Profile lock is on" size="sm">
            <UnlockPrompt
              profile={profile}
              purpose="save your changes"
              submitLabel="Save changes"
              pending={save.isPending}
              error={proofError}
              onSubmit={(given) => save.mutate(given)}
            />
          </DialogContent>
        ) : null}
      </Dialog>

      <PinLockDialog
        profile={profile}
        mode={lockDialog}
        onOpenChange={(open) => {
          if (!open) setLockDialog(null);
        }}
      />

      <ConfirmDialog
        open={deleting === "confirm"}
        onOpenChange={(open) => setDeleting(open ? "confirm" : null)}
        title={`Delete ${profile.name}?`}
        description={
          <>
            {possessive(profile.name)} viewing activity, My List, ratings and settings will be
            deleted for good. This can't be undone.
            {isActive ? " You're using this profile now, so you'll go back to Who's watching." : ""}
            {remove.isError ? (
              <span className="mt-3 block text-danger" role="alert">
                {ApiError.is(remove.error, "profile_last_remaining")
                  ? "An account needs at least one profile."
                  : describeMemberError(remove.error).description}
              </span>
            ) : null}
          </>
        }
        confirmLabel="Delete profile"
        loading={remove.isPending}
        onConfirm={() => {
          if (locked) setDeleting("unlock");
          else remove.mutate(undefined);
        }}
      />

      <Dialog
        open={deleting === "unlock"}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        {deleting === "unlock" ? (
          <DialogContent title={`Delete ${profile.name}?`} size="sm">
            <UnlockPrompt
              profile={profile}
              purpose="delete it"
              submitLabel="Delete profile"
              pending={remove.isPending}
              error={ApiError.is(remove.error, "profile_unlock_required") ? null : remove.error}
              onSubmit={(given) => remove.mutate(given)}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </EditorShell>
  );
}

/** Page chrome of the profile editor. */
function EditorShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <MemberHeader home="/profiles" className="border-b border-line-subtle" />
      <main
        id="main"
        className="mx-auto flex w-full max-w-dialog-lg flex-col gap-8 px-gutter pt-8 pb-36 sm:pt-12"
      >
        <div className="flex flex-col gap-3">
          <Link
            to="/profiles/manage"
            className="focus-ring inline-flex items-center gap-1.5 self-start rounded-xs type-label text-fg-muted hover:text-fg"
          >
            <ArrowLeftIcon size="sm" /> Manage profiles
          </Link>
          <h1 className="type-headline text-fg">{title}</h1>
          {description ? <p className="type-body-lg text-fg-muted">{description}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replaceAll(/\W+/g, "-")}`;
  return (
    <Surface aria-labelledby={id} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="type-title text-fg">
          {title}
        </h2>
        {description ? <p className="type-body-sm text-fg-muted">{description}</p> : null}
      </div>
      {children}
    </Surface>
  );
}

function ProfileEditor({
  mode,
  form,
  onChange,
  otherNames,
  saving,
  error,
  onSave,
  onCancel,
  loosening,
  detailsFixed = false,
  notice,
  lock,
  danger,
}: {
  mode: "create" | "edit";
  form: ProfileForm;
  onChange: (next: ProfileForm) => void;
  otherNames: string[];
  saving: boolean;
  error: unknown;
  onSave: () => void;
  onCancel: () => void;
  /** The change loosens parental controls (higher rating, Kids off): saving asks for the password. */
  loosening: boolean;
  /** Name, picture, Kids and maturity rating can't change (the demo account): settings only. */
  detailsFixed?: boolean;
  /** What saving will ask for, said before the member gets there. */
  notice?: ReactNode;
  lock?: ReactNode;
  danger?: ReactNode;
}) {
  const [checked, setChecked] = useState(false);
  const [picking, setPicking] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  useToastOffset(barRef);
  const nameRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const nameError = checked ? validateProfileName(form.name, otherNames) : null;
  const set = (patch: Partial<ProfileForm>) => onChange({ ...form, ...patch });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (saving) return;
    if (validateProfileName(form.name, otherNames)) {
      nameRef.current?.focus();
      return;
    }
    onSave();
  };

  const failure = error
    ? ApiError.is(error, "profile_limit_reached")
      ? {
          title: "This account already has five profiles",
          description: "Delete one you no longer use to add another.",
        }
      : describeMemberError(error)
    : null;

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-6"
      aria-label="Profile settings"
    >
      {failure ? (
        <FormAlert ref={alertRef} title={failure.title}>
          {failure.description}
        </FormAlert>
      ) : null}
      {notice}

      <Section title="Profile">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={detailsFixed}
            className="group focus-ring relative size-24 shrink-0 self-center rounded-avatar text-4xl disabled:cursor-not-allowed sm:self-start"
            aria-label="Change profile picture"
          >
            <Avatar
              src={form.avatar?.imageUrl}
              name={form.name || "Profile"}
              size="fill"
              decorative
            />
            {detailsFixed ? null : (
              <span className="absolute -end-2 -bottom-2 grid size-9 place-items-center rounded-full border-2 border-surface-1 bg-fg text-fg-inverse shadow-md transition-transform duration-fast group-hover:scale-110">
                <EditIcon size="sm" />
              </span>
            )}
          </button>
          <Field label="Name" error={nameError} className="flex-1" required>
            <Input
              ref={nameRef}
              value={form.name}
              autoComplete="off"
              autoCapitalize="words"
              maxLength={30}
              autoFocus={mode === "create"}
              disabled={detailsFixed}
              onChange={(event) => set({ name: event.target.value })}
              onBlur={() => form.name.trim() && setChecked(true)}
            />
          </Field>
        </div>
        <Switch
          label="Kids profile"
          description="A simpler home with only titles rated 7+ and under."
          checked={form.isKids}
          disabled={detailsFixed}
          onCheckedChange={(isKids) =>
            set({
              isKids,
              maturityCeiling: isKids
                ? clampForKids(form.maturityCeiling, true)
                : form.maturityCeiling,
            })
          }
        />
      </Section>

      <Section
        title="Maturity rating"
        description={
          form.isKids
            ? "Kids profiles can show titles rated 7+ and under."
            : mode === "edit"
              ? "Choose the most mature titles this profile can see. Raising it needs your account password."
              : "Choose the most mature titles this profile can see."
        }
      >
        <RadioGroup
          aria-label="Maturity rating"
          value={form.maturityCeiling}
          onValueChange={(value) => set({ maturityCeiling: value as MaturityLevel })}
          disabled={detailsFixed}
          className="flex flex-col gap-4"
        >
          {MATURITY_LEVELS.map((level) => (
            <RadioItem
              key={level}
              value={level}
              label={MATURITY_COPY[level].label}
              description={MATURITY_COPY[level].description}
              disabled={form.isKids && maturityRank(level) > maturityRank(KIDS_MATURITY_CEILING)}
            />
          ))}
        </RadioGroup>
        {loosening ? (
          <FormAlert tone="info" icon={LockIcon}>
            You'll be asked for your account password when you save.
          </FormAlert>
        ) : null}
      </Section>

      {lock}

      <Section title="Playback">
        <div className="flex flex-col gap-5">
          <Switch
            label="Autoplay next episode"
            description="Start the next episode of a series automatically after a short countdown."
            checked={form.autoplayNextEpisode}
            onCheckedChange={(autoplayNextEpisode) => set({ autoplayNextEpisode })}
          />
          <Switch
            label="Autoplay previews"
            description="Play previews while browsing."
            checked={form.autoplayPreviews}
            onCheckedChange={(autoplayPreviews) => set({ autoplayPreviews })}
          />
          <Field
            label="Subtitles"
            hint="Turned on automatically when a title has them in this language."
          >
            <Select
              value={form.subtitleLanguage ?? "off"}
              onValueChange={(value) => set({ subtitleLanguage: value === "off" ? null : value })}
            >
              <SelectItem value="off">Off</SelectItem>
              {SUBTITLE_LANGUAGES.map((tag) => (
                <SelectItem key={tag} value={tag}>
                  {languageName(tag)}
                </SelectItem>
              ))}
            </Select>
          </Field>
        </div>
      </Section>

      {/* A full-width bar fixed to the bottom, so Save is always in reach on a long form; its
          buttons line up with the form column. Toasts rise above it. */}
      <div
        ref={barRef}
        className="fixed inset-x-0 bottom-0 z-(--z-sticky) border-t border-line bg-surface-1 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="mx-auto flex w-full max-w-dialog-lg gap-3 px-gutter py-4 sm:justify-end">
          <Button variant="outline" size="lg" onClick={onCancel} className="flex-1 sm:flex-none">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="accent"
            size="lg"
            loading={saving}
            className="flex-1 sm:flex-none"
          >
            {mode === "create" ? "Add profile" : "Save"}
          </Button>
        </div>
      </div>

      {danger}

      <AvatarPicker
        open={picking}
        onOpenChange={setPicking}
        current={form.avatar}
        name={form.name}
        onChoose={(avatar) => set({ avatar })}
      />
    </form>
  );
}
