/**
 * No search input ends in an error: a query longer than what is searched is cut (between code
 * points) and searched; `query` says what was. Only a request no search field would send (beyond
 * `SEARCH_QUERY_INPUT_MAX_LENGTH`, or empty) is refused.
 */
import {
  API_BASE_PATH,
  SEARCH_QUERY_INPUT_MAX_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
} from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createTestApp, onboard } from "./support.ts";

describe("long search queries", () => {
  it("are searched in their first characters, never split, and say what was searched", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "searcher@example.com" });
    const long = `orbit ${"quiet ".repeat(40)}`;
    const results = await device.api.search({ query: { q: long } });
    expect(results.query.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX_LENGTH);
    expect(long.startsWith(results.query)).toBe(true);
    expect(results.results.map((card) => card.id)).toContain("t-orbit");
    // Astral-plane characters (two UTF-16 units each) are kept whole.
    const astral = "𠀀".repeat(150);
    const cut = await device.api.search({ query: { q: astral } });
    expect(Array.from(cut.query)).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
    expect(cut.query).toBe("𠀀".repeat(SEARCH_QUERY_MAX_LENGTH));
  });

  it("still refuses what no search field sends", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "searcher@example.com" });
    for (const q of ["", "   ", "x".repeat(SEARCH_QUERY_INPUT_MAX_LENGTH + 1)]) {
      const response = await device.request(`${API_BASE_PATH}/search?q=${encodeURIComponent(q)}`);
      expect(response.status, `${q.length} characters`).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("validation_failed");
    }
  });
});
