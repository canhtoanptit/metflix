#!/usr/bin/env node
/**
 * Generates the deterministic test media the player playground and browser checks use, until
 * `tools/media` produces real packaged titles. Everything is synthetic (lavfi sources, DejaVu
 * fonts shipped in the ffmpeg image), so there is nothing to license or download.
 *
 * Output mirrors the production blob layout (blueprint §2.5) under `.cache/test-media/`
 * (git-ignored):
 *
 *   vod/{assetId}/master.m3u8              fMP4/CMAF HLS, 4 video renditions, 2 audio groups
 *   vod/{assetId}/{rendition}/…            init.mp4 + 4 s segments
 *   vod/{assetId}/subs/{en,es}.vtt         side-car WebVTT
 *   vod/{assetId}/trickplay/{n}.webp       sprite sheets matching the `TrickPlay` DTO
 *   public/previews/{assetId}/preview.mp4  progressive, faststart preview clip
 *   assets.json                            per-asset duration, markers, tracks, trick-play
 *
 * Usage: node scripts/generate-test-media.ts [--force]
 * ffmpeg runs in Docker (blueprint §7); the container is named `webflix-player-ffmpeg-*`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Pinned by digest so the output is reproducible; override to try another build. */
const FFMPEG_IMAGE =
  process.env.WEBFLIX_PLAYER_FFMPEG_IMAGE ??
  "linuxserver/ffmpeg@sha256:66fa8e2351fb78f9dad2c59c946be2658edcc529339320da3f2cf788312368af";
const OUT_DIR = resolve(import.meta.dirname, "../.cache/test-media");
const RECIPE_VERSION = 5;

const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf";

const FPS = 24;
const SEGMENT_SEC = 4;
const TRICKPLAY = { intervalSec: 2, tileWidth: 240, tileHeight: 135, columns: 5, rows: 5 };

interface Scene {
  durationSec: number;
  /** lavfi source; scaled to 1920x1080. */
  source: string;
  title: string;
  subtitle: string;
  /** Text colour for the scene card (dark text on bright scenes). */
  ink: string;
  credits?: readonly string[];
}

interface Cue {
  start: number;
  end: number;
  en: string;
  es: string;
  settings?: string;
}

interface EpisodeSpec {
  assetId: string;
  scenes: readonly Scene[];
  markers: {
    intro: { startSec: number; endSec: number } | null;
    recap: { startSec: number; endSec: number } | null;
    creditsStartSec: number | null;
  };
  cues: readonly Cue[];
  /** Preview clip window (seconds into the episode). */
  preview: { startSec: number; durationSec: number };
  /** Frame used for the episode still (episodes panel, next-episode card). */
  stillSec: number;
  /** Audio tone per language track; different pitches make audio-track switches audible. */
  tones: { en: number; es: number };
}

const gradient = (colors: readonly string[], type: string, speed: number) =>
  `gradients=s=1920x1080:r=${FPS}:${colors.map((c, i) => `c${i}=${c}`).join(":")}:n=${colors.length}:speed=${speed}:type=${type}:seed=7`;

const CREDITS = [
  "KESTREL BAY",
  "",
  "Test media for the Webflix player",
  "",
  "Created by",
  "lavfi gradients",
  "",
  "Fractal sequences",
  "mandelbrot",
  "",
  "Typography",
  "DejaVu Sans",
  "",
  "Score",
  "sine and cosine",
  "",
  "No footage was harmed",
];

