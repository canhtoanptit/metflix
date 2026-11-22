import {
  type AvatarCatalog,
  DEFAULT_PROFILE_SETTINGS,
  MAX_PROFILES_PER_ACCOUNT,
  type MaturityLevel,
  type Profile,
  type ProfileList,
  type ProfileSettings,
} from "@webflix/contracts";
import { resolveMaturityCeiling } from "../domain/maturity.ts";
import { AppError } from "../errors.ts";
import type { ProfilePatch, ProfileRow } from "../repositories/records.ts";
import type { AuthContext, ServiceDependencies } from "./context.ts";
import { type ChargeCredentialCheck, createCredentialChecks } from "./credentials.ts";
import { presentAvatar, presentProfile } from "./presenters.ts";
import {
  type ProfileChange,
  parentalControlsInUse,
  proofForProfileChange,
  proofForProfileCreation,
  proofForProfileDeletion,
} from "./privileges.ts";

export interface CreateProfileInput {
  name: string;
  avatarId: string;
  isKids?: boolean | undefined;
  maturityCeiling?: MaturityLevel | undefined;
  settings?: Partial<ProfileSettings> | undefined;
  currentPassword?: string | undefined;
}

export interface UpdateProfileInput {
  name?: string | undefined;
  avatarId?: string | undefined;
  isKids?: boolean | undefined;
  maturityCeiling?: MaturityLevel | undefined;
  settings?: Partial<ProfileSettings> | undefined;
  pin?: string | null | undefined;
  currentPassword?: string | undefined;
  currentPin?: string | undefined;
}

export interface DeleteProfileInput {
  currentPin?: string | undefined;
  currentPassword?: string | undefined;
}

function mergeSettings(
  base: ProfileSettings,
  changes: Partial<ProfileSettings> | undefined,
): ProfileSettings {
  return {
    autoplayNextEpisode: changes?.autoplayNextEpisode ?? base.autoplayNextEpisode,
    autoplayPreviews: changes?.autoplayPreviews ?? base.autoplayPreviews,
    subtitleLanguage:
      changes?.subtitleLanguage === undefined ? base.subtitleLanguage : changes.subtitleLanguage,
  };
}

