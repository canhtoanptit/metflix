/**
 * Art direction: the free-form `art` object on each seed title (opaque to the API), parsed
 * here and completed with genre defaults, so a title added without any direction still gets
 * coherent, genre-appropriate artwork.
 */
import type { TitleSeed } from "@webflix/contracts";
import { z } from "zod";
import { sha256 } from "../util/hash.ts";
import { GRADES, type Grade, resolveGrade } from "./grade.ts";
import type { PhotoRecord } from "./photos.ts";
import { SCENES, type Scene } from "./procedural.ts";
import { TYPE_STYLES, typeStyle } from "./styles.ts";
import type { TreatmentStyle } from "./treatment.ts";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Focus = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

export const ArtDirection = z.object({
  /** Photo library id for key art (default `<slug>-1` when it exists). */
  photo: z.string().optional(),
  /** Photo ids for episode stills (default `<slug>-2…`). */
  stills: z.array(z.string()).optional(),
  /** Real films: key art and stills are frames from the film itself (seconds into it). */
  frames: z
    .object({
      key: z.number(),
      poster: z.number().optional(),
      /** Video asset whose film to cut from (default: the title's first asset). */
      asset: z.string().optional(),
    })
    .optional(),

  /** Where the subject sits in the source image (0-1). */
  focus: Focus.optional(),
  /** Poster crop focus when it differs from the backdrop's. */
  posterFocus: Focus.optional(),
  grade: z.string().optional(),
  gradeOverrides: z.record(z.string(), z.unknown()).optional(),
  type: z.string().optional(),
  typeOverrides: z.record(z.string(), z.unknown()).optional(),
  procedural: z
    .object({
      scene: z.enum(SCENES),
      palette: z.tuple([Hex, Hex, Hex]),
      seed: z.number().int().optional(),
    })
    .optional(),
  card: z.enum(["bottom-left", "bottom-center", "center", "left"]).optional(),
  poster: z.enum(["bottom", "top", "center"]).optional(),
  /** Mirror the source horizontally (to move the subject right of the logo). */
  flip: z.boolean().optional(),
});
export type ArtDirection = z.output<typeof ArtDirection>;

export interface ProceduralSource {
  kind: "procedural";
  scene: Scene;
  palette: readonly [string, string, string];
  seed: number;
}

export interface ResolvedDirection {
  source:
    | { kind: "photo"; photo: PhotoRecord }
    | { kind: "frames"; filmUrl: string; key: number; poster: number }
    | ProceduralSource;
  /** What to draw when the source (a photo not fetched yet) is missing. */
  fallback: ProceduralSource;
  stills: PhotoRecord[];
  focus: readonly [number, number];
  posterFocus: readonly [number, number];
  grade: Grade;
  gradeName: string;
  type: TreatmentStyle;
  typeName: string;
  card: "bottom-left" | "bottom-center" | "center" | "left";
  poster: "bottom" | "top" | "center";
  flip: boolean;
  seed: number;
}

type Palette = readonly [string, string, string];

/**
 * Genre → candidate looks; a hash of the title picks among them so a genre row is not
 * uniform. `scenes`/`palettes` drive procedural art (the offline fallback and titles without
 * a photo).
 */
const GENRE_LOOKS: Record<
  string,
  { type: string[]; grade: string[]; scenes: Scene[]; palettes: Palette[] }
