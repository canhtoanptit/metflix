import { AppError } from "../errors.ts";
import type { ProfileRow } from "../repositories/records.ts";
import type { AuthContext, ServiceDependencies } from "./context.ts";

/**
 * Charges one credential check against the account's budget before any hashing (HTTP: the
 * `profile-pin` rate limit, per account); throws `rate_limited` when it is spent.
 */
export type ChargeCredentialCheck = () => Promise<void>;

/** Who is proving what: the account, and the session whose proof (`elevated_until`) counts. */
type Prover = Pick<AuthContext, "session">;

/**
 * The only way a service checks the account password or a profile PIN after sign-in, and the
 * only place the account-holder proof (§4.2) is granted and honoured. Every check is charged
 * first, so guessing is bounded by one per-account budget whichever route it comes through
 * (docs/DECISIONS.md D25); a test enumerates the call sites of `PasswordHasher.verify` to keep it
 * that way.
 *
 * The proof is the password, or a fresh sign-in with a linked issuer: either sets the session's
 * `elevated_until` for `ELEVATION_TTL_SEC`, and while it lasts it stands in for the password.
 * An account created through an issuer has no password (stored as the empty string, read as
 * null): nothing here ever compares a candidate with it, so no password, of any value, ever
 * matches such an account.
 */
export function createCredentialChecks(
  deps: Pick<ServiceDependencies, "repos" | "passwords" | "clock">,
) {
  const { repos, passwords, clock } = deps;

  /**
   * Compares a candidate with the account's password, charged first. `none`: the account has no
   * password (created through an issuer), so nothing is compared and nothing can match.
   */
  async function checkPassword(
    accountId: string,
    candidate: string,
    charge: ChargeCredentialCheck,
  ): Promise<"match" | "mismatch" | "none"> {
    await charge();
    const account = await repos.identity.getAccount(accountId);
    if (!account) throw new AppError("unauthenticated");
    // No password set: there is nothing a candidate could match (never hash against "").
    if (account.passwordHash === null) return "none";
    return (await passwords.verify(candidate, account.passwordHash)).valid ? "match" : "mismatch";
  }

  /** `password_required` for an account without a password, `current_password_invalid` if wrong. */
  async function requireMatch(
    accountId: string,
    candidate: string,
    charge: ChargeCredentialCheck,
  ): Promise<void> {
    const outcome = await checkPassword(accountId, candidate, charge);
    if (outcome === "none") throw new AppError("password_required");
    if (outcome === "mismatch") throw new AppError("current_password_invalid");
  }

  /** True while the session holds a fresh account-holder proof. */
  async function isElevated(prover: Prover): Promise<boolean> {
    const now = clock.now();
    const found = await repos.identity.getSession(prover.session.id, now);
    return (
      found !== null &&
      found.session.accountId === prover.session.accountId &&
      found.elevatedUntil !== null &&
      found.elevatedUntil > now
    );
  }

  const checks = {
    isElevated,

    /**
     * The password, or (when none is sent) a fresh proof held by the session.
     * `password_required` without either, or when the account has no password at all;
     * `current_password_invalid` when a sent one is wrong (a proof never excuses a wrong password).
     */
    async requirePassword(
      prover: Prover,
      candidate: string | undefined,
      charge: ChargeCredentialCheck,
    ): Promise<void> {
      if (candidate === undefined) {
        if (await isElevated(prover)) return;
        throw new AppError("password_required");
      }
      await requireMatch(prover.session.accountId, candidate, charge);
    },

    /**
     * The account-holder proof by password (`POST /session/elevation`): charged like every
     * password check. Returns normally only for the right password of an account that has one;
     * an account without one answers `password_required` (its proof is a fresh sign-in).
     */
    async provePassword(
      prover: Prover,
      candidate: string,
      charge: ChargeCredentialCheck,
    ): Promise<void> {
      await requireMatch(prover.session.accountId, candidate, charge);
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
     * Unlock a locked profile for a change: its PIN or the account password, whichever was sent,
     * or the session's fresh account-holder proof (`profile_unlock_required` when none).
     */
    async requireUnlock(
      prover: Prover,
      profile: Pick<ProfileRow, "accountId" | "pinHash">,
      proof: { currentPin?: string | undefined; currentPassword?: string | undefined },
      charge: ChargeCredentialCheck,
    ): Promise<void> {
      if (proof.currentPin !== undefined)
        return checks.requirePin(profile, proof.currentPin, charge);
      if (proof.currentPassword !== undefined) {
        return checks.requirePassword(prover, proof.currentPassword, charge);
      }
      if (await isElevated(prover)) return;
      throw new AppError("profile_unlock_required");
    },
  };
  return checks;
}

export type CredentialChecks = ReturnType<typeof createCredentialChecks>;
