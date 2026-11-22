# services/recs: the offline recommendation pipeline

Python batch jobs that turn the behaviour event lake into the recommendation artefacts the
TypeScript serving side imports (docs/BLUEPRINT-M2.md §6, §7, §8.1). Nothing here runs per
request. The design, the evaluation and the results are in
[docs/RECOMMENDATIONS-ML.md](../../docs/RECOMMENDATIONS-ML.md); this file is the operating manual
and the **contract for the artefact importer** (section "Artefacts").

```
simulate ──► events/ (lake) ──compact──► build-dataset ──► train ──► evaluate (gate) ──► score ──► publish
                                                                                        recs/v={run}/…   recs/current.json
analyse-experiments ◄── events/ (exposures, playback, billing)
```

## Quick start

```sh
make recs-setup            # services/recs/.venv from uv.lock (Python 3.13; uv cache in .cache/recs/uv)
make recs-test             # ruff, mypy --strict, pytest (unit + end to end), tsc on the Node scripts
make recs PRESET=smoke     # the whole pipeline in about a minute; the gate refuses to publish at
                           # this size (too little data to beat the engine) and the run says so
make recs                  # the documented full run (PRESET=full), ~10-15 minutes on a laptop
make recs-image            # the job image webflix-recs:dev
```

`make recs` starts from an empty `.cache/recs/<preset>/` and leaves `store/` (the blob store),
`truth/` (the simulator's ground truth) and `reports/` (`evaluation.json`, `experiments.json`,
`summary.md`, one JSON summary per step with time and peak memory).

Requirements: `uv` and Node.js (already needed by the repository). Nothing is installed
system-wide; every dependency installs from a wheel (no compiler, no system library).

## Commands

`webflix-recs [--store DIR|s3://bucket/prefix] [--workers N] <command> …` Every command reads and
writes through the store, logs progress on stderr and prints a JSON summary on stdout (with
`wallSeconds` and `maxRssMb`).

| Command | Reads | Writes |
| --- | --- | --- |
| `simulate --truth DIR [--preset smoke\|medium\|full] [--accounts N --days N --seed N --start ISO --impression-sample-rate R --experiment key[:effect=0.1][:variants=control=50,treatment=50]]` | `catalog/current.json` | `events/…` (lake), `experiments/definitions.json` (when experiments are configured), ground truth in DIR |
| `compact [--now ISO] [--grace-minutes 15] [--delete-sources] [--erase FILE]` | `events/…` | `events/dt=…/hh=…/part-{digest}.parquet` + `_compaction.json`; `events-quarantine/…` |
| `build-dataset --dataset ID --as-of ISO` | lake, catalogue | `recs-work/datasets/ID/{playback,actions,impressions,profiles,accounts}.parquet`, `manifest.json` |
| `train --dataset ID [--as-of ISO] [--params FILE] [--run ID]` | dataset | `recs-work/runs/{run}/{manifest.json,models.npz,ranker.pkl,ranker-naive.pkl,propensity.pkl}` |
| `evaluate --run RUN --dataset ID [--truth DIR] [--external NAME=FILE …] [--cutoff ISO] [--horizon-days 7] [--bootstrap 1000] [--gate-metric M]` | run, dataset, truth | `recs-work/evaluations/{recipeHash}/{run}.json` (+ `--out FILE`) |
| `score --run RUN [--dataset ID]` | run, dataset | `recs/v={run}/…` (manifest last) |
| `publish --run RUN [--keep 3]` | version, evaluations | `recs/history/…`, then `recs/current.json` (exit 3 when refused) |
| `validate [--run RUN]` | a version (default: the current one) | nothing (exit 4 when invalid) |
| `analyse-experiments [--definitions FILE] [--as-of ISO] --out FILE` | lake, `experiments/definitions.json` | the report |

Environment: `WEBFLIX_RECS_STORE` (default store), `WEBFLIX_RECS_THREADS` (native thread budget,
default min(8, CPUs/2)), `WEBFLIX_S3_ENDPOINT`, `WEBFLIX_S3_REGION`, `WEBFLIX_S3_BUCKET`,
`WEBFLIX_S3_ACCESS_KEY_ID`, `WEBFLIX_S3_SECRET_ACCESS_KEY`, `WEBFLIX_S3_FORCE_PATH_STYLE` (the
same variables as the API).

