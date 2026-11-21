/** L7: the demo account (public credentials) is seeded in production only on request. */
import { describe, expect, it } from "vitest";
import { seedsDemo } from "../../scripts/lib/seed.ts";

describe("demo account seeding", () => {
  it("is on locally and off in production unless asked for", () => {
    expect(seedsDemo("local", {})).toBe(true);
    expect(seedsDemo("production", {})).toBe(false);
    expect(seedsDemo("production", { demo: true })).toBe(true);
    expect(seedsDemo("local", { noDemo: true })).toBe(false);
    expect(() => seedsDemo("production", { demo: true, noDemo: true })).toThrow();
  });
});
