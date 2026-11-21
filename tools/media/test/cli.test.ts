import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { manifestPath, mediaCacheDir, REPO_ROOT } from "../src/paths.ts";

describe("webflix-media CLI", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webflix-media-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts a valid manifest and rejects an invalid one", async () => {
    const file = join(dir, "manifest.json");
    const manifest = {
      version: 1,
      profile: "fast",
      generatedAt: "2026-11-21T00:00:00.000Z",
      videoAssets: [],
      titleArtwork: [],
      episodeStills: [],
      avatars: [],
    };
    await writeFile(file, JSON.stringify(manifest));
    expect(await main(["validate-manifest", file])).toBe(0);
    await writeFile(file, JSON.stringify({ ...manifest, profile: "huge" }));
    expect(await main(["validate-manifest", file])).toBe(1);
  });

  it("prints usage and rejects unknown commands", async () => {
    expect(await main([])).toBe(0);
    expect(await main(["explode"])).toBe(2);
  });

  it("keeps packaged media in the git-ignored cache", () => {
    expect(mediaCacheDir("fast")).toBe(join(REPO_ROOT, ".cache", "media", "fast"));
    expect(manifestPath("full")).toBe(join(REPO_ROOT, ".cache", "media", "full", "manifest.json"));
  });
});
