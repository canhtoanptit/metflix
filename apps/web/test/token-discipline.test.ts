import { describe, expect, it } from "vitest";

/**
 * Screens use design tokens, never raw values (blueprint §9). This scans app and feature code for
 * hard-coded colours and pixel values in class names. Mock artwork and the reference page are
 * exempt (they generate or measure colours).
 */
const sources = import.meta.glob<string>("../src/{app,features}/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const RULES: Array<[RegExp, string]> = [
  [/#[0-9a-fA-F]{3,8}\b/, "hex colour (use a colour token: text-fg, bg-surface-2…)"],
  [/\brgba?\(/, "rgb() colour (use a colour token)"],
  [/\b(?:hsl|oklch)\(/, "colour function (use a colour token)"],
  [/-\[\d+(?:\.\d+)?px\]/, "arbitrary pixel value in a class (use the spacing/size scale)"],
];

describe("token discipline", () => {
  it("app and feature code use tokens only", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const findings: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      source.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const [pattern, message] of RULES) {
          if (pattern.test(line))
            findings.push(`${file.replace("../src/", "")}:${index + 1} ${message}`);
        }
      });
    }
    expect(findings).toEqual([]);
  });
});
