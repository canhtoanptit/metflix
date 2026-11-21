#!/usr/bin/env node
/**
 * webflix-media: offline media pipeline (artwork generation, HLS packaging, upload).
 * ffmpeg runs in Docker; nothing here transcodes in a request path (blueprint §2.4, §7).
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MEDIA_PROFILES, MediaManifest, type MediaProfile } from "@webflix/contracts";

const USAGE = `Usage: webflix-media <command> [options]

Build
  build --profile fast|full      Render artwork, package video, write and validate the manifest
        [--only id,id]           Limit to some titles / video assets (development)
        [--skip-video] [--skip-art]
  upload --profile fast|full     Push the profile tree + manifest through the BlobStore port
        [--target fs:]           Target spec (default fs: → WEBFLIX_BLOB_DIR or .data/blobs)
        [--prune] [--concurrency 16]
  validate-manifest <file>       Check a manifest.json against the MediaManifest contract

Review
  contact-sheets --profile fast  Render review sheets to .cache/media/review/<profile>/
                                 (rows, billboards, posters, logos, episodes, avatars, previews)
  check-art --profile fast       Perceptual-hash check: no shared backdrops/posters across titles,
                                 no repeated still within a series (exit 1 if any)
  review --profile fast          Serve a review page with the player (port 4400)
  status                         Cache sizes and what each profile holds

Sources
  photos fetch                   Download every pinned photo (slowly; Wikimedia throttles)
  photos auto [titleId…]         Pin Commons photos for titles in sources/photo-queries.json
  photos search "<query>"        Numbered candidate sheet for a query
  photos pick <photoId> "<query>" <n>
  fetch-fonts                    Download fonts listed in fonts/fonts.json (committed)
  credits                        Regenerate docs/CREDITS.md

Housekeeping
  clean --profile fast|full      Delete a profile's packaged output (keeps downloads and art)
  help                           Show this message

Environment
  WEBFLIX_MEDIA_OFFLINE=1        Never use the network: cached sources or synthetic fallbacks
  WEBFLIX_BLOB_DIR=<dir>         Dev blob store root for the fs: target
  WEBFLIX_MEDIA_PHOTO_BUDGET_SEC Time a build spends fetching photos (default 600)
`;

function profileOf(value: string | undefined): MediaProfile {
  const profile = value ?? "fast";
  if (!(MEDIA_PROFILES as readonly string[]).includes(profile)) {
    throw new UsageError(`Unknown profile "${profile}" (expected ${MEDIA_PROFILES.join(" or ")})`);
  }
  return profile as MediaProfile;
}

class UsageError extends Error {}

async function validateManifest(file: string): Promise<number> {
  const result = MediaManifest.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (result.success) {
    const { videoAssets, titleArtwork, episodeStills, avatars } = result.data;
    // When the packaged files sit next to the manifest (.cache/media/<profile>), check their
    // timing too: every rendition starts at 0, audio with video, segments add up.
    const root = dirname(resolve(file));
    const problems: string[] = [];
    let checked = 0;
    if (videoAssets[0] && existsSync(join(root, videoAssets[0].master))) {
      const { checkTiming } = await import("./video/validate.ts");
      for (const asset of videoAssets) {
        problems.push(...(await checkTiming(root, asset)).problems);
        checked += 1;
      }
    }
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) return 1;
    console.log(
      `ok: ${videoAssets.length} video assets${checked ? ` (timing checked: every rendition starts at 0, audio with video, segments add up)` : ""}, ${titleArtwork.length} titles with artwork, ${episodeStills.length} episode stills, ${avatars.length} avatars`,
    );
    return 0;
  }
  for (const issue of result.error.issues) {
    console.error(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      profile: { type: "string" },
      only: { type: "string" },
      target: { type: "string" },
      prune: { type: "boolean" },
      concurrency: { type: "string" },
      port: { type: "string" },
      "skip-video": { type: "boolean" },
      "skip-art": { type: "boolean" },
    },
  });
  const [command, ...rest] = positionals;
  try {
    switch (command) {
      case "validate-manifest": {
        const [file] = rest;
        if (!file) {
          console.error(USAGE);
          return 2;
        }
        return await validateManifest(file);
      }
      case "build": {
        const { build } = await import("./build.ts");
        return await build(profileOf(values.profile), {
          only: values.only?.split(",").filter(Boolean),
          skipVideo: values["skip-video"] ?? false,
          skipArt: values["skip-art"] ?? false,
        });
      }
      case "upload": {
        const { openTarget } = await import("./upload/targets.ts");
        const { uploadProfile } = await import("./upload/upload.ts");
        const target = values.target ?? process.env.WEBFLIX_MEDIA_TARGET ?? "fs:";
        const store = await openTarget(target);
        await uploadProfile(profileOf(values.profile), store, target, {
          prune: values.prune ?? false,
          concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        });
        return 0;
      }
      case "contact-sheets": {
        const { contactSheets } = await import("./review/sheets.ts");
        return await contactSheets(profileOf(values.profile));
      }
      case "check-art": {
        const { runArtCheck } = await import("./review/check.ts");
        return await runArtCheck(profileOf(values.profile));
      }
      case "review": {
        const { serveReview } = await import("./review/server.ts");
        return await serveReview(profileOf(values.profile), Number(values.port ?? 4400));
      }
      case "status": {
        const { status } = await import("./status.ts");
        return await status();
      }
      case "photos": {
        const curate = await import("./art/curate.ts");
        const [action, ...args] = rest;
        if (action === "auto") return await curate.autoPick(args);
        if (action === "fetch") {
          const { fetchPhotos, readPhotoLibrary } = await import("./art/photos.ts");
          const library = await readPhotoLibrary();
          const result = await fetchPhotos(
            library.map((record) => ({ record, role: /-1$/.test(record.id) ? "key" : "still" })),
            Number.POSITIVE_INFINITY,
          );
          console.log(
            `photos: ${result.fetched} fetched, ${result.cached} cached, ${result.pending.length} pending`,
          );
          return result.pending.length > 0 ? 1 : 0;
        }
        if (action === "search" && args[0]) return await curate.searchSheet(args[0]);
        if (action === "pick" && args[0] && args[1] && args[2]) {
          return await curate.pick(args[0], args[1], Number(args[2]));
        }
        throw new UsageError("photos auto | search <query> | pick <photoId> <query> <n>");
      }
      case "fetch-fonts": {
        const { fetchFonts } = await import("./art/fonts-fetch.ts");
        return await fetchFonts();
      }
      case "credits": {
        const { writeCredits } = await import("./credits.ts");
        return await writeCredits();
      }
      case "clean": {
        const profile = profileOf(values.profile);
        const { mediaCacheDir, workDir } = await import("./paths.ts");
        await rm(mediaCacheDir(profile), { recursive: true, force: true });
        await rm(workDir(profile), { recursive: true, force: true });
        console.log(`removed ${profile} output`);
        return 0;
      }
      case undefined:
      case "help":
        console.log(USAGE);
        return 0;
      default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
