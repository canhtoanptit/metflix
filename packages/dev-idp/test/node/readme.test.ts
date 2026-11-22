/** The README's fault table is generated from the catalogue: keep them in step. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAULT_CATALOGUE, FAULT_NAMES } from "../../src/index.ts";

describe("README", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "..", "README.md"), "utf8");

  it("documents every fault with the catalogue's own words", () => {
    for (const name of FAULT_NAMES) {
      const row = readme.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
      expect(row, name).toBeDefined();
      expect(row).toContain(FAULT_CATALOGUE[name].provider);
      expect(row).toContain(FAULT_CATALOGUE[name].relyingParty);
    }
  });
});
