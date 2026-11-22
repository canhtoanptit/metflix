# tools/media — the Webflix media pipeline

Builds everything the product shows and plays, from freely licensed sources, deterministically
and offline-capable:

- **Artwork** for every title (backdrop, card with title treatment, poster, transparent logo),
  every episode still, and the profile avatars — AVIF + WebP in several widths, with dominant
  colour, ThumbHash and a content version for cache busting.
- **Video** for every seed asset: H.264 ABR ladder + AAC audio as fMP4/CMAF HLS, side-car
  WebVTT subtitles, trick-play sprite sheets, a short muted-autoplay preview MP4, and
  intro/recap/credits markers.
- **The manifest** (`MediaManifest`, validated against the contract) and an **upload** command
  that pushes it all through the `BlobStore` port.

ffmpeg runs in Docker (`webflix-media-ffmpeg:<hash>`, built on first use from
`docker/Dockerfile`; Alpine 3.23, ffmpeg 8). Nothing is transcoded at request time.

## Quick start

```sh
make content                 # PROFILE=fast: build + upload to the dev blob store
make content PROFILE=full    # complete films, full ladder
make content-review          # http://localhost:4400 — play any asset, check subtitles/trick-play
make content-sheets          # contact sheets in .cache/media/review/<profile>/
make help                    # every content-* target
```

Dev mode needs no upload at all: `apps/api` layers `.cache/media/<profile>` under its blob store
and seeds with its `manifest.json` (docs/DECISIONS.md D13). `make content` still uploads to
`.data/blobs` through the port so the same path is exercised as in k8s and Cloudflare.

The CLI is `node tools/media/src/cli.ts <command>` (`help` lists everything):

