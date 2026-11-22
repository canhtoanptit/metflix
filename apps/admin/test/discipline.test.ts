import { describe, expect, it } from "vitest";

/**
 * Rules the source must keep, checked by reading it:
 * - Tokens never leave memory: no `localStorage`, IndexedDB or `document.cookie` anywhere, and
 *   `sessionStorage` only in the sign-in transaction module (which never holds a token).
 * - No member data in logs: no `console.*` calls.
 * - No runtime environment reads in the browser bundle (`process.env`): configuration comes from
 *   `config.json`.
 * - Design tokens only: no raw colours or pixel values in class names (as in the member app).
 */
const sources = import.meta.glob<string>("../src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const RULES: Array<[RegExp, string, (file: string) => boolean]> = [
  [/\blocalStorage\b/, "localStorage (tokens and member data stay in memory)", () => true],
  [/\bindexedDB\b/, "IndexedDB (tokens and member data stay in memory)", () => true],
  [/document\.cookie/, "document.cookie (the console keeps no cookie)", () => true],
  [
    /\bsessionStorage\b/,
    "sessionStorage outside the sign-in transaction",
    (file) => !file.endsWith("auth/transaction.ts"),
  ],
  [
    /\bconsole\.(log|info|warn|error|debug)\b/,
    "console logging (no member data in logs)",
    () => true,
  ],
  [/process\.env/, "process.env in the browser bundle", () => true],
  [/#[0-9a-fA-F]{3,8}\b/, "hex colour (use a colour token)", () => true],
  [/\brgba?\(/, "rgb() colour (use a colour token)", () => true],
  [/-\[\d+(?:\.\d+)?px\]/, "arbitrary pixel value in a class (use the spacing scale)", () => true],
];

describe("source discipline", () => {
  it("keeps tokens in memory, logs nothing, reads no environment, uses design tokens", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const findings: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      source.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        for (const [pattern, message, applies] of RULES) {
          if (applies(file) && pattern.test(line)) {
            findings.push(`${file.replace("../src/", "")}:${index + 1} ${message}`);
          }
        }
      });
    }
    expect(findings).toEqual([]);
  });
});
