/**
 * Preview checks for `validate-manifest` (they decode, so they need Docker): every preview
 * declares `kind` and `hasAudio`; the kind matches how the catalog made the clip (motion art
 * from key art, or footage); `hasAudio` agrees with the measured audio (a clip that declares
 * sound is audible, one that declares none is digitally silent); and every motion-art clip
 * starts and ends on the title's published backdrop still.
 */
import { join } from "node:path";
import {
  fillImageTemplate,
  type MediaManifest,
  type TitleSeed,
  type VideoAssetSeed,
} from "@webflix/contracts";
import { mapPool } from "../util/pool.ts";
import { audioDisagreement, checkMotionEdges, measureAudio } from "./preview-check.ts";

export interface PreviewReport {
  checked: number;
  motion: number;
  footageWithSound: number;
  footageSilent: number;
  problems: string[];
}

export async function checkPreviews(
  root: string,
  manifest: MediaManifest,
  catalog: { titles: readonly TitleSeed[]; videoAssets: readonly VideoAssetSeed[] },
  work: string,
): Promise<PreviewReport> {
  const seeds = new Map(catalog.videoAssets.map((seed) => [seed.id, seed]));
  const previewedBy = new Map(catalog.titles.map((title) => [title.previewAssetId, title.id]));
  const artwork = new Map(manifest.titleArtwork.map((art) => [art.titleId, art]));
  const report: PreviewReport = {
    checked: 0,
    motion: 0,
    footageWithSound: 0,
    footageSilent: 0,
    problems: [],
  };
  const withPreview = manifest.videoAssets.filter((asset) => asset.preview);
  await mapPool(withPreview, 6, async (asset) => {
    const preview = asset.preview;
    if (!preview) return;
    const problem = (text: string) => report.problems.push(`${asset.assetId}/preview.mp4: ${text}`);
    const file = join(root, preview.key);
    if (preview.kind === undefined || preview.hasAudio === undefined)
      problem("does not declare kind and hasAudio");
    const seed = seeds.get(asset.assetId);
    const madeAsMotion = seed?.source.kind === "synthetic";
    if (seed && (preview.kind === "motion") !== madeAsMotion)
      problem(
        `declares kind ${preview.kind ?? "(absent: footage)"}, but the catalog made it as ${madeAsMotion ? "motion art" : "footage"}`,
      );

    const audio = await measureAudio(file);
    const disagreement = audioDisagreement(preview.hasAudio, audio);
    if (disagreement) problem(disagreement);

    if (preview.kind === "motion") {
      report.motion += 1;
      if (preview.hasAudio !== false) problem("motion art must declare hasAudio: false");
      const titleId = previewedBy.get(asset.assetId);
      const art = titleId ? artwork.get(titleId) : undefined;
      if (!art) {
        problem("no title with backdrop art previews this clip");
      } else {
        const width = Math.max(...art.backdrop.widths);
        const still = join(root, fillImageTemplate(art.backdrop.keyTemplate, width, "webp"));
        const edges = await checkMotionEdges(file, still, join(work, asset.assetId));
        for (const text of edges.problems) problem(text);
      }
    } else if (preview.hasAudio === false) {
      report.footageSilent += 1;
    } else {
      report.footageWithSound += 1;
    }
    report.checked += 1;
  });
  report.problems.sort();
  return report;
}