### The production flow (what a scheduler runs)

1. `compact` every hour (closed hours only; idempotent).
2. Daily: `build-dataset --as-of now`; `train --as-of now-7d` and `evaluate` (the backtest of the
   current code and parameters: its recipe hash); `train --as-of now`; `score`; `publish`.
   `publish` refuses unless an evaluation of the *same recipe* (code digest + parameters) passed
   the gate, and unless the scored version validates.
3. `analyse-experiments` daily, results to the admin console's aggregates.

## Store layout

One bucket (the platform's `webflix-media`), private prefixes only:

| Prefix | Written by | Content |
| --- | --- | --- |
| `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz` | ingestion (today: the simulator) | the event lake, partitioned by **receipt** hour |
| `events/dt=…/hh=…/part-{digest}.parquet`, `_compaction.json` | `compact` | one deduplicated Parquet file per closed hour, and which objects it covers |
| `events-quarantine/…` | `compact` | lines that failed validation (only when sources are deleted) |
| `catalog/v={version}/snapshot.json`, `catalog/current.json` | catalogue export job | see "Catalogue snapshot" |
| `experiments/definitions.json` | experiments export (today: the simulator) | pre-registered definitions |
| `recs-work/…` | this pipeline | datasets, runs, evaluations (never read by the request path) |
| `recs/v={run}/…`, `recs/current.json`, `recs/history/…` | `score`, `publish` | the artefacts (below) |

Locally the store is a directory in the **dev mode's filesystem `BlobStore` layout**
(`packages/adapters-node/src/fs-blob-store.ts`): objects under `data/` with every byte outside
`[a-z0-9._-]` percent-encoded and a `~` suffix, JSON sidecars under `meta/`, writes renamed from
`tmp/`. So the dev API's lake (`.data/blobs`) can be read directly, and the TypeScript importer
reads artefacts through its own `createFsBlobStore` with no conversion.

## Catalogue snapshot

`node services/recs/scripts/export-catalog.ts --store <dir> [--anchor ISO]` imports
`@webflix/catalog` read-only (source path: this directory is not a workspace package) and writes,
through the filesystem `BlobStore` adapter:

* `catalog/v={catalogVersion}/snapshot.json`: `schemas/catalog-snapshot.schema.json`. Titles with
  id, type, name, tagline, synopsis, release year, maturity, ordered genre ids, moods, original
  flag, `addedAt` (ISO; the seed's `addedDaysAgo` resolved against `anchor`, as the seeder
  does), seed popularity, movie runtime, episodes in viewing order (`seq`), credits (person,
  role, billing position); genres; people; maturity levels in order; `anchor`; `seedVersion`.
  `catalogVersion` = first 16 hex characters of SHA-256 of the canonical JSON of the content (the
  loader recomputes it).
* then `catalog/current.json`: `{format: "webflix.catalog-pointer", formatVersion: 1,
  catalogVersion, key, sha256, anchor}`, written last.

A production export job writes the same two objects through the S3/R2 store.

## Event schema (provisional) and the decisions the blueprint left open

`schemas/event.schema.json` (JSON Schema 2020-12) is authoritative here until
`packages/contracts` exports its own; `src/webflix_recs/schemas.py` is the only module that
reads it. Every event the simulator writes and every event the pipeline reads is validated
(`jsonschema-rs`); invalid events are counted and skipped (quarantined by compaction).
Decisions for the contracts author to adopt or correct:

1. **Envelope fields**: `eventId` (UUIDv7, lowercase), `type`, `version` (per-type payload version,
   integer, 1 today), `source` (`client` | `server`, enforced per type), `occurredAt`,
   `receivedAt` (RFC 3339 UTC with milliseconds, exactly `Date.toISOString()`), `deviceId`
   (null allowed on server events), `sessionSeq` (per-device counter within the app session,
   reset at app start; null on server events), `app {platform, version}` (`server` platform for
   server events), `context`, `subject`, `payload`.
2. **Server-added fields live in `subject`** (`account`, `profile`, `plan`, `country`,
   `restricted`, `consent {analytics, personalisation}`), so the client/server boundary is a
   single object the endpoint overwrites.
3. **Pseudonymous keys** for both account and profile (the blueprint only mentions the account):
   `base64url(HMAC-SHA256(key, "account:" + id | "profile:" + id))`, first 22 characters (128
   bits). Recommendation artefacts are keyed by the profile's; serving recomputes it.
4. **`restricted`** = the profile's standing is `kids` or `restricted` (lowered maturity ceiling)
   per `standingOf()` in packages/core.
5. **Consent is stamped on every event** (state at receipt) and a new server event
   **`consent.change {purpose, granted, source}`** is emitted when it changes, so a withdrawal is
   honoured even if the member never comes back. Consumers use the account's latest stamp.
6. **`context`**: `surface` (enum), `rowId` (the engine's row ids; `{view}:billboard` for the
   billboard), **`rowRank`** (new: 1-based module position on the page, billboard = 1),
   `rank` (1-based card position in the row), `experiments` (key → variant), and **`policy
   {id, explore}`** (new: which ranking policy built the page and whether its order was
   randomised for exploration; needed for unbiased learning and off-policy evaluation).
7. **Impression sampling is per app session**: a sampled session logs all its impressions and
   row views, so pages stay whole; `sampleRate` is in the payload of `impression` and `row.view`.
8. **Type names** are dotted: `impression`, `row.view`, `title.open`, `preview.start`,
   `preview.complete`, `search.query`, `search.click`, `list.add`, `list.remove`, `rating.set`,
   `rating.clear`, `signup.step`, `client.error`, `playback.start`, `playback.progress`,
   `playback.complete`, `playback.abandon`, `billing.transition`, `auth.signin`, `auth.signup`,
   `experiment.exposure`, `consent.change`.
9. **Playback payloads**: `playbackSessionId`, `titleId`, `episodeId|null`, `positionSec`,
   `durationSec`, `watchedSec` (credited to the playback session so far, the server's credit
   clock). `progress` is emitted as credited watching crosses each quarter; `complete` at 95%
   (the engine's `COMPLETION_RATIO`); `abandon` has a `reason`.
10. **`search.query` carries no query text** (`queryLength`, `resultCount` only); `search.click`
    adds `titleId`, `resultRank`.
11. **`row.view.rowKind`** = the engine's `ROW_KINDS` plus `billboard` and `top-picks`.
12. **`auth.signin` carries no profile** (it happens at the profile gate). Kids profiles emit only
    server playback events.
13. **`billing.transition {from, to, planId}`** with the states of §5.2.
14. **Schemas are closed** (`additionalProperties: false`): a new optional field is a new
    `version` of its type; readers accept the versions they know and count the rest.
15. **Lake partition** = the hour of `receivedAt` (closed hours never change; late events land
    in the hour they arrive).

## Dataset rules (`build-dataset`)

Knowledge cutoff by `receivedAt`; validation; deduplication by `eventId` (earliest receipt
kept); per-device clock correction (median offset of a device's events, gaps of 12 h or more
ignored as offline delay), clamped to receipt; client events older than 7 days at receipt
dropped; every `restricted` event dropped, and every profile whose latest state is restricted or
whose account's latest consent lacks personalisation dropped with its whole history; signed-out
and gate events dropped; unknown title ids dropped. Each rule is counted in the dataset manifest.
Tables keep `received_at` so any earlier cutoff can be rebuilt from one dataset. Impressions are
labelled from what followed *that card*: `opened` (a `title.open` with the same `rowRank` and
`rank` within 30 minutes), `started`/`played` (opened, then the title started / watched for at
least 30 s within 30 minutes) and `censored` (right of the first played card in the same
showing of the row: the member had left the row).

## Evaluation and external rankings

`evaluate` backtests a run at its cutoff against random, popularity, co-watch, ALS, content,
the ranker (debiased and naive), the final re-ranked list, the oracle (with `--truth`) and **the
real milestone 1 engine**: the harness writes each profile's library signals as of the cutoff
and runs `scripts/rule-engine-rankings.ts`, which builds the catalogue with the seeder's
`buildCatalogWrite`, popularity with `baselineStats` and `computePopularity`, and calls
`Personalization` from `@webflix/core` (read-only import). Any other system is compared the same
way through an **external rankings file** (`--external NAME=FILE`), NDJSON:

* line 1, `schemas/rankings-header.schema.json`:
  `{"format": "webflix.rankings", "formatVersion": 1, "system": "<name>", "asOf": "<ISO>", "description"?, "generatedAt"?, "catalogVersion"?}`
  The harness refuses a file whose `asOf` is after the evaluation cutoff.
* then one line per profile, `schemas/rankings-line.schema.json`:
  `{"profileKey": "<22 chars>", "titleIds": ["t-…", …], "scores": [..] | null}`, best first.

Titles unknown, not yet available at the cutoff or already watched are dropped from every
system's list alike. The gate, the metrics and why the primary metric is what it is are in
docs/RECOMMENDATIONS-ML.md.

## Artefacts: the contract for the importer

Everything below is versioned by `formatVersion` (major) and `formatMinor`. **Readers refuse an
unknown major and ignore what they do not know within a major** (new columns, new JSON fields,
new row types). A minor bump only ever adds; anything else is a new major.

### Discovery and atomicity

1. Read `recs/current.json` (`schemas/recs-pointer.schema.json`):
   `{format: "webflix.recs-pointer", formatVersion: 1, run, manifest, manifestSha256, publishedAt, previous, gate}`.
   `manifest` is `recs/v={run}/manifest.json`; `previous` is the run it replaced (rollback: point
   back at it). `gate` summarises the evaluation that allowed the publish.
2. Read the manifest; check its SHA-256 equals `manifestSha256`; check `formatVersion == 1`.
3. For each entry of `manifest.files`, read `recs/v={run}/{path}` and check `bytes` and `sha256`.
   Refuse the version on any mismatch (keep serving the previous import).
4. Import (below), then record `run` as the active model version.

The pointer is written last, by one atomic object write, after the version was completely
written and validated; a version directory without `manifest.json` is incomplete and is never
pointed at. Readers never list `recs/`.

### `manifest.json` (`schemas/recs-manifest.schema.json`)

| Field | Type | Meaning |
| --- | --- | --- |
| `format`, `formatVersion`, `formatMinor` | `"webflix.recs"`, 1, 0 | versioning |
| `run` | string `YYYYMMDD-HHMMSS-<recipe8>` | the model version: knowledge cutoff (UTC) and recipe |
| `recipeHash` | 16 hex | code digest + parameters that produced it |
| `createdAt`, `asOf`, `expiresAt` | ISO instants | `asOf` = knowledge cutoff; after `expiresAt` (asOf + 3 days) the lists are stale: fall back to the milestone 1 rules |
| `catalogVersion` | string | catalogue snapshot the run used |
| `code`, `data` | objects | provenance (git commit, dirty flag, code digest; dataset, cutoffs) |
| `evaluation` | object or null | the gate result that allowed publishing |
| `counts` | `{profiles, titles, neighbourRows, profileItems}` | totals over the files |
| `rowTypes` | string[] | row types the payloads may contain |
| `tables` | `{name: {columns: [{name, type, nullable, description}], orderBy, primaryKey}}` | self-description of the two tables below |
| `files` | `[{path, table, rows, bytes, sha256, firstKey, lastKey}]` | every Parquet file; `firstKey`/`lastKey` are the first and last sort keys in it |

### Parquet conventions

Snappy compression, row groups of at most 10,000 rows, flat columns of three physical types
only: UTF-8 strings (`string`), 32-bit integers (`int32`) and 32-bit floats (`float32`); no
nulls in any column, no nested types, no timestamps (times are in the manifest). Readable by any
Parquet reader, including small pure-JavaScript ones (for example `hyparquet`).

### Table `neighbours` (`neighbours/part-00000.parquet`)

Item-to-item neighbours for More Like This, Because You Watched and session re-ranking.

| Column | Type | Meaning |
| --- | --- | --- |
| `title_id` | string | source title |
| `rank` | int32 | 1-based, contiguous per `title_id` |
| `neighbour_id` | string | similar title (never `title_id` itself) |
| `score` | float32 | similarity in (0, 1], non-increasing with `rank` |
| `support` | int32 | profiles who watched both (0: the similarity is content-only, e.g. a new title) |

Ordered by `title_id` (byte order) then `rank`. At most 40 rows per title. Only titles that had
arrived by `asOf`, as sources and as neighbours. Not maturity-filtered (the engine filters).
Score: co-watch similarity with shrinkage blended with content similarity, co-watch weighted
by the pair's support (docs/RECOMMENDATIONS-ML.md).

### Table `profiles` (`profiles/part-NNNNN.parquet`)

One row per scored profile: its lists as one JSON value, so serving reads one key per profile.

| Column | Type | Meaning |
| --- | --- | --- |
| `profile_key` | string | pseudonymous profile key (22 characters, base64url) |
| `payload` | string | UTF-8 JSON, `schemas/recs-profile-lists.schema.json` (below) |
| `items` | int32 | number of items over all rows of the payload |
| `bytes` | int32 | UTF-8 length of `payload` |

Sharding: `NNNNN` is 5 digits from `00000`; a profile is in shard
`uint64_be(sha256(profile_key)[0:8]) mod shardCount`, so each profile is in exactly one file;
at most 25,000 rows per file. Within a file, rows are ordered by `profile_key` (byte order).
Scored profiles: unrestricted, consenting to personalisation, seen in the last 60 days, account
not cancelled. **Restricted (kids, capped) profiles are never present**, and neither is any
profile whose account withdrew consent.

### The payload (one profile's lists)

```json
{
  "v": 1,
  "profile": "pL4sD8fG2hJ6kZ1xC5vB9n",
  "run": "20261027-000000-6d8cf38c",
  "generatedAt": "2026-10-27T03:12:44.120Z",
  "expiresAt": "2026-10-30T00:00:00.000Z",
  "rows": [
    {"type": "personal", "param": null, "items": [["t-sintel", 0.41213], ["t-breakline", 0.38871]]},
    {"type": "top-picks", "param": null, "items": [["t-breakline", 0.38871], ["t-sintel", 0.41213]]},
    {"type": "billboard", "param": null, "items": [["t-glasshouse", 0.36602]]},
    {"type": "because-you-watched", "param": "t-tears", "items": [["t-cosmos", 0.7731]]}
  ]
}
```

| Row type | Order | Length | Score |
| --- | --- | --- | --- |
| `personal` | by score, descending | ≤ 60 | the ranker's estimate of P(qualified play \| the title is seen), 0..1. Use it to order any row the engine builds (genre rows, Originals, Trending's affinity term). Titles not listed: order after listed ones by the engine's own score. |
| `top-picks` | re-ranked (diversity, freshness, repetition); **not** by score | ≤ 30 | the same ranker estimate (for display or blending; do not re-sort) |
| `billboard` | re-ranked, unstarted titles only | ≤ 5 | as above |
| `because-you-watched` | by score, descending; `param` = source title id | ≤ 3 rows × ≤ 15 | 0.6 × neighbour similarity + 0.4 × the title's rank percentile for this profile |

Every list excludes titles the profile played for 30 s or more, finished or disliked, and titles
not yet arrived at `asOf`. No title appears twice in a row. The engine stays the authority: it
applies maturity, entitlement, dislikes made after `asOf`, badges and deduplication to whatever
it takes from here. Payloads are about 3-4 KB; ~140 items at most.

### Loading it (the importer)

* **D1 / SQLite / PostgreSQL, neighbours**: e.g.
  `recommendation_neighbours(model_version, title_id, rank, neighbour_id, score, support)` with
  primary key `(model_version, title_id, rank)`: 6 bound parameters per row, so **16 rows per
  `INSERT`** stays within the 100-parameter limit (D1). Insert the new `run` alongside the old,
  then switch the active version, then delete the old rows.
* **Per-profile lists, SQLite / PostgreSQL**: `recommendation_profiles(profile_key PRIMARY KEY,
  model_version, payload, expires_at)`: 4 parameters per row, **25 rows per `INSERT … ON
  CONFLICT DO UPDATE`**.
* **Per-profile lists, Cloudflare KV**: key `recs:v1:{profile_key}`, value `payload` (already the
  serialised JSON), with an absolute expiration at `expiresAt` plus a grace period; written with
  KV bulk writes in batches (verify the current bulk-write limits in Cloudflare's documentation;
  a shard of 25,000 rows splits into a few requests). Each value names its `run`, so a reader that
  sees old and new values side by side during the import is still consistent per profile.
  After the import, delete keys of profiles present in the previous version's files and absent
  from the new one (or let them expire).
* Read one shard at a time: shards are independent and bounded, so an importer streams the
  version with constant memory and can resume per shard.

## Experiments

`experiments/definitions.json` (`schemas/experiment-definitions.schema.json`) pre-registers
each experiment: key, variants and weights, unit `profile`, primary and secondary metrics
(`qualified_plays`, `watch_hours`, `any_play`, `active_days`, `retained`), alpha, power,
minimum detectable effect, `registeredAt` ≤ `startsAt`, `endsAt`, analysis method `msprt` with
daily looks, SRM threshold. `analyse-experiments` writes
`schemas/experiment-report.schema.json`: units per variant, exclusions (restricted, no analytics
consent, unknown or multiple variants), sample-ratio check, per-variant means and intervals,
differences and relative lifts, always-valid p-values and confidence sequences (mSPRT), the
fixed-horizon test (labelled valid only at `endsAt`), the daily looks and the decision.

## Running as a job

`make recs-image` builds `webflix-recs:dev` (two stages on a digest-pinned
`python:3.13-slim-bookworm`, uv from a digest-pinned image, wheels only, non-root user 10001,
entrypoint `webflix-recs`). It writes nothing outside the store and `/work` (mount an emptyDir;
the root filesystem can be read-only). Configure the store with the `WEBFLIX_S3_*` variables and
`--store s3://<bucket>`. The image has no Node: run `scripts/rule-engine-rankings.ts` in an image
that has the repository's TypeScript packages (the API image's source tree), and pass its output
with `evaluate --external rule-engine=<file> --external rule-engine-home=<file>`.

