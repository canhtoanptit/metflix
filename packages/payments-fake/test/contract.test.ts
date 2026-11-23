import { describePaymentProviderContract } from "@webflix/core/testing";
import { MemoryFakeStore } from "../src/store.ts";
import { fakeContractHarness } from "./harness.ts";

describePaymentProviderContract("fake (memory store)", () =>
  fakeContractHarness(new MemoryFakeStore()),
);

// As on Workers (`inProcessQueues: false`, docs/CLOUDFLARE.md §2): no in-memory queues, the
// compare-and-set alone keeps concurrent operations correct.
describePaymentProviderContract("fake (memory store, no in-process queues)", () =>
  fakeContractHarness(new MemoryFakeStore(), { inProcessQueues: false }),
);
