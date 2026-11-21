import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright specs (playground/e2e) are not unit tests.
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