## Dependencies

All pinned in `pyproject.toml` and locked with hashes in `uv.lock`; all ship wheels for macOS
arm64 and Linux; `[tool.uv] no-build-package` forbids source builds. Installed sizes (macOS):

| Package | Size | Why |
| --- | --- | --- |
| polars 2.1 | 170 MB | the lake and dataset work: NDJSON parsing, group-bys, as-of joins, Parquet read and write, in Rust and multi-threaded. The largest dependency; pyarrow + pandas would be larger. |
| scipy 1.18 | 82 MB | sparse matrices for TF-IDF, statistics (chi-square, normal) in the experiment analysis; required by scikit-learn anyway |
| scikit-learn 1.9 | 36 MB | TF-IDF, truncated SVD, and the gradient-boosted ranker (histogram GBDT). Chosen over LightGBM and XGBoost, whose macOS wheels need a system OpenMP (`brew install libomp`); scikit-learn bundles its own |
| boto3 / botocore 1.44 | 29 MB | the S3-compatible store (Garage, R2, AWS); imported only when the store is `s3://` |
| numpy 2.5 | 26 MB | everything numeric |
| jsonschema-rs 0.62 | 12 MB | JSON Schema 2020-12 validation in Rust: every event validated at ~1-2 µs |
| orjson 3.13, threadpoolctl 3.8 | < 1 MB | fast JSON; capping native thread pools on shared machines |

Development only: pytest, ruff, mypy, moto (an in-process S3 stand-in for the storage tests; no
Docker). No deep-learning stack: content vectors are TF-IDF + SVD (docs/RECOMMENDATIONS-ML.md).

## Testing

`make recs-test`: ruff (format and lint), `mypy --strict` over `src` and `tests`, `tsc` over
`scripts/`, and pytest (about a minute): storage layout and S3 contract (moto), schemas,
simulator determinism and privacy, lake compaction, dataset rules (duplicates, late events,
clock skew, consent, restricted, click attribution and cascade censoring), models on planted data (ALS, co-watch, propensity recovery, EM
vs naive ranker, re-ranking), metrics, experiment calibration (A/A over 300 seeds, planted
effect against computed power, SRM), and the end-to-end pipeline on the real catalogue (the
planted leak, restricted profiles from lake to artefacts, the real rule engine, the gate, atomic
publishing). Biome lints the TypeScript and JSON here as part of the root `pnpm lint`.
