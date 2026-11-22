/**
 * @webflix/payments-fake: the stateful fake payment provider (docs/BLUEPRINT-M2.md §5.5, the
 * hermetic lane). Portable (Web APIs only): it runs in the Node API and in the Worker, with its
 * state in any `@webflix/db` dialect or in memory.
 */
export {
  cardFingerprint,
  FAKE_CARDS,
  FAKE_TEST_CARDS,
  type FakeCardChoice,
  type FakeCardSpec,
  type FakeTestCard,
  parseCardChoice,
  resolveTestCard,
} from "./cards.ts";
export { createFakePaymentForm, type FakePaymentFormOptions } from "./form.ts";
export {
  type DeliveryPolicy,
  FAKE_PERIOD_MS,
  FakePaymentProvider,
  type FakePaymentProviderOptions,
  type FakePromotionSeed,
  type FormOutcome,
  type RetriesExhausted,
  seededRandom,
} from "./provider.ts";
export { createSqlFakeStore } from "./sql-store.ts";
export {
  CUSTOMER_STATE_KINDS,
  FAKE_DOCUMENT_KINDS,
  type FakeClockRecord,
  type FakeDocument,
  type FakeDocumentKind,
  type FakeStore,
  type KeyReservation,
  MemoryFakeStore,
} from "./store.ts";
