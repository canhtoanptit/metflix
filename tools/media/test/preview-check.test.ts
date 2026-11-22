import { describe, expect, it } from "vitest";
import {
  type AudioMeasurement,
  audible,
  audioDisagreement,
  digitallySilent,
  stillMismatch,
} from "../src/video/preview-check.ts";

const sound: AudioMeasurement = { stream: true, silent: false, peakDb: -1.2, rmsDb: -18 };
const zeros: AudioMeasurement = { stream: true, silent: true, peakDb: null, rmsDb: null };
const none: AudioMeasurement = { stream: false, silent: true, peakDb: null, rmsDb: null };
const hiss: AudioMeasurement = { stream: true, silent: false, peakDb: -72, rmsDb: -90 };

describe("preview audio declarations", () => {
  it("classifies measurements", () => {
    expect(audible(sound)).toBe(true);
    expect(audible(hiss)).toBe(false);
    expect(digitallySilent(zeros)).toBe(true);
    expect(digitallySilent(none)).toBe(true);
    expect(digitallySilent(hiss)).toBe(false);
  });

  it("never lets the declared value and the measured audio disagree", () => {
    expect(audioDisagreement(true, sound)).toBeNull();
    expect(audioDisagreement(undefined, sound)).toBeNull();
    expect(audioDisagreement(false, none)).toBeNull();
    expect(audioDisagreement(false, zeros)).toBeNull();
    // A silent track offered with "Turn sound on" (the motion-art bug).
    expect(audioDisagreement(true, zeros)).toMatch(/silent/);
    expect(audioDisagreement(undefined, none)).toMatch(/hasAudio absent/);
    expect(audioDisagreement(false, sound)).toMatch(/not digitally silent/);
    expect(audioDisagreement(false, hiss)).toMatch(/not digitally silent/);
    expect(audioDisagreement(true, hiss)).toMatch(/silent/);
  });

  it("accepts a frame equal to the still and flags a shift in framing or colour", () => {
    const diff = (mae: number, shift: [number, number, number]) => ({
      mae,
      shift,
      lumaShift: 0.2126 * shift[0] + 0.7152 * shift[1] + 0.0722 * shift[2],
    });
    expect(stillMismatch("first", diff(1.2, [0.4, 0.5, 0.6]))).toBeNull();
    // 4:2:0 chroma on a saturated image: a channel moves, the picture does not.
    expect(stillMismatch("first", diff(2.0, [0.3, 0.4, 3.8]))).toBeNull();
    expect(stillMismatch("first", diff(9, [0.4, 0.5, 0.6]))).toMatch(/first frame/);
    // BT.601 encoded, BT.709 decoded.
    expect(stillMismatch("last", diff(2, [6.6, 7.4, -0.3]))).toMatch(/luma shift 6/);
  });
});