> = {
  drama: {
    type: ["prestige-serif", "bold-serif", "didone", "caslon"],
    grade: ["bleach", "natural", "dusk"],
    scenes: ["sea", "ridges"],
    palettes: [
      ["#1b2a3a", "#6b7f8f", "#e9d8b8"],
      ["#20141c", "#7d5a63", "#f2c9a0"],
    ],
  },
  comedy: {
    type: ["retro", "fraunces", "abril", "indie"],
    grade: ["vivid", "pastel"],
    scenes: ["sea", "ridges"],
    palettes: [
      ["#2b1745", "#ff7a59", "#ffd166"],
      ["#123b5c", "#4fb3bf", "#ffe29a"],
    ],
  },
  thriller: {
    type: ["condensed", "oswald", "impact"],
    grade: ["cold-steel", "teal-orange"],
    scenes: ["city", "forest"],
    palettes: [
      ["#0b1622", "#2d5d7b", "#ffb15c"],
      ["#0d1117", "#30475e", "#c7d6e0"],
    ],
  },
  crime: {
    type: ["impact", "condensed", "archivo-black"],
    grade: ["teal-orange", "noir"],
    scenes: ["city"],
    palettes: [
      ["#0c0f14", "#3a4a5a", "#f2a65a"],
      ["#140a0a", "#5a2a2a", "#e8b04a"],
    ],
  },
  mystery: {
    type: ["didone", "typewriter", "caslon"],
    grade: ["moonlit", "verdant"],
    scenes: ["forest", "sea"],
    palettes: [
      ["#0e1a24", "#38505c", "#cfd9d6"],
      ["#101418", "#3d4b3a", "#d8d2b0"],
    ],
  },
  "sci-fi": {
    type: ["tech", "orbit", "chakra"],
    grade: ["cold-steel", "neon"],
    scenes: ["planet", "nebula"],
    palettes: [
      ["#0a1030", "#2f6fb0", "#9ee7ff"],
      ["#1a0b2e", "#7b2cbf", "#ff9e6d"],
    ],
  },
  fantasy: {
    type: ["epic", "ember", "celtic", "marcellus"],
    grade: ["ember", "verdant"],
    scenes: ["ridges", "forest"],
    palettes: [
      ["#140c24", "#7a4a8c", "#ffcf7a"],
      ["#0b1f1a", "#2e6b4f", "#e0f0b0"],
    ],
  },
  horror: {
    type: ["gothic", "folk", "blackletter", "grenze"],
    grade: ["crimson", "noir", "moonlit"],
    scenes: ["forest"],
    palettes: [
      ["#08090c", "#3a1418", "#c9b9a0"],
      ["#05080a", "#1f3a3a", "#b8c4b0"],
    ],
  },
  romance: {
    type: ["romance-script", "parisienne", "romance-serif", "italiana"],
    grade: ["warm-gold", "dusk", "pastel"],
    scenes: ["bokeh", "sea"],
    palettes: [
      ["#2a0f22", "#c0587e", "#ffd3a5"],
      ["#2b1a10", "#c47a4a", "#ffe3b8"],
    ],
  },
  "action-adventure": {
    type: ["steel", "impact", "condensed"],
    grade: ["teal-orange", "desert-amber"],
    scenes: ["ridges", "city"],
    palettes: [
      ["#0f1a22", "#a4552a", "#ffc27a"],
      ["#101820", "#5a6a40", "#f0d090"],
    ],
  },
  documentary: {
    type: ["doc", "manrope", "barlow"],
    grade: ["natural", "ocean"],
    scenes: ["sea", "ridges"],
    palettes: [
      ["#06263d", "#2f7f9a", "#e6f4f1"],
      ["#1c2a1c", "#5f7f4f", "#f0e8c0"],
    ],
  },
  animation: {
    type: ["playful", "chewy", "baloo"],
    grade: ["vivid"],
    scenes: ["ridges", "bokeh"],
    palettes: [
      ["#1a1446", "#3fa7ff", "#ffe066"],
      ["#3a1d5c", "#ff6f91", "#ffd36e"],
    ],
  },
  "kids-family": {
    type: ["rounded", "playful", "baloo", "chewy"],
    grade: ["vivid", "pastel"],
    scenes: ["ridges", "sea"],
    palettes: [
      ["#3a7bd5", "#7ed957", "#fff3b0"],
      ["#5a3fd8", "#ff8fab", "#fff1a8"],
    ],
  },
  historical: {
    type: ["prestige-serif", "epic", "marcellus", "deco-thin"],
    grade: ["sepia", "bleach"],
    scenes: ["ridges", "sea"],
    palettes: [
      ["#1d140c", "#7a5a3a", "#f0d9a8"],
      ["#141414", "#5a5048", "#e8dcc0"],
    ],
  },
  reality: {
    type: ["reality", "archivo-black", "orbit"],
    grade: ["vivid"],
    scenes: ["bokeh", "city"],
    palettes: [
      ["#1d0b3a", "#ff3d7f", "#ffd23f"],
      ["#0b2a3a", "#00b4d8", "#ffe66d"],
    ],
  },
  "short-films": {
    type: ["indie", "grotesk", "italiana"],
    grade: ["pastel", "natural"],
    scenes: ["sea", "ridges"],
    palettes: [
      ["#14213d", "#fca311", "#e5e5e5"],
      ["#2b2d42", "#8d99ae", "#edf2f4"],
    ],
  },
};

function pick<T>(values: readonly T[], seed: number, salt: number): T {
  return values[(seed + salt) % values.length] as T;
}

export function resolveDirection(
  title: TitleSeed,
  genreSlugs: readonly string[],
  photos: ReadonlyMap<string, PhotoRecord>,
  filmUrlFor: (title: TitleSeed, assetId?: string) => string | null,
): ResolvedDirection {
  const art = ArtDirection.parse(title.art ?? {});
  const seed = Number.parseInt(sha256(title.id).slice(0, 8), 16);
  const looks =
    GENRE_LOOKS[genreSlugs[0] ?? "drama"] ?? (GENRE_LOOKS.drama as (typeof GENRE_LOOKS)[string]);
  const slug = title.id.replace(/^t-/, "");

  const keyPhoto = photos.get(art.photo ?? `${slug}-1`);
  const fallback = {
    kind: "procedural" as const,
    scene: pick(looks.scenes, seed, 2),
    palette: pick(looks.palettes, seed, 3),
    seed: seed % 100000,
  };
  // Two extra photos per series plus the key photo, cut several ways, cover a season's stills.
  const stillIds = art.stills ?? [2, 3].map((n) => `${slug}-${n}`);
  const stills = stillIds
    .map((id) => photos.get(id))
    .filter((photo): photo is PhotoRecord => !!photo);

  const filmUrl = art.frames ? filmUrlFor(title, art.frames.asset) : null;
  let source: ResolvedDirection["source"];
  if (art.frames && filmUrl) {
    source = {
      kind: "frames",
      filmUrl,
      key: art.frames.key,
      poster: art.frames.poster ?? art.frames.key,
    };
  } else if (keyPhoto && !art.procedural) {
    source = { kind: "photo", photo: keyPhoto };
  } else {
    source = { ...fallback, ...(art.procedural ?? {}) };
  }

  const typeName = art.type && art.type in TYPE_STYLES ? art.type : pick(looks.type, seed, 0);
  const gradeName = art.grade && art.grade in GRADES ? art.grade : pick(looks.grade, seed, 1);
  const focus = art.focus ?? [0.5, 0.45];
  return {
    source,
    fallback,
    stills,
    focus,
    posterFocus: art.posterFocus ?? focus,
    grade: resolveGrade(gradeName, (art.gradeOverrides ?? {}) as Partial<Grade>),
    gradeName,
    type: typeStyle(typeName, (art.typeOverrides ?? {}) as Partial<TreatmentStyle>),
    typeName,
    card: art.card ?? (typeStyle(typeName).align === "center" ? "bottom-center" : "bottom-left"),
    poster: art.poster ?? "bottom",
    flip: art.flip ?? false,
    seed,
  };
}
