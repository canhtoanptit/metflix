import { afterEach, describe, expect, it } from "vitest";
import { parseCssTime, readCssTime } from "../src/lib/css-time.ts";

afterEach(() => {
  document.documentElement.style.removeProperty("--delay-test");
});

describe("CSS time tokens", () => {
  it("reads both units, as authored and as a production minifier rewrites them", () => {
    expect(parseCssTime("450ms")).toBe(450);
    expect(parseCssTime(".45s")).toBe(450);
    expect(parseCssTime("0.7s")).toBe(700);
    expect(parseCssTime("1.2s")).toBe(1200);
    expect(parseCssTime(" 80ms ")).toBe(80);
    expect(parseCssTime("0s")).toBe(0);
    expect(parseCssTime("0")).toBe(0);
    expect(parseCssTime("2E3ms")).toBe(2000);
  });

  it("refuses what is not a time", () => {
    expect(parseCssTime("")).toBeNull();
    expect(parseCssTime("450")).toBeNull();
    expect(parseCssTime("fast")).toBeNull();
    expect(parseCssTime("450px")).toBeNull();
    expect(parseCssTime("var(--x)")).toBeNull();
  });

  it("reads a custom property from the root", () => {
    expect(readCssTime("--delay-test")).toBeNull();
    document.documentElement.style.setProperty("--delay-test", ".25s");
    expect(readCssTime("--delay-test")).toBe(250);
  });
});
