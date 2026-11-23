import { ReturnPath } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { isSafeRedirect, searchParam } from "../src/app/router/search.ts";

/**
 * Where the app sends a member after sign-in, a provider round trip or a guard is only ever a
 * path on this origin, by the server's own rule (`ReturnPath`). Security review L2: the old check
 * let `/<TAB>/evil.example` through, which a browser reads as `//evil.example`.
 */
const REFUSED = [
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r/evil.example",
  "/\t\t//evil.example",
  "//evil.example",
  "/\\evil.example",
  "\\/evil.example",
  "/\\/evil.example",
  "/ok\\..\\evil",
  "/ /evil.example",
  "https://evil.example",
  "javascript:alert(1)",
  "evil.example",
  "",
  `/${"a".repeat(512)}`,
];

const ALLOWED = [
  "/",
  "/browse",
  "/account/security?link=google",
  "/login?redirect=%2Faccount",
  "/title/abc#top",
  // Encoded forms stay text in the path: a browser does not decode them into a host.
  "/%2F%2Fevil.example",
  "/%09/evil.example",
  "/%5C%5Cevil.example",
  `/${"a".repeat(510)}`,
];

describe("a path to return to", () => {
  it.each(REFUSED)("refuses %j", (path) => {
    expect(isSafeRedirect(path)).toBe(false);
    expect(searchParam.redirect(path)).toBeUndefined();
  });

  it.each(ALLOWED)("accepts %j", (path) => {
    expect(isSafeRedirect(path)).toBe(true);
    expect(searchParam.redirect(path)).toBe(path);
  });

  it("a URL-encoded tab or backslash in a search parameter is refused once decoded", () => {
    for (const encoded of [
      "%2F%09%2Fevil.example",
      "%2F%0A%2Fevil.example",
      "%2F%5Cevil.example",
    ]) {
      const decoded = new URLSearchParams(`redirect=${encoded}`).get("redirect");
      expect(searchParam.redirect(decoded)).toBeUndefined();
    }
  });

  it("agrees with the server's rule on every case", () => {
    for (const path of [...REFUSED, ...ALLOWED]) {
      expect(isSafeRedirect(path), JSON.stringify(path)).toBe(ReturnPath.safeParse(path).success);
    }
  });
});
