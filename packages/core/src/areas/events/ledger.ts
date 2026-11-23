import type { ConsentState } from "@webflix/contracts";
import { serializeError } from "../../ports/logger.ts";
import type { ServiceDependencies } from "../../services/context.ts";
import type { ServerEventInput } from "../module.ts";
import {
  type ConsentFlags,
  effectiveConsent,
  presentConsentState,
  purposesToWithdrawForGpc,
} from "./consent.ts";
import type { ConsentPurposeName, ConsentRecord, ConsentSourceName } from "./repository.ts";

/** What personalisation is told after an answer about its purpose (`AreaSeams`). */
export interface PersonalisationConsentChange {
  accountId: string;
  granted: boolean;
  at: number;
}

/**
 * Consent per account (§6.3): every answer is kept and the latest stamp wins; each recorded
 * answer emits a `consent.change` server event, so a member who withdraws and never comes back
 * still leaves the training data (the pipeline uses the account's latest stamp). An answer about
 * personalisation also tells the personalisation area (`personalisationConsentChanged`), which
 * stops serving learned lists from a withdrawal on.
 */
export function createConsentLedger(
  deps: ServiceDependencies,
  emit: (event: ServerEventInput) => Promise<void>,
  personalisationChanged: (change: PersonalisationConsentChange) => Promise<void> = async () => {},
) {
  const { repos, clock, ids, config, logger } = deps;
  const mode = () => config.events.consentMode;

  async function append(
    accountId: string,
    purpose: ConsentPurposeName,
    granted: boolean,
    source: ConsentSourceName,
  ): Promise<ConsentRecord> {
    const record: ConsentRecord = {
      id: ids.next(),
      accountId,
      purpose,
      granted,
      source,
      createdAt: clock.now(),
    };
    await repos.events.addConsent(record);
    await emit({
      type: "consent.change",
      payload: { purpose, granted, source },
      accountId,
      profileId: null,
    });
    if (purpose === "personalisation") {
      // Never fails the answer: it is recorded, and serving reads it again on the next change.
      await personalisationChanged({ accountId, granted, at: record.createdAt }).catch(
        (error: unknown) => {
          logger.error("events.personalisation_consent_not_told", {
            error: serializeError(error),
          });
        },
      );
    }
    return record;
  }

  /**
   * Honour Global Privacy Control for a signed-in request: record a `gpc` withdrawal for each
   * purpose it applies to (`purposesToWithdrawForGpc`). Returns the latest records after it.
   */
  async function applyGpc(accountId: string, latest: ConsentRecord[]): Promise<ConsentRecord[]> {
    const purposes = purposesToWithdrawForGpc(mode(), latest);
    if (purposes.length === 0) return latest;
    const added: ConsentRecord[] = [];
    for (const purpose of purposes) added.push(await append(accountId, purpose, false, "gpc"));
    return [...latest.filter((record) => !purposes.includes(record.purpose)), ...added];
  }

  return {
    /** The consent stamped on a signed-in request's events (GPC applied first). */
    async inForce(accountId: string, at: number, options: { gpc: boolean }): Promise<ConsentFlags> {
      let latest = await repos.events.consentsAt(accountId, at);
      if (options.gpc) latest = await applyGpc(accountId, latest);
      return effectiveConsent(mode(), latest);
    },

    /** `GET /privacy/consent` for a signed-in account. */
    async state(accountId: string, options: { gpc: boolean }): Promise<ConsentState> {
      let latest = await repos.events.consentsAt(accountId, clock.now());
      if (options.gpc) latest = await applyGpc(accountId, latest);
      return presentConsentState(mode(), options.gpc, latest);
    },

    /**
     * Record an answer. An answer equal to the one in force from the same kind of source is a
     * no-op (a banner answered again on every visit does not grow the history or the lake).
     */
    async answer(
      accountId: string,
      purpose: ConsentPurposeName,
      granted: boolean,
      source: ConsentSourceName,
    ): Promise<void> {
      const latest = await repos.events.consentsAt(accountId, clock.now());
      const current = latest.find((record) => record.purpose === purpose);
      if (current && current.granted === granted && current.source === source) return;
      await append(accountId, purpose, granted, source);
    },

    /** Every answer, oldest first (data export). */
    history: (accountId: string) => repos.events.listConsents(accountId),
  };
}

export type ConsentLedger = ReturnType<typeof createConsentLedger>;