| Command | What it does |
| --- | --- |
| `build --profile fast\|full [--only ids] [--skip-art] [--skip-video]` | art stage, video stage, manifest |
| `upload --profile p [--target fs:] [--prune] [--concurrency 16]` | push the tree + manifest through a `BlobStore` |
| `validate-manifest <file>` | check a manifest against `MediaManifest`; next to its files also timing and previews (declared `kind`/`hasAudio` against the decoded clip, motion art against the backdrop) |
| `contact-sheets --profile p [--only boundaries,…]` / `review --profile p [--port 4400]` | look at the results (incl. `previews-N.jpg`: each title's card next to three frames of its preview; `boundaries-NN.jpg`: the edge frames of every playable clip, see *Reviewing footage*) |
| `check-art --profile p` | perceptual-hash and source check: no two titles share a key-art source, backdrop or poster; no series repeats a still; real films' key-art frames are clear of any text |
| `photos fetch \| auto \| search "<q>" \| pick <id> "<q>" <n>` | photo library curation and prefetch |
| `credits` | regenerate `docs/CREDITS.md` |
| `status` / `clean --profile p` | cache sizes / delete a profile's output |

## How it works

```
@webflix/catalog ──► art stage ──► .cache/media/art/public/img/…        (profile-independent)
  titles + art      photos, film frames, procedural scenes, fonts → grade → compose → encode
  direction
                ──► video stage ──► .cache/media/<p>/vod/<asset>/…, public/previews/<asset>/…
  video assets      download & probe sources once → per asset: ladder, audio, subs, trick-play,
                    preview (ffmpeg in Docker), master playlist with measured bandwidth
                ──► manifest ────► .cache/media/<p>/manifest.json (art hard-linked into <p>)
                ──► upload ──────► BlobStore (fs: dev, s3: k8s, R2 via uploadProfile)
```

### Video

- **Sources** are the open films in `packages/catalog/src/data/open-films.ts` (URL, licence,
  verified credits, subtitle URLs, medium, every stretch with burned-in text — studio cards,
  title cards, credits — measured as described under *Reviewing footage*, on-screen story text
  that must stay out of key art, opening titles, credits timecode, chapters, highlight
  windows, rating). The catalog (`assemble.ts`, rules in `footage.ts`) turns them into assets,
  every borrowed window at least `TEXT_MARGIN_SEC` (1 s) clear of any text span, in whole
  seconds:

  | asset | what | played by |
  | --- | --- | --- |
  | `v-<film>` | the complete film | its own real title only |
  | `v-<film>-cut` | its longest text-free stretch | fictional movies |
  | `v-<film>-epN` | text-free chapters; each after the first opens with the last 20 s of the one before | fictional series |
  | `v-<film>-pv<start>-<end>-<rev>` | a ~30 s excerpt; `<rev>` hashes the source, the window and `FOOTAGE_PREVIEW_RECIPE` | the film's own preview, or a curated match |
  | `v-art-<title>-<rev>` | a 16 s motion-art clip from the title's own key art; `<rev>` hashes `MOTION_ART_RECIPE` and the title's art direction | every other fictional title's preview |

  Playback footage is matched by medium (live action vs animation), then genre affinity, never
  rated above the title, spread so a genre row does not keep playing one film. **Previews never
  contradict their title**: (a) a real film previews itself; (b) a fictional title previews a
  hand-reviewed excerpt only when it is the same medium, text-free and believable as that title
  (`CURATED_PREVIEWS`); (c) everything else gets motion art. `pnpm --filter @webflix/catalog
  test` fails on a cross-medium preview or on footage showing a film's titles under another title.
- **Motion art** (`artwork` sources, `src/video/motion.ts`): the art stage keeps each title's
  textless 1920×1080 backdrop master (`work/art/masters/<title>/backdrop.png`). The web plays the
  clip over that backdrop on the billboard and the detail hero, so the clip **starts and ends
  exactly on the still**: zoom 1, no fade, grade, grain or vignette at either end, converted to
  BT.709 limited range once and tagged as such (an untagged BT.601 conversion shifts colours by
  several levels when the clip starts). In between: a push to a seeded peak of 1.20–1.25 at
  half-time towards a drifting point and back (zoompan on a 2x upscale, so no jitter; it reads
  at billboard size and loops seamlessly), and a soft warm light that enters and leaves outside
  the frame. Video only: no audio track. Packaging decodes the first and last frames and fails
  the clip unless both match the master (reduced to 320×180 and softened, so grain and
  compression noise count for little: mean error ≤ 4.5 levels, luma shift ≤ 3; a 2 % zoom on
  any detailed image, a vignette or a BT.601/709 slip all fail; calibrated on every clip). Changing a title's
  art re-renders its clip under a new id; so does `MOTION_ART_RECIPE`.
- **Previews declare what they are** (`preview.kind`, `preview.hasAudio` in the manifest):
  motion art is `motion` with `hasAudio: false`; a footage clip is `footage` and its
  `hasAudio` comes from measuring the decoded audio (`astats` peak above −60 dBFS), never from
  whether a track exists. `validate-manifest` measures every preview again: a clip declaring
  sound must be audible, one declaring none must be digitally silent (no track, or all samples
  zero), and motion art must match the published backdrop at both ends.
- **Preview clips are immutable**: they are public keys with no `?v=`, cached for a year by
  browsers and edges nobody can purge. So a preview id is derived from everything that defines
  the clip (footage: source, window, `FOOTAGE_PREVIEW_RECIPE`; motion art:
  `MOTION_ART_RECIPE`, art direction), and two guards catch anything the derivation misses,
  such as an encoder change without a recipe bump:
  - `build` snapshots what the profile published before (its ledger
    `work/<p>/published-public.json`, the previous manifest's files, every upload record) and
    fails, listing the keys, if a preview key comes back with other bytes (`src/published.ts`);
  - `upload` refuses to replace a stored preview with different bytes.
  Bump the recipe revision when the encode changes; never reuse an id.
- **Profiles** (`src/profiles.ts`):

  | | fast | full |
  | --- | --- | --- |
  | ladder | 1280 / 854 / 480 wide (720p, 480p, 270p class); feature cuts add 1920 (1080p) | 1920 / 1280 / 960 / 640 / 426 |
  | x264 preset | veryfast | faster |
  | clip per asset | films 150 s, feature cuts 210 s, episodes 75 s, previews 24 s (motion art 16 s) | complete, previews 30 s (motion art 16 s) |
  | preview MP4 | 960×540 | 1280×720 |
  | trick-play tile | 240 px | 320 px |

  Widths are fixed and heights follow the source (most open films are ~2.39:1); rungs wider
  than the source are skipped, 60 fps sources are halved, every source is converted to a
  constant frame rate and made exactly the window long (a short picture is held on its last
  frame, a long one cut; sound is padded with silence or cut the same way), so video and
  audio renditions end together. GOPs are 2 s with forced keyframes,
  segments 4 s, `independent_segments`; audio is a demuxed AAC-LC rendition group. The master
  is written by us: `BANDWIDTH`/`AVERAGE-BANDWIDTH` measured from the segments, exact `CODECS`.
- **Everything starts at 0.** Timestamps are passed through (`-avoid_negative_ts disabled`) and
  fragments use negative composition offsets (`movflags=+cmaf+negative_cts_offsets`, trun v1),
  so the first presented frame of every fragment is its `tfdt`, with no empty edit; the preview
  MP4s get the same flags. Without this, x264's B-frame reorder delay put the first frame at
  0.083 s, which hls.js treats as a start gap. `src/video/validate.ts` parses the init segment
  and first fragment of every rendition (and the preview MP4) after packaging and fails the
  asset unless video starts at 0 (±1 ms), audio within one AAC frame of it, and the segment
  durations add up to the asset; `validate-manifest` runs the same check over a packaged tree.
- **Subtitles** are side-car WebVTT only (the player attaches them; the master has no
  SUBTITLES group). SRT/VTT inputs in any encoding (UTF-16, cp1250–1257, Shift-JIS…) are
  decoded, cleaned, clipped to the asset window and re-timed from 0.
- **Trick-play**: one thumbnail per interval (≈100 per asset, 2–10 s) taken at the middle of its
  window, packed row-major into full-size 10×10 JPEG sheets (`TrickPlay` DTO geometry).
- **Markers describe what is on screen**: a film's real opening titles and credits when the
  packaged window contains them, and a recap where a chapter really replays the end of the one
  before; otherwise null (text-free cuts have nothing to skip, and the player counts down to
  the next episode at the end). Markers are metadata: changing them never re-encodes video.
- **Offline fallback**: a source that cannot be downloaded is replaced by a synthetic stream
  (colour drift, label, timecode, pink noise) of the right length, flagged `synthetic: true`.
  It is not cached, so the next run retries the download.

### Artwork

- **Sources**: Wikimedia Commons and NASA photographs (public domain, CC0, CC BY, CC BY-SA
  only) pinned in `sources/photos.json`; frames of the films themselves for the real titles;
  procedural scenes (`src/art/procedural.ts`) only as the offline fallback. Every photo is
  reviewed at full size before it is pinned: no brands, logos, shop signs, advertising, legible
  plates, vessel names, captions, watermarks or recognisable faces of real people (see
  *Reviewing photos* below). No two titles share a photo.
- **Episode stills**: a series' still photos, then its key image; each further use of the
  same source takes the next framing (wide, tight left, tight right mirrored, high, low
  detail…), so no two episodes repeat a still. Real series use a frame of each episode's own
  footage (the most detailed of five candidates, all clear of text by the footage margin).
- **No text under a logo**: the billboard and detail hero lay the logo over the backdrop, so
  backdrops carry no text at all. For the real films this is a rule `check-art` enforces: key,
  poster and pinned still frames must be clear of the film's text spans and on-screen story
  text (`screenText`: Tears of Steel's PLAYBACK console, holographic captions) by the margin.
  Photo and procedural backdrops carry none by construction (photos are reviewed for signs and
  marks when pinned); the billboard and logo sheets show every backdrop under its logo.
- **Art direction** lives on each seed title (`art`, opaque to the API) in
  `packages/catalog/src/data/art.ts`: photo, focus point, grade, type style, card/poster
  placement. Titles without direction get genre defaults (`src/art/direction.ts`).
- **Grading** (`src/art/grade.ts`): white balance and exposure in linear light, filmic curve,
  split toning, lifted blacks, vignette, seeded grain. Named looks: teal-orange, noir,
  cold-steel, bleach, ember, neon, sepia, moonlit…
- **Title treatments** (`src/art/treatment.ts`): text is shaped with fontkit and drawn as
  outlines (no system fonts), laid out by trying every line break and keeping the largest fit;
  kicker articles, per-line metal/ember gradients, strokes, glows, drop shadows, grain,
  distressed wear, prestige rules. ~40 named styles in `src/art/styles.ts` over 48
  self-hosted OFL/Apache fonts in `fonts/`.
- **Outputs** (`blobKeys` layout): backdrop 640/1280/1920, card 320/480/640/960, poster
  200/400/600/800, logo 320/640/1280 (alpha), stills 320/640/960, avatars 320×320 WebP.

## Reviewing photos

`photos search "<query>"` makes a numbered sheet of candidates; pin one with `photos pick`.
Before pinning, open the full-size file and look for anything a member would read as a third
party: shop and business signs, brand marks on vehicles, buildings or products, advertising,
licence plates, ship names, transit-operator logos, town signs and coats of arms, captions and
publisher marks on old prints, photographer watermarks, and faces that could identify a real
person (distant, silhouetted or turned-away figures are fine). Then `make content` and
`check-art`. An automated OCR + face-detector pass was tried and dropped: it missed most signs
and flagged animals and carved stone as faces, so the review is visual.

## Reviewing footage

Burned-in cards (studio logos, "presents", title cards, credits, licence cards) are measured,
not guessed. For each open film: a 1 fps frame grid of the whole film (`work/review-frames/
dense`), on which every stretch with any visible text is marked; then a fine strip around each
edge at every third frame (1/8 s), from which the span runs from the first frame where any of
the text shows (fades included) to the first clean frame. Spans are stored as measured;
`TEXT_MARGIN_SEC` (1 s) is added on both sides wherever footage is lent or a frame is used as
art, and windows are cut to whole seconds inwards. Diegetic text (interface words in Tears of
Steel) is listed separately as `screenText`: fine in playback, never in key art.

Automated text detection was tried and was unreliable (it missed small studio cards and
faint fades), so the check stays visual, and it is part of every build's review output:
`contact-sheets` writes `boundaries-NN.jpg`, one row per playable clip (complete films,
feature cuts, episode chapters, previews of every kind) with its first frame, +0.5 s, +1 s,
+3 s, the middle, −3 s, −1 s and the last frame, decoded from the packaged output, labelled
with every title that plays it and its source film and window. No row of a fictional title may
show a source film's title, credits, studio card or watermark; the first frames of a later
chapter are its recap and must be clean too. Look at every sheet whenever cuts change.

## Cache layout

```
.cache/media/
  downloads/films/       source films (+ .download.json hash record, .probe.json)
  downloads/subs/<film>/ subtitles as published
  downloads/photos/      photos at 1920 px
  art/public/img/…       rendered artwork (blob layout)
  work/art/              art step stamps, extracted film frames, backdrop masters
  work/<profile>/        video step stamps (incl. measured preview audio), upload records
  work/review-frames/    1 fps grids and fine edge strips used to measure text spans
  work/preview-strips/, work/boundary-strips/   cached rows of the review sheets
  work/validate/         frames decoded by validate-manifest
  <profile>/             publishable tree: public/…, vod/…, manifest.json
  review/<profile>/      contact sheets
```

Every step is keyed by a hash of its inputs (data, source SHA-256, code of its stage, Docker
image, fonts). A re-run with nothing changed only checks stamps. Changing a title's art
direction re-renders that title; changing `src/video/*` re-packages video; editing the
Dockerfile rebuilds the image and re-packages everything. Downloads are verified (SHA-256
recorded on first download) and never repeated.

## Adding things

**A fictional title**: add a draft to a batch in `packages/catalog/src/data/titles/` (format
in `draft.ts`; `pnpm --filter @webflix/catalog test` lints the copy). Its footage, preview and
episode assets are assigned automatically. For artwork, add a query to
`sources/photo-queries.json` and run `photos auto <titleId>` (or `photos search "<query>"`,
look at the numbered sheet, then `photos pick <slug>-1 "<query>" <n>`), optionally add art
direction in `art.ts`, then `make content`.

**A source film**: add an `OpenFilm` to `open-films.ts` (verify the licence on the official
project page; prefer Blender's own video server or download.blender.org), with its
subtitles, measured text spans (see *Reviewing footage*), opening titles, credits timecode,
chapters and highlight windows, its rating and the genres it can stand in for. Add a title for it in
`OPEN_TITLES` with its real credits, then `make content` and `make content-credits`.

**A font**: add it to `fonts/fonts.json`, run `node tools/media/src/cli.ts fetch-fonts`, commit
the TTF and licence, reference it from a style in `src/art/styles.ts`.

## Upload targets (the S3 / R2 seam)

`upload --target <scheme>:<rest>` resolves the scheme in `src/upload/targets.ts`:

```ts
export const BLOB_TARGETS: Record<string, BlobStoreFactory> = {
  fs: (spec) => createFsBlobStore({ root: spec.path ? resolve(REPO_ROOT, spec.path) : defaultBlobDir() }),
  s3: async () => (await import("@webflix/adapters-node/s3")).createS3BlobStoreFromEnv(),
};
```

Adding a store is that one line: anything returning a `BlobStore` works. `s3:` reads the same
`WEBFLIX_S3_*` variables as `apps/api` (k8s: `deploy/kind/media.sh` runs it in the media-tools
image against the in-cluster bucket). Code that already holds a store calls
`uploadProfile(profile, store, targetId)` from `src/upload/upload.ts` directly (Cloudflare:
`apps/edge/scripts/lib/media.ts` with R2). Uploads are
concurrent and idempotent: each object carries its SHA-256 in custom metadata; a per-target
record avoids a HEAD per object on re-runs (an object is skipped when the store lists it at
the recorded size). The manifest is uploaded last, to `manifests/media-<profile>.json` and
`manifests/media.json` (what a seed job in k8s or Cloudflare reads). `--prune` deletes stored
`public/` and `vod/` objects the profile no longer has. Cache headers: `public/*` immutable,
playlists `private, max-age=300`, other `vod/*` immutable.

## Timings and sizes

Measured on a 12-core arm64 Mac (Docker with 12 CPUs), 16 MB/s downloads:

| | first run | re-run | size |
| --- | --- | --- | --- |
| films (13 masters) | ≈ 3 min | cached | 2.0 GB in `downloads/` |
| photos (≈ 180 used) | over an hour (Wikimedia throttling, see below) | cached | |
| art (119 titles, 420 stills, 28 avatars) | 3 min 15 s | stamps only (< 1 s) | 0.3 GB |
| video fast (165 assets) | 10 min 20 s | stamps only (0.3 s) | 2.1 GB (`.cache/media/fast` 2.4 GB with art) |
| video full (165 assets, complete films, 5 rungs) | 41 min | stamps only | 10.3 GB (`.cache/media/full` 11 GB) |
| upload fast to `fs:` | 9 s (13 k objects, 2.3 GB) | 3.7 s, nothing sent | |
| `validate-manifest` (timing, and decoding all 119 previews) | 1 min (fast), 1 min (full) | same | |
| `contact-sheets --only boundaries` (165 rows) | 45 s | 4 s (rows cached by asset bytes) | |
| `make content PROFILE=fast`, nothing changed | | 30 s (most of it the preview checks) | |

**Wikimedia throttling.** upload.wikimedia.org throttles bulk thumbnail traffic from one IP
(429 with a two-minute Retry-After, and HTTP/1.1 clients are throttled outright). The pipeline
uses HTTP/2, the standard 1920 px size, one request at a time and a host-wide pause on 429. A
build spends at most `WEBFLIX_MEDIA_PHOTO_BUDGET_SEC` (default 600) fetching photos; titles
whose photo is not cached yet get procedural art that is *not* cached, so the next build
upgrades them. `photos fetch` downloads the whole library with no budget.

## Troubleshooting

- **`docker: command not found` / daemon not running** — start Docker Desktop; `make doctor`.
- **A film or photo keeps failing** — `WEBFLIX_MEDIA_OFFLINE=1 make content` builds with what is
  cached (synthetic video, procedural art for the rest); run again online later.
- **Stale output after editing code** — stage code is part of every cache key; if in doubt,
  `make content-clean` (keeps downloads and art) or delete `.cache/media/work/art` to re-render art.
- **Disk** — `make content-status`; downloads ≈ 2 GB, art ≈ 0.3 GB, fast ≈ 2.4 GB, full ≈ 11 GB.
- **Contact sheets look stale** — they read the profile's manifest; rebuild first.
