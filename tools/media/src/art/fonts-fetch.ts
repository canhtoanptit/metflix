/**
 * `webflix-media fetch-fonts`: download the static font instances listed in
 * `fonts/fonts.json` plus each family's licence text from the Google Fonts repository. The
 * results are committed, so the pipeline never needs the network for typography. Run it only
 * when adding a font.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FONTS_DIR } from "../paths.ts";
import { exists, writeFileAtomic } from "../util/fs.ts";
import { log } from "../util/log.ts";
import { fetchText } from "../util/net.ts";

export interface FontEntry {
  id: string;
  family: string;
  weight: number;
  italic?: boolean;
}

export interface FontRegistry {
  fonts: FontEntry[];
}

export async function readFontRegistry(): Promise<FontRegistry> {
  return JSON.parse(await readFile(join(FONTS_DIR, "fonts.json"), "utf8")) as FontRegistry;
}

export const fontFile = (font: FontEntry) => join(FONTS_DIR, `${font.id}.ttf`);
export const familyDir = (family: string) => family.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function fetchFonts(): Promise<number> {
  const registry = await readFontRegistry();
  for (const font of registry.fonts) {
    const target = fontFile(font);
    if (!(await exists(target))) {
      const spec = `${font.family.replaceAll(" ", "+")}:${font.weight}${font.italic ? "i" : ""}`;
      // The v1 CSS API answers plain clients with static TrueType instances.
      const response = await fetch(`https://fonts.googleapis.com/css?family=${spec}`, {
        headers: { "User-Agent": "curl/8" },
      });
      const css = await response.text();
      const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
      if (!url) throw new Error(`No TrueType instance for ${spec}:\n${css.slice(0, 300)}`);
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      await writeFileAtomic(target, bytes);
      log.info(`font ${font.id} (${bytes.byteLength} bytes)`);
    }
    const licenseTarget = join(FONTS_DIR, "licenses", `${familyDir(font.family)}.txt`);
    if (await exists(licenseTarget)) continue;
    let license: string | null = null;
    for (const [dir, file] of [
      ["ofl", "OFL.txt"],
      ["apache", "LICENSE.txt"],
      ["ufl", "LICENCE.txt"],
    ] as const) {
      try {
        license = await fetchText(
          `https://raw.githubusercontent.com/google/fonts/main/${dir}/${familyDir(font.family)}/${file}`,
        );
        break;
      } catch {
        license = null;
      }
    }
    if (!license) throw new Error(`No licence text found for ${font.family}`);
    await writeFileAtomic(licenseTarget, license);
  }
  return 0;
}