const EPISODES: readonly EpisodeSpec[] = [
  {
    assetId: "wfp-test-s1e1",
    scenes: [
      {
        durationSec: 20,
        source: gradient(["0x050816", "0x1b2a55", "0x0a1230"], "radial", 0.012),
        title: "PREVIOUSLY",
        subtitle: "Recap  -  a dark, low-contrast frame",
        ink: "white",
      },
      {
        durationSec: 24,
        source: `mandelbrot=s=960x540:r=${FPS}:start_scale=2.5:end_scale=0.05:maxiter=200:outer=normalized_iteration_count:inner=black`,
        title: "KESTREL BAY",
        subtitle: "Opening titles",
        ink: "white",
      },
      {
        durationSec: 36,
        source: gradient(["0xf4f8ff", "0xffffff", "0xd9e8fb", "0xfff7e6"], "linear", 0.006),
        title: "DAYLIGHT",
        subtitle: "A bright, near-white frame for legibility checks",
        ink: "0x10131a",
      },
      {
        durationSec: 32,
        source: gradient(["0x010204", "0x070a14", "0x02030a"], "spiral", 0.004),
        title: "NIGHT",
        subtitle: "A near-black frame",
        ink: "0xb8c0d8",
      },
      {
        durationSec: 18,
        source: gradient(["0xff7a45", "0x6b1d5c", "0xffc46b", "0x2b1240"], "linear", 0.01),
        title: "DUSK",
        subtitle: "Saturated warm colours",
        ink: "white",
      },
      {
        durationSec: 20,
        source: `color=c=0x000000:s=1920x1080:r=${FPS}`,
        title: "",
        subtitle: "",
        ink: "white",
        credits: CREDITS,
      },
    ],
    markers: {
      recap: { startSec: 2, endSec: 18 },
      intro: { startSec: 21, endSec: 43 },
      creditsStartSec: 131,
    },
    cues: [
      {
        start: 2.5,
        end: 5.5,
        en: "Previously on Kestrel Bay...",
        es: "Anteriormente en Kestrel Bay...",
      },
      {
        start: 6,
        end: 10,
        en: "The harbour lights went out\nat exactly midnight.",
        es: "Las luces del puerto se apagaron\na medianoche en punto.",
      },
      {
        start: 10.5,
        end: 14,
        en: "<i>Nobody saw the boat leave.</i>",
        es: "<i>Nadie vio salir el barco.</i>",
      },
      {
        start: 14.5,
        end: 17.5,
        en: "Then the ledger turned up.",
        es: "Entonces apareció el libro.",
      },
      {
        start: 46,
        end: 50,
        en: "Morning. You look like you slept on the pier.",
        es: "Buenos días. Parece que dormiste en el muelle.",
      },
      {
        start: 50.5,
        end: 54,
        en: "I did. Someone had to watch the water.",
        es: "Así fue. Alguien tenía que vigilar el agua.",
      },
      {
        start: 55,
        end: 59,
        en: "[gulls crying]",
        es: "[gaviotas graznando]",
      },
      {
        start: 60,
        end: 64,
        en: "A caption placed at the top of the frame.",
        es: "Un subtítulo colocado arriba.",
        settings: "line:0",
      },
      {
        start: 65,
        end: 70,
        en: "This line is long enough that it has to wrap onto a second line on a phone.",
        es: "Esta línea es tan larga que tiene que pasar a una segunda línea en un teléfono.",
      },
      {
        start: 82,
        end: 86,
        en: "Do you hear that?",
        es: "¿Oyes eso?",
      },
      {
        start: 86.5,
        end: 91,
        en: "- The engine.\n- It's coming back.",
        es: "- El motor.\n- Está volviendo.",
      },
      {
        start: 95,
        end: 100,
        en: "Captions stay readable on near-black frames too.",
        es: "Los subtítulos también se leen en cuadros casi negros.",
      },
      {
        start: 114,
        end: 118,
        en: "Whatever is in that ledger, it isn't ours.",
        es: "Lo que haya en ese libro, no es nuestro.",
      },
      {
        start: 119,
        end: 124,
        en: "Then we give it back. Tonight.",
        es: "Entonces lo devolvemos. Esta noche.",
      },
    ],
    preview: { startSec: 21, durationSec: 15 },
    stillSec: 50,
    tones: { en: 220, es: 330 },
  },
  {
    assetId: "wfp-test-s1e2",
    scenes: [
      {
        durationSec: 12,
        source: gradient(["0x062a2f", "0x0f5c63", "0x03191c"], "circular", 0.01),
        title: "COLD OPEN",
        subtitle: "Episode two",
        ink: "white",
      },
      {
        durationSec: 18,
        source: `mandelbrot=s=960x540:r=${FPS}:start_x=-0.743643887037151:start_y=0.13182590420533:start_scale=3:end_scale=0.01:maxiter=200:outer=normalized_iteration_count:inner=black`,
        title: "KESTREL BAY",
        subtitle: "Opening titles",
        ink: "white",
      },
      {
        durationSec: 30,
        source: gradient(["0xfff1d6", "0xffe0a8", "0xfffaf0"], "linear", 0.008),
        title: "THE LEDGER",
        subtitle: "Another bright frame",
        ink: "0x241a0a",
      },
      {
        durationSec: 15,
        source: gradient(["0x14062b", "0x2e0f55", "0x08021a"], "radial", 0.01),
        title: "AFTERMATH",
        subtitle: "A deep violet frame",
        ink: "white",
      },
      {
        durationSec: 15,
        source: `color=c=0x000000:s=1920x1080:r=${FPS}`,
        title: "",
        subtitle: "",
        ink: "white",
        credits: CREDITS,
      },
    ],
    markers: { recap: null, intro: { startSec: 13, endSec: 29 }, creditsStartSec: 76 },
    cues: [
      { start: 1, end: 4, en: "Where did you find it?", es: "¿Dónde lo encontraste?" },
      {
        start: 4.5,
        end: 8,
        en: "Under the floor of the bait shop.",
        es: "Bajo el suelo de la tienda de cebos.",
      },
      { start: 32, end: 36, en: "Every page is a name.", es: "Cada página es un nombre." },
      {
        start: 37,
        end: 41,
        en: "<i>And one of them is mine.</i>",
        es: "<i>Y uno de ellos es el mío.</i>",
      },
      { start: 61, end: 65, en: "We should never have opened it.", es: "Nunca debimos abrirlo." },
    ],
    preview: { startSec: 30, durationSec: 12 },
    stillSec: 22,
    tones: { en: 196, es: 294 },
  },
];

