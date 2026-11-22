import { type CONSENT_MODES, CONSENT_PURPOSES, type ConsentState } from "@webflix/contracts";
import { toIsoString } from "../../ports/clock.ts";
import type { ConsentPurposeName, ConsentRecord, ConsentSourceName } from "./repository.ts";

export type ConsentMode = (typeof CONSENT_MODES)[number];

/** Consent for each purpose, as stamped on an event's subject. */
export interface ConsentFlags {
  analytics: boolean;
  personalisation: boolean;
}

/** Sources that are the member's own explicit answer (GPC is a browser-wide signal). */
const EXPLICIT_SOURCES: ReadonlySet<ConsentSourceName> = new Set(["banner", "settings", "support"]);

export const NO_CONSENT: ConsentFlags = { analytics: false, personalisation: false };

/**
 * The deployment's default for a purpose nobody answered: granted until withdrawn in `opt-out`,
 * withheld until granted in `opt-in`, nothing collected at all in `off`.
 */
export function consentDefault(mode: ConsentMode): boolean {
  return mode === "opt-out";
}

/**
 * The consent in force per purpose: the latest stamp (one record per purpose, from
 * `consentsAt`) or the mode's default. In `off` mode nothing is collected, whatever was answered.
 */
export function effectiveConsent(
  mode: ConsentMode,
  latest: readonly Pick<ConsentRecord, "purpose" | "granted">[],
): ConsentFlags {
  if (mode === "off") return { ...NO_CONSENT };
  const flags = { analytics: consentDefault(mode), personalisation: consentDefault(mode) };
  for (const record of latest) flags[record.purpose] = record.granted;
  return flags;
}

/** Behavioural events are kept only for a purpose someone consented to (§6.3). */
export function anyConsent(flags: ConsentFlags): boolean {
  return flags.analytics || flags.personalisation;
}

/**
 * Global Privacy Control is honoured as a withdrawal (`ConsentState.gpc`): for every purpose the
 * member has not answered explicitly that would otherwise be granted (the `opt-out` default, or
 * an earlier GPC record that a later default flipped), the purposes a `gpc` withdrawal must be
 * recorded for. An explicit answer is the member's own choice and the latest stamp wins, so a
 * later explicit grant is not overridden by the browser-wide signal.
 */
export function purposesToWithdrawForGpc(
  mode: ConsentMode,
  latest: readonly Pick<ConsentRecord, "purpose" | "granted" | "source">[],
): ConsentPurposeName[] {
  if (mode !== "opt-out") return []; // opt-in withholds by default; off collects nothing
  return CONSENT_PURPOSES.filter((purpose) => {
    const record = latest.find((candidate) => candidate.purpose === purpose);
    if (!record) return true; // granted by the opt-out default
    return record.granted && !EXPLICIT_SOURCES.has(record.source);
  });
}

/** `GET /privacy/consent`: the consent in force and whether the web must ask. */
export function presentConsentState(
  mode: ConsentMode,
  gpc: boolean,
  latest: readonly ConsentRecord[],
): ConsentState {
  const flags = effectiveConsent(mode, latest);
  const purpose = (name: ConsentPurposeName) => {
    const record = latest.find((candidate) => candidate.purpose === name) ?? null;
    return {
      granted: flags[name],
      source: record?.source ?? null,
      updatedAt: record ? toIsoString(record.createdAt) : null,
    };
  };
  const unanswered = CONSENT_PURPOSES.some(
    (name) =>
      !latest.some((record) => record.purpose === name && EXPLICIT_SOURCES.has(record.source)),
  );
  return {
    mode,
    gpc,
    promptRequired: mode === "opt-in" && unanswered,
    purposes: { analytics: purpose("analytics"), personalisation: purpose("personalisation") },
  };
}

/**
 * A signed-out device's consent: its own answer sent with the batch (the banner, stored by the
 * SDK), else the mode's default; GPC withdraws what the device did not answer itself.
 */
export function deviceConsent(
  mode: ConsentMode,
  answer: ConsentFlags | undefined,
  gpc: boolean,
): ConsentFlags {
  if (mode === "off") return { ...NO_CONSENT };
  if (answer) return { analytics: answer.analytics, personalisation: answer.personalisation };
  if (gpc) return { ...NO_CONSENT };
  const value = consentDefault(mode);
  return { analytics: value, personalisation: value };
}
