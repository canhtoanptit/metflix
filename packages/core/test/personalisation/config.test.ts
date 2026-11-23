/**
 * The default ranking policy (pipeline review H1): the learned model is turned on deliberately
 * in production, after an experiment; elsewhere it stays on so the demo run, the specs and the
 * conformance checks exercise the learned path.
 */
import { describe, expect, it } from "vitest";
import { loadPersonalisationConfig } from "../../src/areas/personalisation/config.ts";

describe("the default ranking policy", () => {
  it("is the rule engine in production unless an operator sets it", () => {
    expect(loadPersonalisationConfig({ vars: {}, environment: "production" }).config).toMatchObject(
      { defaultPolicy: "rules" },
    );
    const chosen = loadPersonalisationConfig({
      vars: { WEBFLIX_RECS_DEFAULT_POLICY: "learned" },
      environment: "production",
    });
    expect(chosen.issues).toEqual([]);
    expect(chosen.config.defaultPolicy).toBe("learned");
  });

  it("is learned outside production", () => {
    for (const environment of ["development", "test"] as const) {
      expect(loadPersonalisationConfig({ vars: {}, environment }).config.defaultPolicy).toBe(
        "learned",
      );
    }
    expect(
      loadPersonalisationConfig({
        vars: { WEBFLIX_RECS_DEFAULT_POLICY: "rules" },
        environment: "development",
      }).config.defaultPolicy,
    ).toBe("rules");
  });
});
