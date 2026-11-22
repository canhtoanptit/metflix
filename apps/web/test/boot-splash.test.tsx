import { render } from "@testing-library/react";
import { BrandMark } from "@webflix/ui";
import { describe, expect, it } from "vitest";

const html = Object.values(
  import.meta.glob<string>("../index.html", { query: "?raw", import: "default", eager: true }),
)[0] as string;

/**
 * The static boot splash (index.html) is painted before any script loads, then React's <Splash>
 * replaces it. It must be the very mark React renders, or the hand-over shows as a swap (it once
 * inlined the whole wordmark in the mark's square box and showed a clipped "WI").
 */
describe("boot splash", () => {
  const boot = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector(".boot-splash svg") as SVGSVGElement | null;

  it("inlines the mark React renders: same path, same viewBox", () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector("svg");
    expect(boot).not.toBeNull();
    expect(boot?.querySelectorAll("path")).toHaveLength(1);
    expect(boot?.querySelector("path")?.getAttribute("d")).toBe(
      mark?.querySelector("path")?.getAttribute("d"),
    );
    const box = (svg: Element | null | undefined) =>
      (svg?.getAttribute("viewBox") ?? "").split(/\s+/).map((value) => Number(value).toFixed(2));
    expect(box(boot)).toEqual(box(mark));
  });

  it("matches the React splash's size and pulse", () => {
    expect(html).toMatch(/\.boot-splash svg \{[^}]*width: 4rem; height: 4rem;/);
    expect(html).toMatch(/animation: boot-pulse 1\.6s cubic-bezier\(0\.2, 0, 0, 1\) infinite/);
  });
});
