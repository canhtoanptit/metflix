import type { TrickPlay } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { clampPreviewLeft, trickPlayFrame, trickPlaySheets } from "../src/core/trickplay.ts";

// Same geometry as the generated test media: 2 s tiles, 240×135, 5×5 per sheet, 75 tiles.
const trickPlay: TrickPlay = {
  intervalSec: 2,
  tileWidth: 240,
  tileHeight: 135,
  columns: 5,
  rows: 5,
  count: 75,
  sheets: ["/t/0.webp", "/t/1.webp", "/t/2.webp"],
};

describe("trick-play tile maths", () => {
  it("picks the first tile at 0 s", () => {
    expect(trickPlayFrame(trickPlay, 0, 240)).toEqual({
      sheetUrl: "/t/0.webp",
      width: 240,
      height: 135,
      sheetWidth: 1200,
      sheetHeight: 675,
      offsetX: -0,
      offsetY: -0,
    });
  });

  it("locates a tile on a later sheet (60 s → tile 30 → sheet 1, cell 5 = row 1, col 0)", () => {
    const frame = trickPlayFrame(trickPlay, 60, 240);
    expect(frame?.sheetUrl).toBe("/t/1.webp");
    expect(frame?.offsetX).toBe(-0);
    expect(frame?.offsetY).toBe(-135);
  });

  it("scales tiles and the sheet to the display width", () => {
    const frame = trickPlayFrame(trickPlay, 13, 160); // tile 6: row 1, col 1
    expect(frame).toMatchObject({ width: 160, height: 90, sheetWidth: 800, sheetHeight: 450 });
    expect(frame?.offsetX).toBeCloseTo(-160, 5);
    expect(frame?.offsetY).toBeCloseTo(-90, 5);
  });

  it("clamps past the end to the last tile and rejects bad input", () => {
    expect(trickPlayFrame(trickPlay, 10_000, 240)?.sheetUrl).toBe("/t/2.webp");
    expect(trickPlayFrame(trickPlay, -5, 240)?.sheetUrl).toBe("/t/0.webp");
    expect(trickPlayFrame({ ...trickPlay, count: 0 }, 10, 240)).toBeNull();
    expect(trickPlayFrame(trickPlay, 10, 0)).toBeNull();
  });

  it("lists sheets for preloading", () => {
    expect(trickPlaySheets(trickPlay)).toEqual(trickPlay.sheets);
    expect(trickPlaySheets(null)).toEqual([]);
  });

  it("keeps the preview inside the scrubber", () => {
    expect(clampPreviewLeft(500, 200, 1000, 0)).toBe(400);
    expect(clampPreviewLeft(20, 200, 1000, 0)).toBe(0);
    expect(clampPreviewLeft(990, 200, 1000, 0)).toBe(800);
    expect(clampPreviewLeft(990, 200, 1000, -12)).toBe(812);
  });
});
