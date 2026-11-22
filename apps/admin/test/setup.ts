import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { installDomPolyfills, resetMediaMatcher } from "@webflix/ui/testing";
import { afterEach } from "vitest";

installDomPolyfills();

// Explicit cleanup: Vitest runs without globals, so Testing Library cannot register it itself.
afterEach(() => {
  cleanup();
  resetMediaMatcher();
  sessionStorage.clear();
  localStorage.clear();
});
