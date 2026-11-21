// Bundles the API into one ESM file for the container image:
//   node scripts/bundle.ts   →   dist/main.mjs (+ .map), dist/scalar.js, dist/main.mjs.LEGAL.txt
// Workspace packages export TypeScript source and Node refuses to strip types under
// node_modules, so the image runs a bundle rather than the workspace: no node_modules, no
// package manager, one file to start (fast cold start, nothing to resolve at runtime).
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outdir = join(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(outdir, "main.mjs"),
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  // CommonJS dependencies (pg, ioredis, the AWS SDK) call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __webflixCreateRequire } from 'node:module'; const require = __webflixCreateRequire(import.meta.url);",
  },
  // pg loads its optional native binding lazily, only when asked for; we never ask.
  external: ["pg-native"],
  minifySyntax: true,
  minifyWhitespace: true,
  keepNames: true,
  sourcemap: "linked",
  sourcesContent: false,
  legalComments: "linked",
  metafile: true,
  logLevel: "warning",
});
await writeFile(join(outdir, "meta.json"), JSON.stringify(result.metafile));

// The docs UI script, served same-origin at /api/docs/scalar.js (runtime.ts looks next to itself).
const scalar = fileURLToPath(
  new URL("./browser/standalone.js", import.meta.resolve("@scalar/api-reference")),
);
await copyFile(scalar, join(outdir, "scalar.js"));

const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(`bundle: ${dirname(outdir)}/dist (${(bytes / 1024 / 1024).toFixed(1)} MiB incl. maps)`);
