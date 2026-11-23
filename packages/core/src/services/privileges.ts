import { DEFAULT_MATURITY_CEILING } from "@webflix/contracts";
import { compareMaturity } from "../domain/maturity.ts";
import { AppError } from "../errors.ts";
import type { ProfileRecord, ProfileRow } from "../repositories/records.ts";
import type { AuthContext } from "./context.ts";

/**
 * Who may do what on an account (docs/BACKEND.md, "Privileges"; docs/DECISIONS.md D24). Every
 * decision is taken here; the HTTP guard (`auth: "account-holder"`) and the profile and account
 * services call these functions and never restate a rule.
 *
 * - Account management needs an active profile without parental controls, or, while the account
 *   has no profile at all (sign-up abandoned before the first), the session at the profile gate:
 *   there are no parental controls to protect yet.
 * - A kids profile may switch profile and change its own name, avatar and settings; nothing else.
 * - Loosening a profile, or adding one while parental controls are in use, needs the account
 *   password; a locked profile is its owner's, so changing or deleting it from any other session
 *   needs its PIN or the password.
 * - The shared demo account keeps its sign-in details, membership and profiles.
 */

/** The seeded, shared demo account (`@webflix/catalog`); its id is fixed by the seeder. */
export const DEMO_ACCOUNT_ID = "demo-account";

/**
 * Where a session stands: at the gate (no profile), on a kids profile, on a profile with a
 * lowered maturity ceiling, or on a profile without parental controls.
 */
export type ProfileStanding = "gate" | "kids" | "restricted" | "unrestricted";

export function standingOf(
  profile: Pick<ProfileRow, "isKids" | "maturityCeiling"> | null,
): ProfileStanding {
  if (!profile) return "gate";
  if (profile.isKids) return "kids";
  return compareMaturity(profile.maturityCeiling, DEFAULT_MATURITY_CEILING) < 0
    ? "restricted"
    : "unrestricted";
}

/** Any kids profile, lowered ceiling or PIN lock on the account. */
export function parentalControlsInUse(
  profiles: readonly Pick<ProfileRow, "isKids" | "maturityCeiling" | "pinHash">[],
): boolean {
  return profiles.some(
    (profile) => profile.pinHash !== null || standingOf(profile) !== "unrestricted",
  );
}

/**
 * Account management: the session's active profile must have no parental controls. At the gate
 * (no active profile) only an account with no profile at all passes: once one exists, it must be
 * chosen, so a kids or restricted profile's household cannot be bypassed by not choosing one.
 * Fresh-proof requirements (password, elevation) are the services' and apply unchanged.
 */
export function requireAccountHolder(auth: AuthContext): void {
  const standing = standingOf(auth.profile);
  if (standing === "gate") {
    if (auth.accountHasProfiles === false) return;
    throw new AppError("profile_required");
  }
  if (standing !== "unrestricted") throw new AppError("unrestricted_profile_required");
}

/** Profile management is closed to kids profiles (they may only switch). */
export function requireNotKids(auth: AuthContext): void {
  if (standingOf(auth.profile) === "kids") throw new AppError("unrestricted_profile_required");
}

export function isDemoAccount(accountId: string): boolean {
  return accountId === DEMO_ACCOUNT_ID;
}

/** The demo account is shared by every visitor: one must not be able to ruin it for the next. */
export function requireNotDemo(accountId: string): void {
  if (isDemoAccount(accountId)) throw new AppError("demo_account_protected");
}

/** What a request would change on a profile, after defaults and the kids cap are applied. */
export interface ProfileChange {
  name?: string;
  avatarId?: string;
  isKids?: boolean;
  maturityCeiling?: ProfileRow["maturityCeiling"];
  /** The new PIN hash, or null to remove the lock. */
  pin?: string | null;
  /** True when any setting changes. */
  settings?: boolean;
}

/**
 * The proof a change needs:
 * - `password` when it loosens the profile (higher ceiling, kids off) or touches its PIN;
 * - `unlock` (its PIN or the password) when the profile is locked and is not the session's own;
 * - `none` otherwise.
 * Kids sessions may only change their own name, avatar and settings; the demo account only
 * settings.
 */
export function proofForProfileChange(
  auth: AuthContext,
  target: ProfileRecord,
  change: ProfileChange,
): "none" | "unlock" | "password" {
  const own = auth.profile?.id === target.id;
  const structural =
    change.name !== undefined ||
    change.avatarId !== undefined ||
    change.isKids !== undefined ||
    change.maturityCeiling !== undefined ||
    change.pin !== undefined;
  if (structural) requireNotDemo(target.accountId);
  if (standingOf(auth.profile) === "kids") {
    const loosensOrLocks =
      change.isKids !== undefined ||
      change.maturityCeiling !== undefined ||
      change.pin !== undefined;
    if (!own || loosensOrLocks) throw new AppError("unrestricted_profile_required");
  }
  const loosens =
    change.pin !== undefined ||
    (change.isKids === false && target.isKids) ||
    (change.maturityCeiling !== undefined &&
      compareMaturity(change.maturityCeiling, target.maturityCeiling) > 0);
  if (loosens) return "password";
  const changes = structural || change.settings === true;
  return changes && target.pinHash !== null && !own ? "unlock" : "none";
}

/** Deleting a profile: never from a kids session; a locked profile not the session's own needs proof. */
export function proofForProfileDeletion(
  auth: AuthContext,
  target: ProfileRecord,
): "none" | "unlock" {
  requireNotKids(auth);
  requireNotDemo(target.accountId);
  return target.pinHash !== null && auth.profile?.id !== target.id ? "unlock" : "none";
}

/** Adding a profile: never from a kids session; while parental controls are in use, the password. */
export function proofForProfileCreation(
  auth: AuthContext,
  profiles: readonly ProfileRow[],
): "none" | "password" {
  requireNotKids(auth);
  requireNotDemo(auth.session.accountId);
  return parentalControlsInUse(profiles) ? "password" : "none";
}
