/**
 * Immutable public keys. Preview clips are served from `public/previews/<assetId>/…` with no
 * version in the URL and cached as immutable by browsers and edges that cannot be purged, so
 * a key, once built, must never hold different bytes. Asset ids are derived from what defines
 * a clip (catalog `footagePreviewAsset`, `motionArtAsset`); this is the check that catches
 * anything the derivation misses (an encoder change without a recipe bump).
 *
 * Every build compares its unversioned public files with everything this profile has
 * published before: the ledger of earlier builds (`work/<profile>/published-public.json`),
 * the files of the previous manifest as they are on disk when the build starts, and every
 * upload record (what was sent to each store). A key present in both with different bytes
 * fails the build, with the list; otherwise the ledger grows by the new keys.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { MediaManifest, MediaProfile } from "@webflix/contracts";
import { manifestPath, mediaCacheDir, REPO_ROOT, workDir } from "./paths.ts";
import { exists, readJson, writeJson } from "./util/fs.ts";
import { sha256File } from "./util/hash.ts";

/** Public, immutable, and not versioned by a `?v=` query. */
export const IMMUTABLE_UNVERSIONED = /^public\/previews\//;

/** Every content hash each key has ever been published with. */
export type PublishedLedger = Record<string, string[]>;

export function mergeLedgers(...ledgers: PublishedLedger[]): PublishedLedger {
  const merged: PublishedLedger = {};
  for (const ledger of ledgers) {
    for (const [key, hashes] of Object.entries(ledger)) {
      merged[key] = [...new Set([...(merged[key] ?? []), ...hashes])].sort();
    }
  }
  return merged;
}

/** Keys of `current` (key → sha256) that were published before with other bytes. */
export function unversionedConflicts(
  history: PublishedLedger,
  current: Record<string, string>,
): { key: string; before: string[]; now: string }[] {
  return Object.entries(current)
    .filter(([key]) => IMMUTABLE_UNVERSIONED.test(key))
    .filter(([key, sha]) => (history[key] ?? []).some((before) => before !== sha))
    .map(([key, now]) => ({ key, before: history[key] ?? [], now }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function ledgerPath(profile: MediaProfile, root: string): string {
  return join(workDir(profile, root), "published-public.json");
}

/** What this profile published before this build: ledger, previous manifest, upload records. */
export async function publishedBefore(
  profile: MediaProfile,
  root = REPO_ROOT,
): Promise<PublishedLedger> {
  const ledger = (await readJson<PublishedLedger>(ledgerPath(profile, root))) ?? {};
  const fromManifest: PublishedLedger = {};
  const previous = await readJson<MediaManifest>(manifestPath(profile, root));
  for (const asset of previous?.videoAssets ?? []) {
    const key = asset.preview?.key;
    const file = key ? join(mediaCacheDir(profile, root), key) : null;
    if (key && file && IMMUTABLE_UNVERSIONED.test(key) && (await exists(file)))
      fromManifest[key] = [await sha256File(file)];
  }
  const fromUploads: PublishedLedger = {};
  const work = workDir(profile, root);
  const records = (await readdir(work).catch(() => [] as string[])).filter((name) =>
    /^uploaded-[0-9a-f]+\.json$/.test(name),
  );
  for (const name of records) {
    const uploaded = (await readJson<Record<string, string>>(join(work, name))) ?? {};
    for (const [key, sha] of Object.entries(uploaded))
      if (IMMUTABLE_UNVERSIONED.test(key)) fromUploads[key] = [...(fromUploads[key] ?? []), sha];
  }
  return mergeLedgers(ledger, fromManifest, fromUploads);
}

/**
 * After packaging: fail on any unversioned key whose new bytes differ from what was published
 * before; otherwise record the new keys in the ledger.
 */
export async function checkPublished(
  profile: MediaProfile,
  before: PublishedLedger,
  keys: readonly string[],
  root = REPO_ROOT,
): Promise<void> {
  const current: Record<string, string> = {};
  for (const key of keys.filter((entry) => IMMUTABLE_UNVERSIONED.test(entry)))
    current[key] = await sha256File(join(mediaCacheDir(profile, root), key));
  const conflicts = unversionedConflicts(before, current);
  if (conflicts.length > 0) {
    throw new Error(
      `${conflicts.length} public unversioned key(s) were published before with other bytes (cached as immutable; the clip needs a new asset id, e.g. bump its recipe revision):\n  ${conflicts.map((conflict) => `${conflict.key}: was ${conflict.before.map((sha) => sha.slice(0, 12)).join(", ")}, now ${conflict.now.slice(0, 12)}`).join("\n  ")}`,
    );
  }
  const recorded: PublishedLedger = Object.fromEntries(
    Object.entries(current).map(([key, sha]) => [key, [sha]]),
  );
  await writeJson(ledgerPath(profile, root), mergeLedgers(before, recorded));
}
