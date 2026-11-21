import { AppError } from "../errors.ts";
import type { ProfileRow } from "../repositories/records.ts";
import type { ServiceDependencies } from "./context.ts";

/**
 * Charges one credential check against the account's budget before any hashing (HTTP: the
 * `profile-pin` rate limit, per account); throws `rate_limited` when it is spent.
 */
export type ChargeCredentialCheck = () => Promise<void>;

/**
 * The only way a service checks the account password or a profile PIN after sign-in. Every check
 * is charged first, so guessing is bounded by one per-account budget whichever route it comes
 * through (docs/DECISIONS.md D25); a test enumerates the call sites of `PasswordHasher.verify`
 * to keep it that way.
 */
export function createCredentialChecks(deps: Pick<ServiceDependencies, "repos" | "passwords">) {
  const { repos, passwords } = deps;

  async function passwordMatches(
    accountId: string,
    candidate: string,
    charge: ChargeCredentialCheck,
  ): Promise<boolean> {
    await charge();
    const loaded = await repos.accounts.get(accountId);
    if (!loaded) throw new AppError("unauthenticated");
    return (await passwords.verify(candidate, loaded.account.passwordHash)).valid;
  }

  return {
    /** `password_required` without a candidate, `current_password_invalid` when it is wrong. */
    async requirePassword(
      accountId: string,
      candidate: string | undefined,
      charge: ChargeCredentialCheck,
    ): Promise<void> {
      if (candidate === undefined) throw new AppError("password_required");
      if (!(await passwordMatches(accountId, candidate, charge))) {
        throw new AppError("current_password_invalid");
      }
    },

    /** `profile_pin_invalid` unless `candidate` is the profile's PIN. */
    async requirePin(
      profile: Pick<ProfileRow, "pinHash">,
      candidate: string,
      charge: ChargeCredentialCheck,
    ): Promise<void> {
      await charge();
      const valid =
        profile.pinHash !== null && (await passwords.verify(candidate, profile.pinHash)).valid;
      if (!valid) throw new AppError("profile_pin_invalid");
    },

    /**
     * Unlock a locked profile for a change: its PIN or the account password, whichever was sent
     * (`profile_unlock_required` when neither).
     */
    async requireUnlock(
      profile: Pick<ProfileRow, "accountId" | "pinHash">,
      proof: { currentPin?: string | undefined; currentPassword?: string | undefined },
      charge: ChargeCredentialCheck,
    ): Promise<void> {
      if (proof.currentPin !== undefined) return this.requirePin(profile, proof.currentPin, charge);
      if (proof.currentPassword !== undefined) {
        return this.requirePassword(profile.accountId, proof.currentPassword, charge);
      }
      throw new AppError("profile_unlock_required");
    },
  };
}

export type CredentialChecks = ReturnType<typeof createCredentialChecks>;
