import { describe, expect, it } from "vitest";
import {
  MOTION_FPS,
  MOTION_MIN_PEAK_ZOOM,
  motionArtFilter,
  motionPlan,
  zoomAt,
} from "../src/video/motion.ts";

describe("motion art", () => {
  it("starts and ends exactly on the still and pushes at least a fifth in between", () => {
    for (const seed of [1, 7, 42, 0xdeadbeef, 123456789]) {
      const plan = motionPlan(seed, 16);
      expect(plan.frames).toBe(16 * MOTION_FPS);
      expect(zoomAt(plan, 0)).toBe(1);
      expect(zoomAt(plan, plan.frames - 1)).toBeCloseTo(1, 12);
      expect(zoomAt(plan, (plan.frames - 1) / 2)).toBeCloseTo(plan.peak, 12);
      expect(plan.peak).toBeGreaterThanOrEqual(MOTION_MIN_PEAK_ZOOM);
    }
  });

  it("has no fade, grade, grain or vignette, and converts to tagged BT.709 once", () => {
    const filter = motionArtFilter(42, 16, 960, 540);
    for (const banned of ["fade", "vignette", "noise", "eq=", "anullsrc"])
      expect(filter).not.toContain(banned);
    expect(filter).toContain("out_color_matrix=bt709");
    // The light enters and leaves just outside the frame.
    expect(filter).toMatch(/overlay=x='(-960\+\(1920\)|960\+\(-1920\))\*n\/383'/);
    expect(filter).toContain("pow(sin(PI*on/383),2)");
  });
});