const RENDITIONS = [
  { name: "1080p", width: 1920, height: 1080, crf: 23, maxrate: 4200 },
  { name: "720p", width: 1280, height: 720, crf: 24, maxrate: 2400 },
  { name: "480p", width: 854, height: 480, crf: 25, maxrate: 1100 },
  { name: "360p", width: 640, height: 360, crf: 26, maxrate: 600 },
] as const;

/** drawtext needs `'`, `\`, `:` and `%` escaped inside a quoted text value. */
function drawtextValue(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "’")
    .replaceAll(":", "\\:")
    .replaceAll("%", "\\%");
}

function sceneFilter(scene: Scene, index: number): string {
  const steps = [`[${index}:v]scale=1920:1080:flags=bicubic,setsar=1,format=yuv420p`];
  const d = scene.durationSec;
  // Inside a quoted option value commas are literal; the expression evaluator sees them as-is.
  const fade = `if(lt(t,0.8),t/0.8,if(gt(t,${d - 0.8}),(${d}-t)/0.8,1))`;
  if (scene.title) {
    steps.push(
      `drawtext=fontfile=${FONT_BOLD}:fontsize=128:fontcolor=${scene.ink}:alpha='${fade}':x=(w-tw)/2:y=(h-th)/2-60:text='${drawtextValue(scene.title)}'`,
    );
  }
  if (scene.subtitle) {
    steps.push(
      `drawtext=fontfile=${FONT_REGULAR}:fontsize=44:fontcolor=${scene.ink}:alpha='${fade}':x=(w-tw)/2:y=(h/2)+70:text='${drawtextValue(scene.subtitle)}'`,
    );
  }
  if (scene.credits) {
    // One drawtext per line keeps escaping simple; the block scrolls up at 70 px/s.
    scene.credits.forEach((line, i) => {
      if (!line) return;
      const heading = i === 0;
      steps.push(
        `drawtext=fontfile=${heading ? FONT_BOLD : FONT_REGULAR}:fontsize=${heading ? 64 : 40}:fontcolor=white:x=(w-tw)/2:y=h*0.55+${i * 58}-t*70:text='${drawtextValue(line)}'`,
      );
    });
  }
  return `${steps.join(",")}[s${index}]`;
}

function buildFilterGraph(spec: EpisodeSpec): string {
  const scenes = spec.scenes.map(sceneFilter);
  const n = spec.scenes.length;
  const timecode = `drawtext=fontfile=${FONT_MONO}:fontsize=64:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:x=w-tw-64:y=56:text='%{eif\\:floor(t/60)\\:d}\\:%{eif\\:mod(floor(t)\\,60)\\:d\\:2}'`;
  const lines = [
    ...scenes,
    // The ladder and trick-play carry a burned-in timecode (to verify seeking and tile maths);
    // the preview clip and the stills are clean.
    `${spec.scenes.map((_, i) => `[s${i}]`).join("")}concat=n=${n}:v=1:a=0,split=2[tcin][clean]`,
    `[tcin]${timecode},split=${RENDITIONS.length + 1}${RENDITIONS.map((_, i) => `[r${i}]`).join("")}[tp]`,
    "[clean]split=2[pv][st]",
    `[st]trim=start=${spec.stillSec}:duration=0.25,setpts=PTS-STARTPTS,split=2[st0][st1]`,
    "[st0]scale=640:360[still640]",
    "[st1]scale=320:180[still320]",
    ...RENDITIONS.map(
      (r, i) =>
        `[r${i}]scale=${r.width}:${r.height}:flags=bicubic,drawtext=fontfile=${FONT_BOLD}:fontsize=${Math.round(r.height * 0.03)}:fontcolor=white:box=1:boxcolor=0x000000@0.55:boxborderw=${Math.round(r.height * 0.008)}:x=w-tw-${Math.round(r.width * 0.033)}:y=${Math.round(r.height * 0.14)}:text='${r.name}'[v${i}]`,
    ),
    `[tp]fps=1/${TRICKPLAY.intervalSec},scale=${TRICKPLAY.tileWidth}:${TRICKPLAY.tileHeight},tile=${TRICKPLAY.columns}x${TRICKPLAY.rows}[tiles]`,
    `[pv]trim=start=${spec.preview.startSec}:duration=${spec.preview.durationSec},setpts=PTS-STARTPTS,scale=1280:720[pvv]`,
    `[${n}:a]asplit=2[aen][aenp]`,
    `[aenp]atrim=start=${spec.preview.startSec}:duration=${spec.preview.durationSec},asetpts=PTS-STARTPTS[pva]`,
    `[${n + 1}:a]anull[aes]`,
  ];
  return `${lines.join(";\n")}\n`;
}

