import * as z from "zod";
import { Id, IsoDateTime, LanguageTag, ResourceUrl } from "./common.ts";
import { PROFILE_NAME_MAX_LENGTH } from "./constants.ts";
import { MaturityLevel } from "./maturity.ts";

export const Avatar = z
  .object({
    id: Id,
    name: z.string(),
    imageUrl: ResourceUrl,
    groupId: Id,
  })
  .meta({ id: "Avatar" });
export type Avatar = z.output<typeof Avatar>;

export const AvatarGroup = z
  .object({
    id: Id,
    name: z.string(),
    avatars: z.array(Avatar),
  })
  .meta({ id: "AvatarGroup" });
export type AvatarGroup = z.output<typeof AvatarGroup>;

export const AvatarCatalog = z
  .object({ groups: z.array(AvatarGroup) })
  .meta({ id: "AvatarCatalog" });
export type AvatarCatalog = z.output<typeof AvatarCatalog>;

export const ProfileSettings = z
  .object({
    autoplayNextEpisode: z.boolean(),
    autoplayPreviews: z.boolean(),
    /** Preferred subtitle language; null means subtitles off by default. */
    subtitleLanguage: LanguageTag.nullable(),
  })
  .meta({ id: "ProfileSettings" });
export type ProfileSettings = z.output<typeof ProfileSettings>;

export const Profile = z
  .object({
    id: Id,
    name: z.string(),
    avatar: Avatar,
    isKids: z.boolean(),
    maturityCeiling: MaturityLevel,
    /** True when a PIN is required to select this profile. The PIN itself is never returned. */
    isLocked: z.boolean(),
    settings: ProfileSettings,
    createdAt: IsoDateTime,
  })
  .meta({ id: "Profile" });
export type Profile = z.output<typeof Profile>;

export const ProfileList = z
  .object({
    items: z.array(Profile),
    maxProfiles: z.number().int().positive(),
    /**
     * Parental controls are in use (a kids profile, a lowered maturity ceiling or a PIN lock):
     * adding a profile needs the account password (`CreateProfileBody.currentPassword`).
     */
    parentalControls: z.boolean().optional(),
  })
  .meta({ id: "ProfileList" });
export type ProfileList = z.output<typeof ProfileList>;

export const ProfileName = z.string().trim().min(1).max(PROFILE_NAME_MAX_LENGTH);
export const ProfilePin = z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits");

/** The account password as sent to prove the request comes from the account holder. */
const CurrentPassword = z.string().min(1).max(128);

/** Adding a profile while parental controls are in use needs `currentPassword`. */
export const CreateProfileBody = z
  .object({
    name: ProfileName,
    avatarId: Id,
    isKids: z.boolean().optional(),
    /** Defaults to 7+ for kids profiles and 18+ otherwise. A kids profile cannot exceed 7+. */
    maturityCeiling: MaturityLevel.optional(),
    settings: ProfileSettings.partial().optional(),
    currentPassword: CurrentPassword.optional(),
  })
  .meta({ id: "CreateProfileBody" });
export type CreateProfileBody = z.input<typeof CreateProfileBody>;

/**
 * Partial update. Setting or clearing `pin`, raising `maturityCeiling` or turning off `isKids`
 * needs `currentPassword` (`password_required` without it, `current_password_invalid` when
 * wrong). Changing a locked profile from another profile's session, or from the gate, needs
 * its `currentPin` or `currentPassword` (`profile_unlock_required`).
 */
export const UpdateProfileBody = z
  .object({
    name: ProfileName.optional(),
    avatarId: Id.optional(),
    isKids: z.boolean().optional(),
    maturityCeiling: MaturityLevel.optional(),
    settings: ProfileSettings.partial().optional(),
    /** A 4-digit PIN to lock the profile, or null to remove the lock. */
    pin: ProfilePin.nullable().optional(),
    /** The profile's present PIN, to unlock it for this change. */
    currentPin: ProfilePin.optional(),
    currentPassword: CurrentPassword.optional(),
  })
  .meta({ id: "UpdateProfileBody" });

/**
 * Deleting a locked profile from another profile's session, or from the gate, needs its
 * `currentPin` or the `currentPassword`. The body is optional.
 */
export const DeleteProfileBody = z
  .object({
    currentPin: ProfilePin.optional(),
    currentPassword: CurrentPassword.optional(),
  })
  .meta({ id: "DeleteProfileBody" });
export type DeleteProfileBody = z.input<typeof DeleteProfileBody>;
export type UpdateProfileBody = z.input<typeof UpdateProfileBody>;

export const SelectProfileBody = z
  .object({
    profileId: Id,
    pin: ProfilePin.optional(),
  })
  .meta({ id: "SelectProfileBody" });
export type SelectProfileBody = z.input<typeof SelectProfileBody>;
