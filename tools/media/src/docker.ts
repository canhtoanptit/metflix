/**
 * ffmpeg and ffprobe run in Docker (blueprint §7: never installed on the host). Everything the
 * container reads or writes lives under `.cache/media`, bind-mounted at `/media`; fonts are
 * mounted read-only at `/fonts`. Containers are named `webflix-media-*` and removed on exit.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { FONTS_DIR, MEDIA_ROOT, TOOL_ROOT } from "./paths.ts";
import { sha256 } from "./util/hash.ts";
import { log } from "./util/log.ts";

const DOCKERFILE_DIR = join(TOOL_ROOT, "docker");
const IMAGE_REPO = "webflix-media-ffmpeg";

let imagePromise: Promise<string> | null = null;

export class DockerError extends Error {
  override readonly name = "DockerError";
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Tag derived from the Dockerfile's content: editing it means a new image and new outputs. */
export async function imageTag(): Promise<string> {
  const dockerfile = await readFile(join(DOCKERFILE_DIR, "Dockerfile"), "utf8");
  return `${IMAGE_REPO}:${sha256(dockerfile).slice(0, 12)}`;
}

/** Build the ffmpeg image once if it is missing. */
export function ensureImage(): Promise<string> {
  imagePromise ??= (async () => {
    const tag = await imageTag();
    const inspect = await run("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]);
    if (inspect.code === 0) return tag;
    log.info(`building Docker image ${tag} (one-time)`);
    const build = await run("docker", ["build", "--quiet", "-t", tag, DOCKERFILE_DIR]);
    if (build.code !== 0) throw new DockerError(`docker build failed:\n${build.stderr}`);
    return tag;
  })();
  return imagePromise;
}

/** Host path under `.cache/media` (or the fonts dir) → path inside the container. */
export function containerPath(hostPath: string): string {
  const media = relative(MEDIA_ROOT, hostPath);
  if (!media.startsWith("..") && !media.startsWith(sep)) {
    return `/media/${media.split(sep).join("/")}`;
  }
  const fonts = relative(FONTS_DIR, hostPath);
  if (!fonts.startsWith("..") && !fonts.startsWith(sep)) {
    return `/fonts/${fonts.split(sep).join("/")}`;
  }
  throw new DockerError(`Path is not visible to the ffmpeg container: ${hostPath}`);
}

async function dockerRun(tool: "ffmpeg" | "ffprobe", args: readonly string[]): Promise<RunResult> {
  const image = await ensureImage();
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return run("docker", [
    "run",
    "--rm",
    "--name",
    `webflix-media-${tool}-${randomUUID().slice(0, 8)}`,
    "--user",
    `${uid}:${gid}`,
    "--network",
    "none",
    "-v",
    `${MEDIA_ROOT}:/media`,
    "-v",
    `${FONTS_DIR}:/fonts:ro`,
    image,
    tool,
    ...args,
  ]);
}

/** Run ffmpeg; throws with the tail of its log on failure. */
export async function ffmpeg(args: readonly string[]): Promise<void> {
  const result = await dockerRun("ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ]);
  if (result.code !== 0) {
    throw new DockerError(
      `ffmpeg failed (${result.code}): ${args.join(" ").slice(0, 400)}\n${result.stderr.slice(-2000)}`,
    );
  }
}

export interface ProbeResult {
  durationSec: number;
  video: { width: number; height: number; frameRate: number; codec: string } | null;
  audio: { channels: number; sampleRate: number; codec: string } | null;
}

interface RawProbe {
  format?: { duration?: string };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    channels?: number;
    sample_rate?: string;
    duration?: string;
  }[];
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return 0;
  return num / den;
}

export async function ffprobe(hostPath: string): Promise<ProbeResult> {
  const result = await dockerRun("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    containerPath(hostPath),
  ]);
  if (result.code !== 0) throw new DockerError(`ffprobe failed for ${hostPath}: ${result.stderr}`);
  const raw = JSON.parse(result.stdout) as RawProbe;
  const video = raw.streams?.find((stream) => stream.codec_type === "video");
  const audio = raw.streams?.find((stream) => stream.codec_type === "audio");
  // r_frame_rate is the nominal rate (24); avg_frame_rate can drift on old MOVs (23.39).
  const nominal = parseRate(video?.r_frame_rate);
  const frameRate = nominal > 0 && nominal <= 61 ? nominal : parseRate(video?.avg_frame_rate);
  return {
    durationSec: Number(raw.format?.duration ?? video?.duration ?? 0),
    video: video
      ? {
          width: video.width ?? 0,
          height: video.height ?? 0,
          frameRate: Math.round(frameRate * 1000) / 1000,
          codec: video.codec_name ?? "unknown",
        }
      : null,
    audio: audio
      ? {
          channels: audio.channels ?? 2,
          sampleRate: Number(audio.sample_rate ?? 48000),
          codec: audio.codec_name ?? "unknown",
        }
      : null,
  };
}

/** True when the Docker daemon answers. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    return (await run("docker", ["version", "--format", "{{.Server.Version}}"])).code === 0;
  } catch {
    return false;
  }
}
