import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installDomPolyfills, resetMediaMatcher } from "../src/testing/index.ts";

installDomPolyfills();

// Explicit cleanup: Vitest runs without globals, so Testing Library cannot register it itself.
afterEach(() => {
  cleanup();
  resetMediaMatcher();
  document.documentElement.removeAttribute("data-motion");
});
