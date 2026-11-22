import type { BlobStore } from "../ports/blob-store.ts";
import type { EmailSender } from "../ports/email-sender.ts";
import type { EventSink } from "../ports/event-sink.ts";
import type { Experiments } from "../ports/experiments.ts";
import type { IdentityProviders } from "../ports/identity-provider.ts";
import type { PaymentProvider } from "../ports/payment-provider.ts";
import type { RecommendationStore } from "../ports/recommendation-store.ts";
import type { StaffVerifier } from "../ports/staff-verifier.ts";

/**
 * Milestone 2's ports (§3), as the services receive them. Each runtime composes them from
 * configuration in its per-area composition files (`apps/api/src/areas/*`,
 * `apps/edge/src/areas/*`); in-memory by default (`createMemoryAreaPorts`).
 */
export interface AreaPorts {
  /** Identity area: the configured consumer issuers. */
  identityProviders: IdentityProviders;
  /** Identity area (email): sends rendered messages. */
  email: EmailSender;
  /** Billing area. */
  payments: PaymentProvider;
  /** Events area: the event lake. */
  eventSink: EventSink;
  /** Personalisation area. */
  recommendations: RecommendationStore;
  /**
   * Personalisation area: where the pipeline publishes its artefacts (`recs/current.json` and
   * `recs/v={run}/…`), read by the importer. The mode's blob store; absent: nothing to import.
   */
  recommendationArtefacts?: BlobStore;
  /** Experiments area. */
  experiments: Experiments;
  /** Admin area: staff bearer tokens. */
  staff: StaffVerifier;
}
