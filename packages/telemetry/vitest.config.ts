import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A simulated DOM (visibility, page lifecycle, IntersectionObserver stand-in, storage):
    // driving the SDK in a real browser belongs to the browser suites.
    environment: "jsdom",
  },
});
