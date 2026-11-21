/**
 * `webflix-media review`: a local page for checking packaged media in a real browser without
 * the API: every asset plays through hls.js with side-car subtitles, the rendition can be
 * pinned to check ABR switching, a scrubber shows trick-play tiles, and the preview clip
 * plays muted. Contact sheets are listed too. Binds to 127.0.0.1 only.
 *
 * `window.__review` exposes the player state for automated checks (Playwright).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, sep } from "node:path";
import { catalog } from "@webflix/catalog";
import type { MediaManifest, MediaProfile } from "@webflix/contracts";
import { MEDIA_ROOT, manifestPath, mediaCacheDir } from "../paths.ts";
import { listFiles, readJson } from "../util/fs.ts";

const TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".json": "application/json",
  ".js": "text/javascript",
  ".html": "text/html; charset=utf-8",
};

function page(profile: MediaProfile, manifest: MediaManifest, sheets: string[]): string {
  const titles = catalog.titles.map((title) => {
    const assetId =
      title.type === "movie"
        ? title.videoAssetId
        : (title.seasons[0]?.episodes[0]?.videoAssetId ?? "");
    return { id: title.id, name: title.name, assetId, previewId: title.previewAssetId ?? assetId };
  });
  const data = JSON.stringify({ profile, manifest, titles });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webflix media review (${profile})</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#141414;color:#e5e5e5;font:14px/1.4 system-ui,sans-serif}
header{padding:16px 24px;border-bottom:1px solid #2a2a2a}main{display:grid;grid-template-columns:320px 1fr;min-height:100vh}
nav{overflow:auto;max-height:100vh;border-right:1px solid #2a2a2a}nav button{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;padding:6px 16px;cursor:pointer}nav button:hover,nav button[aria-current]{background:#262626}
section{padding:24px}video{width:100%;max-width:960px;background:#000;display:block}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:12px 0}.row button{background:#333;color:#fff;border:0;padding:6px 10px;border-radius:4px;cursor:pointer}
#scrub{position:relative;height:28px;max-width:960px;background:#333;border-radius:4px;margin-top:12px;cursor:pointer}#thumb{position:absolute;bottom:36px;display:none;border:2px solid #fff;background-repeat:no-repeat}
#preview{max-width:480px}code{color:#9ad}a{color:#9ad}
</style></head><body><header><strong>Webflix media review</strong> · profile <code>${profile}</code> · ${manifest.videoAssets.length} assets · generated ${manifest.generatedAt}
 · sheets: ${sheets.map((sheet) => `<a href="/review/${sheet}">${sheet}</a>`).join(" ")}</header>
<main><nav id="list"></nav><section>
<h2 id="name">Pick a title</h2><p id="meta"></p>
<video id="video" controls playsinline crossorigin="anonymous"></video>
<div id="scrub"><div id="thumb"></div></div>
<div class="row" id="levels"></div><div class="row" id="subs"></div>
<p id="status"></p>
<h3>Preview clip</h3><video id="preview" muted loop playsinline autoplay></video>
</section></main>
<script src="/hls.js"></script>
<script>
const DATA = ${data};
const byId = new Map(DATA.manifest.videoAssets.map((a) => [a.assetId, a]));
const video = document.getElementById("video");
const state = window.__review = { levels: [], switches: [], level: -1, cues: 0, track: null, ready: false, errors: [] };
let hls = null;
function tile(tp, sec) {
  if (!tp || tp.count === 0) return null;
  const i = Math.min(Math.floor(sec / tp.intervalSec), tp.count - 1);
  const per = tp.columns * tp.rows; const cell = i % per;
  return { sheet: "/" + tp.sheets[Math.floor(i / per)], x: (cell % tp.columns) * tp.tileWidth, y: Math.floor(cell / tp.columns) * tp.tileHeight, i };
}
function load(title) {
  const asset = byId.get(title.assetId);
  document.querySelectorAll("nav button").forEach((b) => b.toggleAttribute("aria-current", b.dataset.id === title.id));
  document.getElementById("name").textContent = title.name;
  document.getElementById("meta").textContent = asset ? asset.assetId + " · " + asset.durationSec.toFixed(1) + " s · " + asset.renditions.map((r) => r.width + "x" + r.height).join(", ") + (asset.synthetic ? " · SYNTHETIC" : "") + " · markers " + JSON.stringify(asset.markers) : "not packaged";
  Object.assign(state, { levels: [], switches: [], level: -1, cues: 0, track: null, ready: false, errors: [], assetId: title.assetId });
  if (hls) hls.destroy();
  [...video.querySelectorAll("track")].forEach((t) => t.remove());
  if (!asset) return;
  hls = new Hls({ capLevelToPlayerSize: false });
  hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => { state.levels = d.levels.map((l) => l.height); state.ready = true; renderLevels(); });
  hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => { state.level = d.level; state.switches.push(hls.levels[d.level].height); document.getElementById("status").textContent = "playing level " + d.level + " (" + hls.levels[d.level].height + "p)"; });
  hls.on(Hls.Events.ERROR, (_e, d) => { state.errors.push(d.details); });
  hls.loadSource("/" + asset.master); hls.attachMedia(video);
  const subs = document.getElementById("subs"); subs.innerHTML = "Subtitles: ";
  for (const track of asset.textTracks) {
    const el = document.createElement("track"); el.kind = track.kind; el.label = track.label; el.srclang = track.language; el.src = "/" + track.key;
    video.appendChild(el);
    const b = document.createElement("button"); b.textContent = track.label; b.onclick = () => showTrack(track.language); subs.appendChild(b);
  }
  const preview = document.getElementById("preview"); const pv = byId.get(title.previewId);
  preview.src = pv && pv.preview ? "/" + pv.preview.key : "";
}
function showTrack(lang) {
  for (const t of video.textTracks) {
    t.mode = t.language === lang ? "showing" : "disabled";
    if (t.language === lang) { state.track = lang; t.oncuechange = () => { state.cues += 1; state.activeCue = t.activeCues && t.activeCues[0] ? t.activeCues[0].text : null; }; }
  }
}
function renderLevels() {
  const el = document.getElementById("levels"); el.innerHTML = "Rendition: ";
  const auto = document.createElement("button"); auto.textContent = "Auto"; auto.onclick = () => (hls.currentLevel = -1); el.appendChild(auto);
  hls.levels.forEach((l, i) => { const b = document.createElement("button"); b.textContent = l.height + "p"; b.dataset.level = i; b.onclick = () => (hls.currentLevel = i); el.appendChild(b); });
}
const scrub = document.getElementById("scrub"); const thumb = document.getElementById("thumb");
scrub.onmousemove = (e) => {
  const asset = byId.get(state.assetId); if (!asset || !asset.trickPlay) return;
  const rect = scrub.getBoundingClientRect(); const sec = ((e.clientX - rect.left) / rect.width) * asset.durationSec;
  const t = tile(asset.trickPlay, sec); if (!t) return;
  const tp = asset.trickPlay;
  Object.assign(thumb.style, { display: "block", width: tp.tileWidth + "px", height: tp.tileHeight + "px", left: Math.max(0, e.clientX - rect.left - tp.tileWidth / 2) + "px", backgroundImage: "url(" + t.sheet + ")", backgroundPosition: -t.x + "px " + -t.y + "px" });
  state.tile = { sec, index: t.i, sheet: t.sheet };
};
scrub.onmouseleave = () => (thumb.style.display = "none");
scrub.onclick = (e) => { const r = scrub.getBoundingClientRect(); const a = byId.get(state.assetId); if (a) video.currentTime = ((e.clientX - r.left) / r.width) * a.durationSec; };
const nav = document.getElementById("list");
for (const title of DATA.titles) { const b = document.createElement("button"); b.textContent = title.name; b.dataset.id = title.id; b.onclick = () => { history.replaceState(null, "", "?title=" + title.id); load(title); }; nav.appendChild(b); }
window.__load = (id) => load(DATA.titles.find((t) => t.id === id));
const initial = new URLSearchParams(location.search).get("title"); if (initial) window.__load(initial);
</script></body></html>`;
}

export async function serveReview(profile: MediaProfile, port: number): Promise<number> {
  const root = mediaCacheDir(profile);
  const reviewDir = join(MEDIA_ROOT, "review", profile);
  const hlsPath = createRequire(import.meta.url).resolve("hls.js/dist/hls.min.js");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/") {
        const manifest = await readJson<MediaManifest>(manifestPath(profile));
        if (!manifest) throw new Error(`No manifest for ${profile}`);
        response.writeHead(200, { "content-type": TYPES[".html"] ?? "text/html" });
        response.end(page(profile, manifest, await listFiles(reviewDir)));
        return;
      }
      let file: string;
      if (url.pathname === "/hls.js") file = hlsPath;
      else {
        const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
        const base = relative.startsWith(`review${sep}`) ? MEDIA_ROOT : root;
        file = join(base, relative);
        if (!file.startsWith(base + sep)) throw new Error("outside root");
      }
      const info = await stat(file);
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
      if (range) {
        const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
        const end =
          range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
        response.writeHead(206, {
          "content-type": type,
          "content-range": `bytes ${start}-${end}/${info.size}`,
          "content-length": end - start + 1,
          "accept-ranges": "bytes",
        });
        createReadStream(file, { start, end }).pipe(response);
        return;
      }
      response.writeHead(200, {
        "content-type": type,
        "content-length": info.size,
        "accept-ranges": "bytes",
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`review: http://localhost:${port}/ (profile ${profile}); Ctrl-C to stop`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  server.close();
  return 0;
}
