/**
 * Original profile avatars: flat, friendly characters drawn as SVG from a few parameters in
 * the seed (`art: { kind, bg, face, accent, expression }`). Bold shapes and a single light
 * direction keep them readable at 32 px in the profile menu and crisp at 320 px on the gate.
 */
import type { AvatarSeed } from "@webflix/contracts";
import sharp from "sharp";
import { z } from "zod";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const AvatarArt = z.object({
  kind: z.enum([
    "smiley",
    "cat",
    "bear",
    "fox",
    "owl",
    "frog",
    "robot",
    "alien",
    "ghost",
    "monster",
    "astronaut",
    "panda",
  ]),
  bg: Hex,
  face: Hex,
  accent: Hex,
  expression: z.enum(["smile", "grin", "wink", "wow", "cool", "calm", "laugh"]).default("smile"),
});
export type AvatarArt = z.output<typeof AvatarArt>;

const INK = "#1b1b22";

function shade(hex: string, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) => {
    const c = (value >> shift) & 255;
    const next = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
    return Math.round(Math.min(255, Math.max(0, next)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

function eyes(
  expression: AvatarArt["expression"],
  y: number,
  spread: number,
  size: number,
  color = INK,
): string {
  const left = 160 - spread;
  const right = 160 + spread;
  switch (expression) {
    case "wink":
      return `<circle cx="${left}" cy="${y}" r="${size}" fill="${color}"/><path d="M${right - size * 1.3} ${y} q${size * 1.3} ${-size * 1.4} ${size * 2.6} 0" stroke="${color}" stroke-width="${size * 0.7}" fill="none" stroke-linecap="round"/>`;
    case "cool":
      return `<rect x="${left - size * 2.2}" y="${y - size * 1.4}" width="${spread * 2 + size * 4.4}" height="${size * 0.8}" rx="${size * 0.4}" fill="${INK}"/><rect x="${left - size * 2}" y="${y - size * 1.1}" width="${size * 4}" height="${size * 2.6}" rx="${size * 1.1}" fill="${INK}"/><rect x="${right - size * 2}" y="${y - size * 1.1}" width="${size * 4}" height="${size * 2.6}" rx="${size * 1.1}" fill="${INK}"/><rect x="${left - size * 1.3}" y="${y - size * 0.6}" width="${size * 1.2}" height="${size * 0.6}" rx="${size * 0.3}" fill="#ffffff" opacity="0.5"/>`;
    case "calm":
      return `<path d="M${left - size * 1.3} ${y} q${size * 1.3} ${size * 1.3} ${size * 2.6} 0 M${right - size * 1.3} ${y} q${size * 1.3} ${size * 1.3} ${size * 2.6} 0" stroke="${color}" stroke-width="${size * 0.7}" fill="none" stroke-linecap="round"/>`;
    case "laugh":
      return `<path d="M${left - size * 1.3} ${y + size * 0.4} q${size * 1.3} ${-size * 1.6} ${size * 2.6} 0 M${right - size * 1.3} ${y + size * 0.4} q${size * 1.3} ${-size * 1.6} ${size * 2.6} 0" stroke="${color}" stroke-width="${size * 0.7}" fill="none" stroke-linecap="round"/>`;
    case "wow":
      return `<circle cx="${left}" cy="${y}" r="${size * 1.35}" fill="#ffffff"/><circle cx="${right}" cy="${y}" r="${size * 1.35}" fill="#ffffff"/><circle cx="${left}" cy="${y}" r="${size * 0.8}" fill="${color}"/><circle cx="${right}" cy="${y}" r="${size * 0.8}" fill="${color}"/>`;
    default:
      return `<circle cx="${left}" cy="${y}" r="${size}" fill="${color}"/><circle cx="${right}" cy="${y}" r="${size}" fill="${color}"/><circle cx="${left + size * 0.35}" cy="${y - size * 0.35}" r="${size * 0.32}" fill="#ffffff"/><circle cx="${right + size * 0.35}" cy="${y - size * 0.35}" r="${size * 0.32}" fill="#ffffff"/>`;
  }
}

function mouth(
  expression: AvatarArt["expression"],
  y: number,
  width: number,
  accent: string,
): string {
  switch (expression) {
    case "grin":
    case "laugh":
      return `<path d="M${160 - width} ${y} q${width} ${width * 1.1} ${width * 2} 0 z" fill="${INK}"/><path d="M${160 - width * 0.55} ${y + width * 0.45} q${width * 0.55} ${width * 0.4} ${width * 1.1} 0" fill="${accent}"/>`;
    case "wow":
      return `<ellipse cx="160" cy="${y + width * 0.25}" rx="${width * 0.32}" ry="${width * 0.42}" fill="${INK}"/>`;
    case "calm":
      return `<path d="M${160 - width * 0.5} ${y} q${width * 0.5} ${width * 0.35} ${width} 0" stroke="${INK}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
    default:
      return `<path d="M${160 - width * 0.75} ${y} q${width * 0.75} ${width * 0.8} ${width * 1.5} 0" stroke="${INK}" stroke-width="9" fill="none" stroke-linecap="round"/>`;
  }
}

function cheeks(y: number, spread: number, color: string): string {
  return `<ellipse cx="${160 - spread}" cy="${y}" rx="17" ry="11" fill="${color}" opacity="0.45"/><ellipse cx="${160 + spread}" cy="${y}" rx="17" ry="11" fill="${color}" opacity="0.45"/>`;
}

function character(art: AvatarArt): string {
  const { face, accent, expression } = art;
  const dark = shade(face, -0.18);
  const light = shade(face, 0.25);
  switch (art.kind) {
    case "cat":
      return `<path d="M70 150 L80 60 L135 105 Z" fill="${face}"/><path d="M250 150 L240 60 L185 105 Z" fill="${face}"/><path d="M88 125 L93 85 L122 108 Z" fill="${accent}"/><path d="M232 125 L227 85 L198 108 Z" fill="${accent}"/><ellipse cx="160" cy="185" rx="105" ry="95" fill="${face}"/><ellipse cx="160" cy="215" rx="70" ry="45" fill="${light}"/>${eyes(expression, 172, 42, 11)}<path d="M150 200 h20 l-10 10 z" fill="${accent}"/>${mouth(expression, 218, 22, accent)}<path d="M60 205 h50 M60 222 h48 M260 205 h-50 M260 222 h-48" stroke="${INK}" stroke-width="3.5" stroke-linecap="round" opacity="0.5"/>`;
    case "bear":
    case "panda":
      return `<circle cx="88" cy="95" r="38" fill="${art.kind === "panda" ? INK : face}"/><circle cx="232" cy="95" r="38" fill="${art.kind === "panda" ? INK : face}"/><circle cx="88" cy="95" r="18" fill="${accent}"/><circle cx="232" cy="95" r="18" fill="${accent}"/><circle cx="160" cy="180" r="108" fill="${face}"/>${art.kind === "panda" ? `<ellipse cx="118" cy="168" rx="26" ry="32" fill="${INK}" transform="rotate(-20 118 168)"/><ellipse cx="202" cy="168" rx="26" ry="32" fill="${INK}" transform="rotate(20 202 168)"/>` : ""}<ellipse cx="160" cy="220" rx="48" ry="36" fill="${light}"/>${eyes(expression, 168, 42, 10, art.kind === "panda" ? "#ffffff" : INK)}<ellipse cx="160" cy="204" rx="15" ry="10" fill="${INK}"/>${mouth(expression, 226, 18, accent)}`;
    case "fox":
      return `<path d="M58 70 L120 120 L80 190 Z" fill="${face}"/><path d="M262 70 L200 120 L240 190 Z" fill="${face}"/><path d="M160 290 C 70 290 50 200 60 150 C 90 120 230 120 260 150 C 270 200 250 290 160 290 Z" fill="${face}"/><path d="M160 290 C 110 290 85 245 95 215 C 125 230 195 230 225 215 C 235 245 210 290 160 290 Z" fill="#fff6ea"/>${eyes(expression, 178, 44, 10)}<ellipse cx="160" cy="236" rx="13" ry="9" fill="${INK}"/>${cheeks(205, 66, accent)}`;
    case "owl":
      return `<path d="M60 110 L95 60 L120 100 Z M260 110 L225 60 L200 100 Z" fill="${dark}"/><ellipse cx="160" cy="185" rx="110" ry="112" fill="${face}"/><ellipse cx="160" cy="235" rx="60" ry="55" fill="${light}"/><circle cx="117" cy="158" r="40" fill="#fffaf0"/><circle cx="203" cy="158" r="40" fill="#fffaf0"/>${eyes(expression, 158, 43, 15)}<path d="M148 190 L172 190 L160 215 Z" fill="${accent}"/>`;
    case "frog":
      return `<circle cx="105" cy="105" r="42" fill="${face}"/><circle cx="215" cy="105" r="42" fill="${face}"/><circle cx="105" cy="102" r="27" fill="#ffffff"/><circle cx="215" cy="102" r="27" fill="#ffffff"/>${eyes(expression, 102, 55, 13)}<ellipse cx="160" cy="200" rx="122" ry="92" fill="${face}"/><ellipse cx="160" cy="240" rx="80" ry="38" fill="${light}"/>${mouth(expression, 205, 46, accent)}${cheeks(215, 78, accent)}`;
    case "robot":
      return `<rect x="152" y="38" width="16" height="40" rx="8" fill="${dark}"/><circle cx="160" cy="36" r="16" fill="${accent}"/><rect x="58" y="76" width="204" height="190" rx="46" fill="${face}"/><rect x="78" y="112" width="164" height="96" rx="30" fill="${INK}"/>${expression === "calm" ? `<rect x="104" y="152" width="40" height="10" rx="5" fill="${accent}"/><rect x="176" y="152" width="40" height="10" rx="5" fill="${accent}"/>` : `<circle cx="124" cy="158" r="17" fill="${accent}"/><circle cx="196" cy="158" r="17" fill="${accent}"/><circle cx="130" cy="152" r="5" fill="#ffffff"/><circle cx="202" cy="152" r="5" fill="#ffffff"/>`}<rect x="122" y="226" width="76" height="14" rx="7" fill="${dark}"/><rect x="44" y="140" width="18" height="50" rx="9" fill="${dark}"/><rect x="258" y="140" width="18" height="50" rx="9" fill="${dark}"/>`;
    case "alien":
      return `<path d="M95 80 Q 80 40 60 35" stroke="${dark}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="58" cy="33" r="14" fill="${accent}"/><path d="M225 80 Q 240 40 260 35" stroke="${dark}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="262" cy="33" r="14" fill="${accent}"/><path d="M160 290 C 60 290 52 140 80 105 C 110 70 210 70 240 105 C 268 140 260 290 160 290 Z" fill="${face}"/><ellipse cx="160" cy="168" rx="50" ry="44" fill="#ffffff"/><circle cx="160" cy="170" r="${expression === "wow" ? 30 : 24}" fill="${INK}"/><circle cx="170" cy="160" r="8" fill="#ffffff"/>${mouth(expression === "wow" ? "wow" : expression, 240, 26, accent)}`;
    case "ghost":
      return `<path d="M60 290 L60 160 C60 90 105 55 160 55 C215 55 260 90 260 160 L260 290 L233 268 L206 290 L180 268 L160 290 L140 268 L114 290 L87 268 Z" fill="${face}"/>${eyes(expression, 160, 40, 14)}${mouth(expression, 205, 24, accent)}${cheeks(190, 70, accent)}`;
    case "monster":
      return `<path d="M95 90 L80 35 L125 75 Z M225 90 L240 35 L195 75 Z" fill="${accent}"/><rect x="55" y="70" width="210" height="215" rx="90" fill="${face}"/><circle cx="160" cy="150" r="46" fill="#ffffff"/><circle cx="160" cy="152" r="22" fill="${INK}"/><circle cx="168" cy="144" r="7" fill="#ffffff"/><path d="M95 215 Q 160 270 225 215 Z" fill="${INK}"/><path d="M118 222 l12 18 l12 -16 M178 222 l12 16 l12 -18" fill="#ffffff"/>`;
    case "astronaut":
      return `<circle cx="160" cy="170" r="122" fill="#eef1f5"/><circle cx="160" cy="170" r="122" fill="none" stroke="${shade("#eef1f5", -0.2)}" stroke-width="8"/><rect x="72" y="105" width="176" height="128" rx="64" fill="${INK}"/><rect x="88" y="118" width="144" height="102" rx="51" fill="${face}"/>${eyes(expression, 160, 30, 9)}${mouth(expression, 190, 16, accent)}<path d="M100 130 q 20 -14 48 -10" stroke="#ffffff" stroke-width="9" fill="none" stroke-linecap="round" opacity="0.6"/><rect x="138" y="262" width="44" height="16" rx="6" fill="${accent}"/>`;
    default:
      return `<circle cx="160" cy="168" r="118" fill="${face}"/><circle cx="160" cy="168" r="118" fill="url(#shine)"/>${eyes(expression, 145, 42, 15)}${mouth(expression, 200, 46, accent)}${cheeks(186, 76, accent)}`;
  }
}

export function avatarSvg(art: AvatarArt): string {
  const bgDark = shade(art.bg, -0.22);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${art.bg}"/><stop offset="1" stop-color="${bgDark}"/></linearGradient><radialGradient id="shine" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs><rect width="320" height="320" fill="url(#bg)"/><circle cx="270" cy="50" r="90" fill="#ffffff" opacity="0.06"/><g transform="translate(0 18)">${character(art)}</g></svg>`;
}

export async function renderAvatar(avatar: AvatarSeed): Promise<Buffer> {
  const art = AvatarArt.parse(
    avatar.art ?? { kind: "smiley", bg: "#3a6ea5", face: "#ffd166", accent: "#ef476f" },
  );
  return sharp(Buffer.from(avatarSvg(art)))
    .png()
    .toBuffer();
}
