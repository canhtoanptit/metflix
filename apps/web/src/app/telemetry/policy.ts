/**
 * When the browser may collect behaviour events (docs/BLUEPRINT-M2.md §6.3), as pure functions
 * of the session, the consent in force and the browser's Global Privacy Control signal. The
 * server applies the same rules and drops what they exclude; the browser applies them first,
 * so what the server would drop is never queued, stored or sent.
 *
 * Rules, each guarded by a test (test/privacy-rules.test.ts):
 * - a kids profile, or one whose maturity ceiling is lowered, collects nothing, by any path;
 * - in `opt-in` mode nothing is collected until a purpose is granted;
 * - in `off` mode nothing is collected;
 * - Global Privacy Control counts as "no" for every purpose the member has not answered
 *   themselves (an explicit answer is theirs and the latest one wins, as on the server).
 */
import {
  type ConsentState,
  DEFAULT_MATURITY_CEILING,
  MATURITY_LEVELS,
  type Profile,
  type SessionState,
} from "@webflix/contracts";

export interface Purposes {
  analytics: boolean;
  personalisation: boolean;
}

export type CollectionPolicy =
  /** Not known yet (the session or the consent is still loading): hold, never send. */
  | { decision: "pending"; waitingFor: "session" | "consent" }
  /** Nothing is collected; anything held or queued is dropped. */
  | { decision: "none"; reason: "restricted" | "off" | "not-granted" }
  | { decision: "collect"; purposes: Purposes };

/**
 * Answers the member gave themselves. GPC is a browser-wide signal, not an answer; and staff can
 * only record a withdrawal, so a grant from support is never the member's (the server no longer
 * counts one recorded before: privacy review M4).
 */
const EXPLICIT_SOURCES = new Set(["banner", "settings"]);

/** A kids profile or a lowered maturity ceiling: never profiled (§6.3). */
export function isRestrictedProfile(profile: Pick<Profile, "isKids" | "maturityCeiling">): boolean {
  if (profile.isKids) return true;
  return (
    MATURITY_LEVELS.indexOf(profile.maturityCeiling) <
    MATURITY_LEVELS.indexOf(DEFAULT_MATURITY_CEILING)
  );
}

/** Signed in with a restricted profile active. */
export function isRestrictedSession(session: SessionState): boolean {
  return session.authenticated && session.activeProfile !== null
    ? isRestrictedProfile(session.activeProfile)
    : false;
}

/**
 * Who the events would be about: the account and profile (or the gate), or an anonymous
 * device. Anything queued for one identity must never be sent as another's.
 */
export function identityOf(session: SessionState): string {
  return session.authenticated
    ? `account:${session.account.id}:${session.activeProfile?.id ?? "gate"}`
    : "anonymous";
}

/** The purposes in force once Global Privacy Control is honoured. */
export function effectivePurposes(consent: ConsentState, gpc: boolean): Purposes {
  const purpose = (name: keyof Purposes): boolean => {
    if (consent.mode === "off") return false;
    const state = consent.purposes[name];
    if (!state.granted) return false;
    const explicit = state.source !== null && EXPLICIT_SOURCES.has(state.source);
    return explicit || !gpc;
  };
  return { analytics: purpose("analytics"), personalisation: purpose("personalisation") };
}

export function collectionPolicy(input: {
  session: SessionState | undefined;
  consent: ConsentState | undefined;
  gpc: boolean;
}): CollectionPolicy {
  const { session, consent, gpc } = input;
  if (!session) return { decision: "pending", waitingFor: "session" };
  if (isRestrictedSession(session)) return { decision: "none", reason: "restricted" };
  if (!consent) return { decision: "pending", waitingFor: "consent" };
  if (consent.mode === "off") return { decision: "none", reason: "off" };
  const purposes = effectivePurposes(consent, gpc);
  if (!purposes.analytics && !purposes.personalisation) {
    return { decision: "none", reason: "not-granted" };
  }
  return { decision: "collect", purposes };
}

/** A purpose that was granted and no longer is: what is waiting to be sent must go. */
export function withdrew(before: Purposes | null, after: Purposes): boolean {
  if (!before) return false;
  return (
    (before.analytics && !after.analytics) || (before.personalisation && !after.personalisation)
  );
}

/** The browser's Global Privacy Control signal (`navigator.globalPrivacyControl`). */
export function browserGpc(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as { globalPrivacyControl?: unknown }).globalPrivacyControl === true;
}
