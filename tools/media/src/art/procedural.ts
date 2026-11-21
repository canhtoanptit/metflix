/**
 * Procedural key art, rendered pixel by pixel from seeded noise: the offline fallback when a
 * photo cannot be fetched, and the look of a few titles (space, abstract light). Everything is
 * deterministic for a given seed, so re-renders are byte-identical.
 */
import { hexToRgb } from "./grade.ts";

export const SCENES = ["nebula", "planet", "ridges", "forest", "city", "sea", "bokeh"] as const;
export type Scene = (typeof SCENES)[number];

type RGB = [number, number, number];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < octaves; o += 1) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 31);
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : Math.min(v, 1));
const smooth = (e0: number, e1: number, v: number) => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];

function ramp(colors: readonly RGB[], t: number): RGB {
  const clamped = clamp01(t) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(clamped));
  return mixRgb(colors[index] as RGB, colors[index + 1] as RGB, clamped - index);
}

class Canvas {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height * 3);
  }
  set(x: number, y: number, c: RGB) {
    const i = (y * this.width + x) * 3;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
  }
  get(x: number, y: number): RGB {
    const i = (y * this.width + x) * 3;
    return [this.data[i] ?? 0, this.data[i + 1] ?? 0, this.data[i + 2] ?? 0];
  }
  add(x: number, y: number, c: RGB, a = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = (this.data[i] ?? 0) + c[0] * a;
    this.data[i + 1] = (this.data[i + 1] ?? 0) + c[1] * a;
    this.data[i + 2] = (this.data[i + 2] ?? 0) + c[2] * a;
  }
  blend(x: number, y: number, c: RGB, a: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.set(x, y, mixRgb(this.get(x, y), c, a));
  }
  /** Soft radial light (additive). */
  glow(cx: number, cy: number, radius: number, c: RGB, strength: number) {
    const r = Math.ceil(radius * 2.5);
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(this.height, cy + r); y += 1) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(this.width, cx + r); x += 1) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        this.add(x, y, c, strength * Math.exp(-d * d));
      }
    }
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.width * this.height * 3);
    for (let i = 0; i < out.length; i += 1) out[i] = Math.round(clamp01(this.data[i] ?? 0) * 255);
    return out;
  }
}

function stars(canvas: Canvas, rand: () => number, density: number, horizon = 1) {
  const count = Math.floor(canvas.width * canvas.height * density);
  for (let s = 0; s < count; s += 1) {
    const x = Math.floor(rand() * canvas.width);
    const y = Math.floor(rand() * canvas.height * horizon);
    const b = rand() ** 3;
    const tint: RGB = rand() < 0.2 ? [1, 0.85, 0.7] : rand() < 0.3 ? [0.75, 0.85, 1] : [1, 1, 1];
    canvas.add(x, y, tint, 0.35 + b * 0.9);
    if (b > 0.85) canvas.glow(x, y, 2 + b * 3, tint, 0.25);
  }
}

function skyGradient(canvas: Canvas, top: RGB, horizon: RGB, horizonY: number) {
  for (let y = 0; y < canvas.height; y += 1) {
    const t = smooth(0, horizonY, y);
    const c = mixRgb(top, horizon, t ** 1.6);
    for (let x = 0; x < canvas.width; x += 1) canvas.set(x, y, c);
  }
}

export interface ProceduralOptions {
  scene: Scene;
  /** Three colours: deep, mid, bright. */
  palette: readonly [string, string, string];
  seed: number;
  /** Where the subject sits (0-1), so crops can keep it. */
  focus?: readonly [number, number];
}

