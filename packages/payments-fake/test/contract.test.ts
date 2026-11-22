import { describePaymentProviderContract } from "@webflix/core/testing";
import { MemoryFakeStore } from "../src/store.ts";
import { fakeContractHarness } from "./harness.ts";

describePaymentProviderContract("fake (memory store)", () =>
  fakeContractHarness(new MemoryFakeStore()),
);
