import { Link } from "@tanstack/react-router";
import type { Profile } from "@webflix/contracts";
import { Avatar, cx, EditIcon, KidsIcon, LockIcon, PlusIcon, Spinner } from "@webflix/ui";
import type { ReactNode } from "react";

const TILE =
  "group focus-ring flex w-full flex-col items-center gap-3 rounded-lg p-1 text-center outline-none";
const FRAME =
  "relative grid size-28 place-items-center rounded-avatar text-5xl ring-0 md:size-32 xl:size-avatar-gate ring-fg ring-offset-0 transition-[box-shadow,transform] duration-fast ease-standard group-hover:ring-4 group-focus-visible:ring-4";
const NAME =
  "flex max-w-full items-center justify-center gap-1.5 type-body-lg text-fg-muted transition-colors duration-fast group-hover:text-fg group-focus-visible:text-fg";

/** Grid of profile tiles shared by "Who's watching?" and "Manage profiles". */
export function ProfileGrid({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul
      aria-label={label}
      className="grid w-full max-w-dialog-lg grid-cols-2 justify-items-center gap-x-4 gap-y-8 sm:grid-cols-3 md:flex md:max-w-none md:flex-wrap md:justify-center md:gap-[clamp(1.5rem,2.5vw,2.5rem)]"
    >
      {children}
    </ul>
  );
}

function TileLabel({ profile }: { profile: Profile }) {
  return (
    <span className={NAME}>
      <span className="truncate">{profile.name}</span>
      {profile.isLocked ? <LockIcon size="sm" label="Locked" className="shrink-0" /> : null}
      {profile.isKids ? <KidsIcon size="sm" label="Kids profile" className="shrink-0" /> : null}
    </span>
  );
}

/** A profile to pick (gate). The accessible name starts with the profile name. */
export function ProfileChoice({
  profile,
  busy,
  disabled,
  onChoose,
}: {
  profile: Profile;
  busy: boolean;
  disabled: boolean;
  onChoose: (profile: Profile) => void;
}) {
  return (
    <li className="w-full md:w-auto">
      <button
        type="button"
        onClick={() => onChoose(profile)}
        disabled={disabled}
        aria-busy={busy || undefined}
        className={cx(TILE, "disabled:cursor-progress")}
      >
        <span className={FRAME}>
          <Avatar src={profile.avatar.imageUrl} name={profile.name} size="fill" decorative />
          {busy ? (
            <span className="absolute inset-0 grid place-items-center rounded-avatar bg-scrim">
              <Spinner size="lg" label={null} />
            </span>
          ) : null}
        </span>
        <TileLabel profile={profile} />
      </button>
    </li>
  );
}

/** A profile to edit (manage): the picture dims under a pencil. */
export function ProfileEditLink({ profile }: { profile: Profile }) {
  return (
    <li className="w-full md:w-auto">
      <Link
        to="/profiles/$profileId/edit"
        params={{ profileId: profile.id }}
        aria-label={`Edit ${profile.name}`}
        className={TILE}
      >
        <span className={FRAME}>
          <Avatar src={profile.avatar.imageUrl} name={profile.name} size="fill" decorative />
          <span className="absolute inset-0 grid place-items-center rounded-avatar bg-scrim/70 transition-colors duration-fast group-hover:bg-scrim/50">
            <span className="grid size-[38%] place-items-center rounded-full border-2 border-fg/80 text-fg">
              <EditIcon size="lg" />
            </span>
          </span>
        </span>
        <TileLabel profile={profile} />
      </Link>
    </li>
  );
}

/** "Add profile" tile (hidden once the account has five). */
export function AddProfileTile() {
  return (
    <li className="w-full md:w-auto">
      <Link to="/profiles/new" className={TILE}>
        <span
          className={cx(
            FRAME,
            "border-2 border-dashed border-line-strong text-fg-subtle group-hover:border-fg group-hover:text-fg",
          )}
        >
          <PlusIcon size="xl" />
        </span>
        <span className={NAME}>Add profile</span>
      </Link>
    </li>
  );
}
