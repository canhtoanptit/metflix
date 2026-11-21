import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { duplicatePairs, hamming, hashImage, sameImage } from "../src/review/check.ts";

let dir = "";

/** A scene with structure (a gradient sky, a horizon, a sun) so crops differ like photos do. */
async function scene(file: string, options: { crop?: number; flip?: boolean; quality?: number }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#123"/><stop offset="1" stop-color="#e96"/></linearGradient></defs>
    <rect width="1600" height="900" fill="url(#s)"/>
    <circle cx="1150" cy="380" r="120" fill="#ffd"/>
    <path d="M0 620 L300 480 L620 600 L900 420 L1250 640 L1600 520 L1600 900 L0 900 Z" fill="#234"/>
    <rect x="180" y="560" width="90" height="240" fill="#111"/></svg>`;
  let image = sharp(Buffer.from(svg));
  if (options.crop) {
    const width = Math.round(1600 / options.crop);
    const height = Math.round(900 / options.crop);
    image = sharp(await image.png().toBuffer()).extract({
      left: 40,
      top: 900 - height,
      width,
      height,
    });
  }
  if (options.flip) image = image.flop();
  await image
    .resize(640, 360)
    .webp({ quality: options.quality ?? 80 })
    .toFile(file);
  return file;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "webflix-check-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("perceptual duplicate check", () => {
  it("counts differing bits", () => {
    expect(hamming(0b1011n, 0b0010n)).toBe(2);
  });

  it("treats re-encodes of one image as the same and other framings as different", async () => {
    const original = await hashImage(await scene(join(dir, "a.webp"), {}));
    const reencoded = await hashImage(await scene(join(dir, "b.webp"), { quality: 40 }));
    const tight = await hashImage(await scene(join(dir, "c.webp"), { crop: 1.8 }));
    const mirrored = await hashImage(await scene(join(dir, "d.webp"), { flip: true }));
    expect(sameImage(original, reencoded)).toBe(true);
    expect(sameImage(original, tight)).toBe(false);
    expect(sameImage(original, mirrored)).toBe(false);
    expect(
      duplicatePairs([
        { id: "a", image: original },
        { id: "b", image: reencoded },
        { id: "c", image: tight },
      ]),
    ).toEqual([["a", "b"]]);
  });
});
