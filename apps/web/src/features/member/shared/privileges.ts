import {
  ApiError,
  DEFAULT_MATURITY_CEILING,
  MATURITY_LEVELS,
  type Profile,
} from "@webflix/contracts";
import { describeError, type ErrorDescription } from "../../../app/query/errors.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";

/**
 * Who may do what on an account, as the server decides it (contract: the profile and account
 * routes). Screens use these rules to offer only what will succeed and to ask for the right
 * proof up front; the server stays the authority, so every flow still handles its answers.
 */

/**
 * Where a session stands: at the gate (no profile), on a kids profile, on a profile with a
 * lowered maturity ceiling, or on a profile without parental controls (the account holder).
 */
export type Standing = "gate" | "kids" | "restricted" | "unrestricted";

export function standingOf(profile: Profile | null): Standing {
  if (!profile) return "gate";
  if (profile.isKids) return "kids";
  return MATURITY_LEVELS.indexOf(profile.maturityCeiling) <
    MATURITY_LEVELS.indexOf(DEFAULT_MATURITY_CEILING)
    ? "restricted"
    : "unrestricted";
}

/** Any kids profile, lowered ceiling or PIN lock: adding a profile then needs the password. */
export function hasParentalControls(profiles: readonly Profile[]): boolean {
  return profiles.some((profile) => profile.isLocked || standingOf(profile) !== "unrestricted");
}

/**
 * A locked profile is its owner's: changing or deleting it from any other profile's session, or
 * from the gate, needs its PIN or the account password.
 */
export function needsUnlock(active: Profile | null, target: Profile): boolean {
  return target.isLocked && active?.id !== target.id;
}

/** What proves the request comes from the profile's owner or the account holder. */
export type ProfileProof = { currentPin: string } | { currentPassword: string };

/** The shared demo account: its sign-in details, membership and profiles stay as they are. */
export function useIsDemoAccount(): boolean {
  return useAuthenticatedSession().account.isDemo === true;
}

const PRIVILEGE_COPY: Partial<Record<string, { title: string; description: string }>> = {
  demo_account_protected: {
    title: "The demo account can't be changed",
    description:
      "Everyone who tries Webflix shares this account, so its sign-in details, membership and profiles stay as they are.",
  },
  unrestricted_profile_required: {
    title: "Switch to a profile without parental controls",
    description:
      "Kids profiles and profiles with a maturity limit can't make this change. Choose another profile on Who's watching?",
  },
};

/** `describeError`, with plain words for the refusals of the privilege rules. */
export function describeMemberError(error: unknown): ErrorDescription {
  const described = describeError(error);
  const copy = ApiError.is(error) ? PRIVILEGE_COPY[error.code] : undefined;
  return copy ? { ...described, ...copy, retryable: false } : described;
}