function toneSource(freq: number, durationSec: number): string {
  // A soft, slowly pulsing tone; the pitch tells the audio tracks apart.
  const expr = `0.06*sin(2*PI*${freq}*t)*(0.65+0.35*sin(2*PI*0.5*t))`;
  return `aevalsrc=exprs='${expr}|${expr}':s=48000:c=stereo:d=${durationSec}`;
}

function vttTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (v: number, l = 2) => String(v).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

function buildVtt(cues: readonly Cue[], lang: "en" | "es"): string {
  const body = cues
    .map(
      (cue, i) =>
        `${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}${cue.settings ? ` ${cue.settings}` : ""}\n${cue[lang]}\n`,
    )
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

function runFfmpeg(workDir: string, args: readonly string[]): void {
  const name = `webflix-player-ffmpeg-${process.pid}-${Date.now()}`;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "-v",
      `${workDir}:/work`,
      "-w",
      "/work",
      "--entrypoint",
      "ffmpeg",
      FFMPEG_IMAGE,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...args,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (exit ${result.status ?? "signal"})`);
  }
}

async function generateEpisode(spec: EpisodeSpec): Promise<Record<string, unknown>> {
  const durationSec = spec.scenes.reduce((sum, scene) => sum + scene.durationSec, 0);
  const vodDir = join(OUT_DIR, "vod", spec.assetId);
  const previewDir = join(OUT_DIR, "public", "previews", spec.assetId);
  await rm(vodDir, { recursive: true, force: true });
  await rm(previewDir, { recursive: true, force: true });
  await mkdir(join(vodDir, "trickplay"), { recursive: true });
  await mkdir(join(vodDir, "subs"), { recursive: true });
  await mkdir(previewDir, { recursive: true });

  await writeFile(join(vodDir, "graph.txt"), buildFilterGraph(spec));
  const inputs = spec.scenes.flatMap((scene) => [
    "-f",
    "lavfi",
    "-t",
    String(scene.durationSec),
    "-i",
    scene.source,
  ]);
  inputs.push("-f", "lavfi", "-i", toneSource(spec.tones.en, durationSec));
  inputs.push("-f", "lavfi", "-i", toneSource(spec.tones.es, durationSec));

  const video = RENDITIONS.flatMap((r, i) => [
    "-map",
    `[v${i}]`,
    `-crf:v:${i}`,
    String(r.crf),
    `-maxrate:v:${i}`,
    `${r.maxrate}k`,
    `-bufsize:v:${i}`,
    `${r.maxrate * 2}k`,
  ]);
  const streamMap = [
    ...RENDITIONS.map((r) => `v:${RENDITIONS.indexOf(r)},agroup:aud,name:${r.name}`),
    "a:0,agroup:aud,language:en,name:audio_en,default:yes",
    "a:1,agroup:aud,language:es,name:audio_es",
  ].join(" ");

  console.log(
    `[${spec.assetId}] encoding ${durationSec}s: ${RENDITIONS.length} renditions, 2 audio tracks, trick-play, preview`,
  );
  runFfmpeg(vodDir, [
    ...inputs,
    "-/filter_complex",
    "graph.txt",
    // HLS ladder
    ...video,
    "-map",
    "[aen]",
    "-map",
    "[aes]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(FPS * 2),
    "-keyint_min",
    String(FPS * 2),
    "-sc_threshold",
    "0",
    "-threads",
    "4",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_SEC),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "independent_segments",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    "%v/seg_%03d.m4s",
    "-master_pl_name",
    "master.m3u8",
    "-var_stream_map",
    streamMap,
    "%v/index.m3u8",
    // trick-play sheets
    "-map",
    "[tiles]",
    "-c:v",
    "libwebp",
    "-quality",
    "72",
    "-start_number",
    "0",
    "-f",
    "image2",
    "trickplay/%d.webp",
    // preview clip (progressive, faststart)
    "-map",
    "[pvv]",
    "-map",
    "[pva]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    "preview.mp4",
    // episode stills
    ...[640, 320].flatMap((width) => [
      "-map",
      `[still${width}]`,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      "80",
      `still-${width}.webp`,
    ]),
  ]);
  await rm(join(vodDir, "graph.txt"));

  // ffmpeg names audio renditions `audio_<n>`; give them display names by language.
  const masterPath = join(vodDir, "master.m3u8");
  const audioNames: Record<string, string> = { en: "English", es: "Español" };
  const master = (await readFile(masterPath, "utf8"))
    .split("\n")
    .map((line) => {
      const language = /LANGUAGE="([^"]+)"/.exec(line)?.[1];
      if (!line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO") || !language) return line;
      return line.replace(/NAME="[^"]*"/, `NAME="${audioNames[language] ?? language}"`);
    })
    .join("\n");
  await writeFile(masterPath, master);

  await rename(join(vodDir, "preview.mp4"), join(previewDir, "preview.mp4"));
  const stillDir = join(OUT_DIR, "public", "img", "episodes", spec.assetId);
  await rm(stillDir, { recursive: true, force: true });
  await mkdir(stillDir, { recursive: true });
  for (const width of [320, 640]) {
    await rename(join(vodDir, `still-${width}.webp`), join(stillDir, `still-${width}.webp`));
  }

  await writeFile(join(vodDir, "subs", "en.vtt"), buildVtt(spec.cues, "en"));
  await writeFile(join(vodDir, "subs", "es.vtt"), buildVtt(spec.cues, "es"));

  const sheets = (await readdir(join(vodDir, "trickplay")))
    .filter((file) => file.endsWith(".webp"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  const count = Math.ceil(durationSec / TRICKPLAY.intervalSec);

  return {
    assetId: spec.assetId,
    durationSec,
    master: `vod/${spec.assetId}/master.m3u8`,
    preview: `public/previews/${spec.assetId}/preview.mp4`,
    still: {
      keyTemplate: `public/img/episodes/${spec.assetId}/still-{width}.{format}`,
      widths: [320, 640],
      formats: ["webp"],
    },
    previewDurationSec: spec.preview.durationSec,
    markers: spec.markers,
    textTracks: [
      {
        id: "en",
        language: "en",
        label: "English",
        kind: "subtitles",
        key: `vod/${spec.assetId}/subs/en.vtt`,
        default: false,
        forced: false,
      },
      {
        id: "es",
        language: "es",
        label: "Español",
        kind: "subtitles",
        key: `vod/${spec.assetId}/subs/es.vtt`,
        default: false,
        forced: false,
      },
    ],
    trickPlay: {
      ...TRICKPLAY,
      count,
      sheets: sheets.map((file) => `vod/${spec.assetId}/trickplay/${file}`),
    },
    renditions: RENDITIONS.map(({ name, width, height }) => ({ name, width, height })),
  };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const recipe = createHash("sha256")
    .update(JSON.stringify({ RECIPE_VERSION, FFMPEG_IMAGE, EPISODES, RENDITIONS, TRICKPLAY }))
    .digest("hex")
    .slice(0, 16);
  const indexPath = join(OUT_DIR, "assets.json");
  if (!force && existsSync(indexPath)) {
    const current = JSON.parse(await readFile(indexPath, "utf8")) as { recipe?: string };
    if (current.recipe === recipe) {
      console.log(`Test media is up to date (${OUT_DIR}). Pass --force to regenerate.`);
      return;
    }
  }
  await mkdir(OUT_DIR, { recursive: true });
  const assets = [];
  for (const spec of EPISODES) {
    assets.push(await generateEpisode(spec));
  }
  await writeFile(
    indexPath,
    `${JSON.stringify({ recipe, generatedBy: "packages/player/scripts/generate-test-media.ts", assets }, null, 2)}\n`,
  );
  console.log(`Wrote ${assets.length} assets to ${OUT_DIR}`);
}

await main();
