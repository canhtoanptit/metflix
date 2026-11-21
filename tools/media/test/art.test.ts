import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog } from "@webflix/catalog";
import { ArtworkImage, blobKeys } from "@webflix/contracts";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AvatarArt, avatarSvg } from "../src/art/avatars.ts";
import { cropRect } from "../src/art/compose.ts";
import { resolveDirection } from "../src/art/direction.ts";
import { writeImageSet } from "../src/art/encode.ts";
import { applyGrade, resolveGrade } from "../src/art/grade.ts";
import { renderScene } from "../src/art/procedural.ts";
import { TYPE_STYLES, typeStyle } from "../src/art/styles.ts";
import { buildTreatment } from "../src/art/treatment.ts";

describe("artwork", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webflix-media-art-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lays title treatments out to fit their box, in every type style", () => {
    for (const name of Object.keys(TYPE_STYLES)) {
      const treatment = buildTreatment("The Long Table", typeStyle(name), 900, 300);
      expect(treatment.svg.startsWith("<svg")).toBe(true);
      expect(treatment.width, name).toBeLessThan(900 * 1.35);
      expect(treatment.height, name).toBeLessThan(300 * 1.6);
    }
  });

  it("stacks long titles into lines for tall boxes", () => {
    const wide = buildTreatment("Pip and the Pocket Dragons", typeStyle("playful"), 1600, 200);
    const tall = buildTreatment("Pip and the Pocket Dragons", typeStyle("playful"), 700, 700);
    expect(wide.width / wide.height).toBeGreaterThan((tall.width / tall.height) * 2);
  });

  it("crops around a focal point and clamps to the image", () => {
    expect(cropRect(4000, 3000, 16 / 9, [0.9, 0.5], [0.5, 0.5])).toEqual({
      left: 0,
      top: 375,
      width: 4000,
      height: 2250,
    });
    const poster = cropRect(4000, 3000, 2 / 3, [0.9, 0.5], [0.5, 0.5]);
    expect(poster.left + poster.width).toBe(4000);
    expect(poster.height).toBe(3000);
  });

  it("grades deterministically and keeps pixels in range", () => {
    const pixels = new Uint8Array(64 * 64 * 3).map((_, i) => (i * 37) % 256);
    const a = pixels.slice();
    const b = pixels.slice();
    applyGrade(a, 64, 64, 3, resolveGrade("teal-orange"), 7);
    applyGrade(b, 64, 64, 3, resolveGrade("teal-orange"), 7);
    expect(a).toEqual(b);
    expect(a).not.toEqual(pixels);
  });

  it("renders procedural scenes deterministically", () => {
    const options = {
      scene: "ridges" as const,
      palette: ["#102030", "#405060", "#f0d0a0"] as const,
      seed: 3,
    };
    expect(renderScene(96, 54, options)).toEqual(renderScene(96, 54, options));
  });

  it("encodes every width and format with placeholder data the contract accepts", async () => {
    const master = await sharp({
      create: { width: 960, height: 540, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();
    const { image, files } = await writeImageSet(
      master,
      blobKeys.titleImageTemplate("t-test", "card"),
      [320, 640, 1280],
      dir,
    );
    expect(ArtworkImage.parse(image)).toEqual(image);
    expect(image.widths).toEqual([320, 640]);
    expect(image.aspectRatio).toBeCloseTo(16 / 9, 3);
    expect(files).toHaveLength(4);
    const written = await readdir(join(dir, "public/img/titles/t-test"));
    expect(written.sort()).toEqual([
      "card-320.avif",
      "card-320.webp",
      "card-640.avif",
      "card-640.webp",
    ]);
  });

  it("gives every catalog title a resolvable art direction and every avatar valid art", () => {
    const genres = new Map(catalog.genres.map((genre) => [genre.id, genre.slug]));
    for (const title of catalog.titles) {
      const direction = resolveDirection(
        title,
        title.genreIds.map((id) => genres.get(id) ?? "drama"),
        new Map(),
        () => "https://example.org/film.mp4",
      );
      expect(direction.type.font, title.id).toBeTruthy();
    }
    for (const avatar of catalog.avatars) {
      expect(avatarSvg(AvatarArt.parse(avatar.art))).toContain("<svg");
    }
  });
});
