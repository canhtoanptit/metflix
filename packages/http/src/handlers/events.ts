import type { AppContainer } from "../container.ts";
import { notImplemented } from "../routing.ts";
import type { AreaHandlers } from "./types.ts";

/**
 * The events area's routes (milestone 2 §6): behaviour events, consent, data export, account
 * deletion and the events read-back for the suites. Thin mappings onto `services.events`;
 * `notImplemented()` until the events area implements them.
 */
export function createEventsHandlers(_container: AppContainer): AreaHandlers<"events"> {
  return {
    ingestEvents: notImplemented(),
    getConsent: notImplemented(),
    updateConsent: notImplemented(),
    requestDataExport: notImplemented(),
    listPrivacyRequests: notImplemented(),
    requestAccountDeletion: notImplemented(),
    cancelAccountDeletion: notImplemented(),
    getRecentEvents: notImplemented(),
  };
}