/** The settings a request sets (an explicit null turns subtitles off; absent keys stay). */
function settingsChanges(settings: Partial<ProfileSettings> | undefined): Partial<ProfileSettings> {
  return Object.fromEntries(
    Object.entries(settings ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<ProfileSettings>;
}

/**
 * Profiles. Who may add, change or delete one is decided by `privileges.ts`; every password or
 * PIN check goes through `credentials.ts`, charged with the caller's `charge` first.
 */
export function createProfileService(deps: ServiceDependencies) {
  const { repos, clock, ids, passwords, streamGate } = deps;
  const credentials = createCredentialChecks(deps);

  async function requireAvatar(avatarId: string): Promise<void> {
    if (!(await repos.catalog.getAvatar(avatarId))) {
      throw new AppError("not_found", { detail: `Unknown avatar ${avatarId}` });
    }
  }

  async function requireProfile(accountId: string, profileId: string) {
    const profile = await repos.profiles.get(accountId, profileId);
    if (!profile) throw new AppError("not_found", { detail: "No such profile" });
    return profile;
  }

  return {
    async list(accountId: string): Promise<ProfileList> {
      const profiles = await repos.profiles.list(accountId);
      return {
        items: profiles.map(presentProfile),
        maxProfiles: MAX_PROFILES_PER_ACCOUNT,
        parentalControls: parentalControlsInUse(profiles),
      };
    },

    async create(
      auth: AuthContext,
      input: CreateProfileInput,
      charge: ChargeCredentialCheck,
    ): Promise<Profile> {
      const accountId = auth.session.accountId;
      const proof = proofForProfileCreation(auth, await repos.profiles.list(accountId));
      await requireAvatar(input.avatarId);
      // While parental controls are in use, a new profile would be a way around them.
      if (proof === "password") {
        await credentials.requirePassword(auth, input.currentPassword, charge);
      }
      const now = clock.now();
      const isKids = input.isKids ?? false;
      const row: ProfileRow = {
        id: ids.next(),
        accountId,
        name: input.name,
        avatarId: input.avatarId,
        isKids,
        maturityCeiling: resolveMaturityCeiling(isKids, input.maturityCeiling),
        pinHash: null,
        settings: mergeSettings(DEFAULT_PROFILE_SETTINGS, input.settings),
        createdAt: now,
        updatedAt: now,
      };
      const created = await repos.profiles.createWithinLimit(row, MAX_PROFILES_PER_ACCOUNT);
      if (!created) throw new AppError("profile_limit_reached");
      return presentProfile(await requireProfile(accountId, row.id));
    },

    async update(
      auth: AuthContext,
      profileId: string,
      input: UpdateProfileInput,
      charge: ChargeCredentialCheck,
    ): Promise<Profile> {
      const accountId = auth.session.accountId;
      const profile = await requireProfile(accountId, profileId);

      // The ceiling is resolved whenever the kind or the ceiling is set: a kids profile never
      // exceeds the kids ceiling, whichever of the two the request names.
      const kindOrCeiling = input.isKids !== undefined || input.maturityCeiling !== undefined;
      const isKids = input.isKids ?? profile.isKids;
      const settings = settingsChanges(input.settings);
      const change: ProfileChange = {};
      if (input.name !== undefined) change.name = input.name;
      if (input.avatarId !== undefined) change.avatarId = input.avatarId;
      if (input.isKids !== undefined) change.isKids = input.isKids;
      if (kindOrCeiling) {
        change.maturityCeiling = resolveMaturityCeiling(
          isKids,
          input.maturityCeiling ?? profile.maturityCeiling,
        );
      }
      if (input.pin !== undefined) change.pin = input.pin;
      if (Object.keys(settings).length > 0) change.settings = true;

      const proof = proofForProfileChange(auth, profile, change);
      if (input.avatarId !== undefined && input.avatarId !== profile.avatarId) {
        await requireAvatar(input.avatarId);
      }
      if (proof === "password") {
        await credentials.requirePassword(auth, input.currentPassword, charge);
      } else if (proof === "unlock") {
        await credentials.requireUnlock(auth, profile, input, charge);
      }

      const patch: ProfilePatch = { updatedAt: clock.now() };
      if (change.name !== undefined) patch.name = change.name;
      if (change.avatarId !== undefined) patch.avatarId = change.avatarId;
      if (change.isKids !== undefined) patch.isKids = change.isKids;
      if (change.maturityCeiling !== undefined) patch.maturityCeiling = change.maturityCeiling;
      if (change.settings) patch.settings = settings;
      // A new PIN locks every other device out of the profile until it is entered there.
      const locking = typeof input.pin === "string";
      let unbound: string[] = [];
      if (input.pin !== undefined) {
        patch.pinHash = input.pin === null ? null : await passwords.hash(input.pin);
      }
      if (locking) {
        unbound = (await repos.sessions.listForAccount(accountId, clock.now()))
          .filter(
            (session) => session.activeProfileId === profileId && session.id !== auth.session.id,
          )
          .map((session) => session.id);
      }
      const updated = await repos.profiles.update(
        accountId,
        profileId,
        patch,
        locking ? { unbindSessionsExcept: auth.session.id } : {},
      );
      if (!updated) throw new AppError("not_found", { detail: "No such profile" });
      for (const sessionId of unbound) await streamGate.releaseDevice(accountId, sessionId);
      return presentProfile(await requireProfile(accountId, profileId));
    },

    async remove(
      auth: AuthContext,
      profileId: string,
      input: DeleteProfileInput,
      charge: ChargeCredentialCheck,
    ): Promise<void> {
      const accountId = auth.session.accountId;
      const profile = await requireProfile(accountId, profileId);
      if (proofForProfileDeletion(auth, profile) === "unlock") {
        await credentials.requireUnlock(auth, profile, input, charge);
      }
      const outcome = await repos.profiles.deleteUnlessLast(accountId, profileId);
      if (outcome === "not_found") throw new AppError("not_found", { detail: "No such profile" });
      if (outcome === "last") throw new AppError("profile_last_remaining");
    },

    async listAvatars(): Promise<AvatarCatalog> {
      const { groups, avatars } = await repos.catalog.listAvatars();
      return {
        groups: groups
          .map((group) => ({
            id: group.id,
            name: group.name,
            avatars: avatars.filter((avatar) => avatar.groupId === group.id).map(presentAvatar),
          }))
          .filter((group) => group.avatars.length > 0),
      };
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