export function renderScene(width: number, height: number, options: ProceduralOptions): Uint8Array {
  const canvas = new Canvas(width, height);
  const rand = mulberry32(options.seed);
  const [deep, mid, bright] = options.palette.map(hexToRgb) as [RGB, RGB, RGB];
  const [fx, fy] = options.focus ?? [0.66, 0.45];
  const s = width / 1920;

  switch (options.scene) {
    case "nebula":
    case "planet": {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const nx = x / (520 * s);
          const ny = y / (520 * s);
          const warp = fbm(nx + 3.1, ny - 1.7, options.seed + 5, 4);
          const n = fbm(nx + warp * 1.8, ny + warp * 1.2, options.seed, 6);
          const dust = smooth(0.42, 0.78, n);
          const c = ramp(
            [[0.01, 0.01, 0.02], deep, mid, bright],
            dust * (options.scene === "planet" ? 0.55 : 0.95),
          );
          canvas.set(x, y, c);
        }
      }
      stars(canvas, rand, 0.0009);
      if (options.scene === "planet") {
        const radius = height * 0.62;
        const cx = width * fx;
        const cy = height * (fy + 0.55);
        const light: [number, number, number] = [-0.55, -0.6, 0.58];
        for (let y = Math.max(0, Math.floor(cy - radius)); y < height; y += 1) {
          for (
            let x = Math.max(0, Math.floor(cx - radius));
            x < Math.min(width, cx + radius);
            x += 1
          ) {
            const dx = (x - cx) / radius;
            const dy = (y - cy) / radius;
            const d2 = dx * dx + dy * dy;
            if (d2 > 1) {
              const rim = Math.exp(-(Math.sqrt(d2) - 1) * 28);
              canvas.add(x, y, bright, rim * 0.55);
              continue;
            }
            const dz = Math.sqrt(1 - d2);
            const lambert = clamp01(dx * light[0] + dy * light[1] + dz * light[2]);
            const bands = fbm(dx * 3 + 10, dy * 14, options.seed + 9, 5);
            const surface = ramp([deep, mid, bright], bands);
            const c = mixRgb([0, 0, 0], surface, lambert ** 0.8);
            const atmosphere = (1 - dz) ** 3 * lambert;
            canvas.set(x, y, [
              c[0] + bright[0] * atmosphere * 0.6,
              c[1] + bright[1] * atmosphere * 0.6,
              c[2] + bright[2] * atmosphere * 0.6,
            ]);
          }
        }
      } else {
        canvas.glow(width * fx, height * fy, 220 * s, bright, 0.35);
      }
      break;
    }
    case "ridges": {
      const horizon = height * 0.62;
      skyGradient(canvas, deep, bright, horizon);
      canvas.glow(width * fx, horizon * 0.72, 90 * s, [1, 0.95, 0.85], 0.9);
      canvas.glow(width * fx, horizon * 0.72, 380 * s, bright, 0.35);
      const layers = 5;
      for (let layer = 0; layer < layers; layer += 1) {
        const depth = layer / (layers - 1);
        const base = horizon + depth * height * 0.32 - height * 0.12;
        const amp = height * (0.12 + depth * 0.1);
        const color = mixRgb(
          mixRgb(bright, mid, 0.45),
          [deep[0] * 0.3, deep[1] * 0.3, deep[2] * 0.3],
          depth ** 0.7,
        );
        for (let x = 0; x < width; x += 1) {
          const ridge =
            base - amp * fbm(x / (700 * s) + layer * 7.3, layer * 3.1, options.seed + layer, 6);
          for (let y = Math.max(0, Math.floor(ridge)); y < height; y += 1) {
            const fog = smooth(0, height * 0.2, y - ridge) * 0.15 * (1 - depth);
            canvas.set(x, y, mixRgb(color, bright, fog));
          }
        }
      }
      break;
    }
    case "forest": {
      const horizon = height * 0.7;
      skyGradient(canvas, mixRgb(deep, mid, 0.35), mixRgb(mid, bright, 0.55), horizon);
      // A low moon or sun behind the trees, and haze around it.
      canvas.glow(width * fx, height * 0.36, 70 * s, [1, 0.97, 0.9], 0.85);
      canvas.glow(width * fx, height * 0.4, 420 * s, bright, 0.45);
      for (let layer = 0; layer < 5; layer += 1) {
        const depth = layer / 4;
        // Far rows fade into the haze, near rows are near-black silhouettes.
        const color = mixRgb(
          mixRgb(mid, bright, 0.35),
          [0.01, 0.015, 0.02],
          0.12 + depth ** 1.4 * 0.88,
        );
        const treeCount = Math.floor((16 + layer * 6) * (width / 1920));
        const baseY = height * (0.6 + depth * 0.22);
        // Ground: a gently rolling band under each row of trees.
        for (let x = 0; x < width; x += 1) {
          const ground =
            baseY - height * 0.03 * fbm(x / (500 * s), layer * 4.1, options.seed + layer, 3);
          for (let y = Math.max(0, Math.floor(ground)); y < height; y += 1) canvas.set(x, y, color);
        }
        for (let t = 0; t < treeCount; t += 1) {
          const tx = rand() * width;
          const th = height * (0.15 + rand() * 0.2) * (0.75 + depth * 0.55);
          const tw = th * (0.22 + rand() * 0.08);
          for (let y = Math.floor(baseY - th); y < baseY + height * 0.02; y += 1) {
            const p = (y - (baseY - th)) / th;
            const half = Math.min(1, p) * tw * (0.85 + 0.15 * Math.sin(p * 40));
            for (let x = Math.floor(tx - half); x < tx + half; x += 1) canvas.blend(x, y, color, 1);
          }
        }
        // Fog between layers.
        for (
          let y = Math.floor(baseY - height * 0.15);
          y < Math.min(height, baseY + height * 0.1);
          y += 1
        ) {
          for (let x = 0; x < width; x += 1) {
            const fog =
              smooth(height * 0.15, 0, Math.abs(y - baseY)) *
              0.32 *
              fbm(x / (400 * s), y / (120 * s), options.seed + layer, 3);
            canvas.blend(x, y, bright, fog);
          }
        }
      }
      break;
    }
    case "city": {
      const horizon = height * 0.68;
      skyGradient(canvas, deep, mixRgb(mid, bright, 0.5), horizon);
      // Street level below the skyline, so gaps between towers never show sky.
      for (let y = Math.floor(horizon); y < height; y += 1) {
        for (let x = 0; x < width; x += 1) canvas.set(x, y, mixRgb(deep, [0, 0, 0], 0.75));
      }
      let x = 0;
      while (x < width) {
        const w = Math.floor((40 + rand() * 120) * s);
        const h = height * (0.15 + rand() ** 2 * 0.5);
        const top = horizon - h;
        const color = mixRgb(deep, [0, 0, 0], 0.65);
        for (let yy = Math.floor(top); yy < height; yy += 1) {
          for (let xx = x; xx < Math.min(width, x + w); xx += 1) canvas.set(xx, yy, color);
        }
        for (let wy = Math.floor(top + 8 * s); wy < horizon; wy += Math.floor(14 * s)) {
          for (let wx = x + Math.floor(5 * s); wx < x + w - 6 * s; wx += Math.floor(11 * s)) {
            if (rand() < 0.42) {
              const lit = rand() < 0.8 ? bright : mid;
              for (let dy = 0; dy < 6 * s; dy += 1)
                for (let dx = 0; dx < 5 * s; dx += 1) canvas.blend(wx + dx, wy + dy, lit, 0.85);
            }
          }
        }
        x += w + Math.floor(rand() * 6 * s);
      }
      for (let b = 0; b < 40; b += 1)
        canvas.glow(
          rand() * width,
          horizon + rand() * height * 0.3,
          (14 + rand() * 40) * s,
          rand() < 0.5 ? bright : mid,
          0.25,
        );
      break;
    }
    case "sea": {
      const horizon = height * 0.52;
      skyGradient(canvas, deep, bright, horizon);
      canvas.glow(width * fx, horizon - 30 * s, 70 * s, [1, 0.96, 0.88], 1);
      canvas.glow(width * fx, horizon, 420 * s, bright, 0.4);
      for (let y = Math.floor(horizon); y < height; y += 1) {
        const depth = (y - horizon) / (height - horizon);
        for (let xx = 0; xx < width; xx += 1) {
          const wave = fbm(
            xx / (260 * s),
            (y - horizon) / (9 * s * (1 + depth * 6)),
            options.seed,
            4,
          );
          const base = mixRgb(mixRgb(bright, mid, 0.6), deep, depth ** 0.6);
          const glitter =
            Math.exp(-(((xx - width * fx) / (width * (0.05 + depth * 0.25))) ** 2)) *
            smooth(0.55, 0.75, wave) *
            (1 - depth * 0.6);
          canvas.set(xx, y, mixRgb(base, [1, 0.95, 0.85], clamp01(glitter + (wave - 0.5) * 0.12)));
        }
      }
      break;
    }
    case "bokeh": {
      for (let y = 0; y < height; y += 1) {
        for (let xx = 0; xx < width; xx += 1) {
          const n = fbm(xx / (900 * s), y / (900 * s), options.seed, 3);
          canvas.set(xx, y, mixRgb([deep[0] * 0.5, deep[1] * 0.5, deep[2] * 0.5], mid, n * 0.6));
        }
      }
      for (let b = 0; b < 70; b += 1) {
        const r = (20 + rand() ** 2 * 120) * s;
        const bx = rand() * width;
        const by = rand() * height;
        const c = rand() < 0.5 ? bright : mid;
        const a = 0.12 + rand() * 0.25;
        for (let y = Math.max(0, Math.floor(by - r)); y < Math.min(height, by + r); y += 1) {
          for (let xx = Math.max(0, Math.floor(bx - r)); xx < Math.min(width, bx + r); xx += 1) {
            const d = Math.hypot(xx - bx, y - by) / r;
            if (d <= 1) canvas.add(xx, y, c, a * (0.75 + 0.25 * d) * smooth(1, 0.92, d));
          }
        }
      }
      break;
    }
  }
  return canvas.toBytes();
}
