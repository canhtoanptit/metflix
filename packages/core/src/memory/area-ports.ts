import type { AreaPorts } from "../areas/ports.ts";
import { type Clock, systemClock } from "../ports/clock.ts";
import type { IdGenerator } from "../ports/ids.ts";
import { MemoryEmailSender } from "./email-sender.ts";
import { MemoryEventSink } from "./event-sink.ts";
import { MemoryExperiments } from "./experiments.ts";
import { MemoryPaymentProvider } from "./payment-provider.ts";
import { MemoryRecommendationStore } from "./recommendation-store.ts";
import { MemoryStaffVerifier } from "./staff-verifier.ts";

/** The in-memory implementation of every milestone 2 port, with their test handles. */
export interface MemoryAreaPorts extends AreaPorts {
  email: MemoryEmailSender;
  payments: MemoryPaymentProvider;
  eventSink: MemoryEventSink;
  recommendations: MemoryRecommendationStore;
  experiments: MemoryExperiments;
  staff: MemoryStaffVerifier;
}

/**
 * Milestone 2's ports, all in process: the default of every mode until each area composes its
 * real adapters. No consumer issuer is configured (`identityProviders` empty): federated
 * sign-in needs the identity area's adapter, or a `MemoryIdentityProvider` in tests.
 */
export function createMemoryAreaPorts(
  options: { clock?: Clock; ids?: IdGenerator } = {},
): MemoryAreaPorts {
  const clock = options.clock ?? systemClock;
  const ids = options.ids;
  return {
    identityProviders: {},
    email: new MemoryEmailSender({ clock, ...(ids ? { ids } : {}) }),
    payments: new MemoryPaymentProvider({ clock }),
    eventSink: new MemoryEventSink(ids ? { ids } : {}),
    recommendations: new MemoryRecommendationStore(),
    experiments: new MemoryExperiments(),
    staff: new MemoryStaffVerifier({ clock }),
  };
}
