# services/recs: the offline recommendation pipeline

Python batch jobs that turn the behaviour event lake into the recommendation artefacts the
TypeScript serving side imports, the experiment results the staff console shows, and that keep
the lake itself in shape: compaction and erasure (docs/BLUEPRINT-M2.md §6, §7, §8.1). Nothing
here runs per request. The design, the evaluation and the results are in
[docs/RECOMMENDATIONS-ML.md](../../docs/RECOMMENDATIONS-ML.md); this file is the operating manual
and the contract for the three things other parts of the product read:

* the **artefacts** the recommendation importer loads (section "Artefacts");
* the **compacted hours** the data export reads beside the raw lake (section "Compacted hours");
* the **experiment results** the experiments area imports (section "Experiment results");
* the **exports of members' events** the product folds into "Download your data" (section
  "Exports of members' events").

```
 product's lake writer (simulate for tests)
        │
        ▼
 events/dt=…/hh=…/*.ndjson.gz ──compact──► part-*.parquet + _compaction.json   (hourly)
        │        ▲
        │        └── erase ◄── GET /api/admin/v1/system/privacy/erasures; POST …/confirm (daily)
        ▼
 train-and-score: build-dataset ─► train (T-7d) ─► evaluate (gate) ─► train (T) ─► score
        │                                                                    recs/v={run}/…
        ▼
 publish (gate refuses or flips recs/current.json)
 analyse-experiments ─► experiments/results/current.json ◄── the experiments importer
 export-events ◄── pending data exports ─► privacy/export-events/{requestId}/ ◄── the export
```

## Quick start

```sh
make recs-setup            # services/recs/.venv from uv.lock (Python 3.13; uv cache in .cache/recs/uv)
make recs-test             # ruff, mypy --strict, pytest (unit + end to end), tsc on the Node scripts
make recs PRESET=smoke     # the whole pipeline in about a minute; the gate refuses to publish at
                           # this size (too little data to beat the engine) and the run says so
make recs                  # the documented full run (PRESET=full), ~10-15 minutes on a laptop
make recs-fixtures         # rewrite tests/fixtures/compacted (the data export's fixtures)
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
`wallSeconds` and `maxRssMb`). The scheduled jobs and their exit codes are in "Jobs" below.

| Command | Reads | Writes |
| --- | --- | --- |
| `simulate --truth DIR [--preset smoke\|medium\|full] [--accounts N --days N --seed N --start ISO --impression-sample-rate R --object-layout hourly\|writer --experiment key[:effect=0.1][:variants=control=50,treatment=50]]` | `catalog/current.json` | `events/…` (lake), `experiments/definitions.json` (when experiments are configured), ground truth in DIR |
| `compact [--now ISO] [--grace-minutes 15] [--delete-sources] [--erase FILE]` | `events/…` | `events/dt=…/hh=…/part-{sha256-16}.parquet` + `_compaction.json`; `events-quarantine/…`; with `--erase`, then what `erase` writes |
| `erase [--keys api\|FILE\|-] [--confirm api\|FILE\|-\|none] [--reason TEXT] [--watch-days 30]` | erasure keys (staff API or file), everything that holds subject keys | rewritten lake, compacted hours, quarantine, datasets, artefacts; `recs-work/erasure/plan.json`; the confirmation |
| `export-events --requests FILE [--results FILE] [--erasures api\|FILE] [--grace-minutes 15] [--keep-days 7] [--force]` | the requests, the lake, the erasure plan | `privacy/export-events/{requestId}/{events.ndjson.gz,manifest.json}`; the results |
| `train-and-score [--as-of ISO] [--phase all\|prepare\|finish] [--work DIR] [--truth DIR] [--params FILE] [--keep-datasets 3]` | lake, catalogue | `recs-work/datasets/asof-…`, `recs-work/runs/…`, `recs-work/evaluations/…`, `recs/v={run}/…`, `recs-work/scored/latest.json` |
| `build-dataset --dataset ID --as-of ISO` | lake, catalogue | `recs-work/datasets/ID/{playback,actions,impressions,profiles,accounts}.parquet`, `manifest.json` |
| `train --dataset ID [--as-of ISO] [--params FILE] [--run ID]` | dataset | `recs-work/runs/{run}/{manifest.json,models.npz,ranker.pkl,ranker-naive.pkl,propensity.pkl}` |
| `evaluate --run RUN --dataset ID [--truth DIR] [--external NAME=FILE …] [--cutoff ISO] [--horizon-days 7] [--bootstrap 1000] [--gate-metric M] [--engine-input-only DIR]` | run, dataset, truth | `recs-work/evaluations/{recipeHash}/{run}.json` (+ `--out FILE`); with `--engine-input-only`, only the rule engine's input |
| `score --run RUN [--dataset ID]` | run, dataset | `recs/v={run}/…` (manifest last) |
| `publish [--run RUN] [--keep 3]` | version, evaluations (default run: `recs-work/scored/latest.json`) | `recs/history/…`, then `recs/current.json` |
| `validate [--run RUN]` | a version (default: the current one) | nothing |
| `analyse-experiments [--definitions api\|FILE] [--as-of ISO] [--out FILE] [--no-store]` | lake, definitions (staff API, a file, or `experiments/definitions.json`) | `experiments/results/…` (+ `--out FILE`) |

Environment:

* `WEBFLIX_RECS_STORE` (default store), `WEBFLIX_RECS_THREADS` (native thread budget, default
  min(8, CPUs/2));
* the S3-compatible store, the same variables as the API: `WEBFLIX_S3_ENDPOINT`,
  `WEBFLIX_S3_REGION`, `WEBFLIX_S3_BUCKET`, `WEBFLIX_S3_ACCESS_KEY_ID`,
  `WEBFLIX_S3_SECRET_ACCESS_KEY`, `WEBFLIX_S3_FORCE_PATH_STYLE`;
* the staff API, for `erase --keys api` and `analyse-experiments --definitions api`:
  `WEBFLIX_ADMIN_API_URL` (e.g. `https://webflix.example/api/admin/v1`) and a bearer token, either
  `WEBFLIX_STAFF_TOKEN`, or `WEBFLIX_STAFF_TOKEN_URL` + `WEBFLIX_STAFF_CLIENT_ID` with
  `WEBFLIX_STAFF_CLIENT_SECRET` (client credentials: a service account of the staff issuer
  holding `admin` for erasures, `experiments` for definitions, in the `webflix-admin-api`
  audience) or `WEBFLIX_STAFF_REFRESH_TOKEN`, and optionally `WEBFLIX_STAFF_SCOPE`. The
  development issuer has no client-credentials grant: in dev, pass an access token.

## Jobs: what a scheduler runs

Six jobs, one entry point each, all against the same store (`--store DIR` or
`--store s3://bucket/prefix` with the `WEBFLIX_S3_*` variables: Garage on Kubernetes, R2's S3
API on Cloudflare, where the same image runs outside Workers). Each prints one JSON summary on
stdout and logs on stderr.

| Job | Entry point | Inputs | Outputs | Idempotence | Suggested schedule |
| --- | --- | --- | --- | --- | --- |
| compact | `webflix-recs compact [--delete-sources]` | raw objects of closed hours (end + 15 min grace) | one Parquet file and `_compaction.json` per hour; `events-quarantine/` | an unchanged hour is skipped; a straggler makes its hour recompacted; deleting sources only ever follows the manifest that covers them | hourly, at :20 |
| erase | `webflix-recs erase` | pending keys from `GET /system/privacy/erasures` (or `--keys FILE`) | every subject-bearing file rewritten, verified; `POST …/confirm` (or `--confirm FILE`) | rewrites only what still matches; keys and discovered profile keys are in the plan before anything is rewritten; nothing confirmed before a full verification passes; confirmed keys watched 30 days | daily, after a compaction |
| train and score | `webflix-recs train-and-score` (or `--phase prepare`, the Node step, `--phase finish`) | the lake at the knowledge cutoff T, the catalogue | dataset, backtest and production runs, the evaluation (gate), the scored version `recs/v={run}/`, `recs-work/scored/latest.json`; never publishes | ids derive from T and the recipe; a complete version is never rescored (exit 0, `already-scored`) | daily |
| export events | `webflix-recs export-events --requests FILE --results FILE` | pending export requests (a file today; the product's route later) | each request's events as stored, under `privacy/export-events/{requestId}/`; the results for the product | a complete output for the same account and window is kept, not rewritten; a run that failed half-way writes again; erased subjects yield nothing | every few minutes, or on demand |
| publish | `webflix-recs publish` | the scored run, the evaluations | `recs/current.json` (and history), or nothing | publishing the current run again is `unchanged`; refused (exit 3) unless an evaluation of the same recipe passed the gate | daily, after train and score |
| analyse | `webflix-recs analyse-experiments --definitions api` | the lake at T, the product's definitions | `experiments/results/r={run}/…`, then `experiments/results/current.json` | a run is a new computation (`computedAt`); the importer's write is keyed by experiment and `computedAt` | daily |

T, the knowledge cutoff of `train-and-score` and `analyse-experiments`, defaults to the end of
the last closed hour (now minus the 15-minute grace, floored to the hour): every event received
before it is in the lake by then (playback events reach the lake through an outbox within
minutes of their receipt), so a rerun later reads the same data.

**Exit codes** (every command): 0 done (including nothing to do); 1 an unexpected failure (the
traceback is on stderr; retry is safe for every job); 2 a usage error; 3 `publish` refused
(the gate did not pass, or the version is invalid); 4 `validate` found the version invalid; 5
`erase` verification found something left: nothing was confirmed; 6 the staff API refused or
could not be reached; 7 the rule engine's rankings are unavailable (no Node on PATH and no
`--phase` split: see below); 8 `export-events` failed for at least one request (the results
say which; the others completed); 75 the lake is busy (another compaction or erasure holds the lease):
try again later.

**The lake lease.** `compact` and `erase` both rewrite hours (a new Parquet file, a manifest
flip, deletions), so each holds `recs-work/locks/lake.json` while it runs and refuses to start
(exit 75) while another holder runs; `export-events` holds it too, so an erasure never
interleaves with an export of the same member. The lease is created with a conditional write: atomic on the
filesystem layout (a hard link), and `PutObject` with `If-None-Match: *` on an S3-compatible
store (verified here against moto only; AWS S3 supports it; check R2's and Garage's current
documentation before relying on it). A store that answers `NotImplemented` gets check-then-write,
which is not atomic: there, also schedule the two jobs so they cannot overlap. A lease expires
after 6 hours, so a job killed half-way does not block the lake. Readers never take it.

**The rule engine in a job.** `evaluate` compares against the real milestone 1 engine, which is
TypeScript (`scripts/rule-engine-rankings.ts`, importing `@webflix/core`); the job image has no
Node. Either run `train-and-score` where Node and the repository's packages are present
(`--phase all`, the default), or split it around a Node step sharing a work directory, as a
Kubernetes Job with two init containers and one container on an `emptyDir` at `/work`:

```sh
webflix-recs train-and-score --phase prepare --work /work     # recs image: dataset, backtest run, engine input
node services/recs/scripts/rule-engine-rankings.ts \
  --input /work/engine-input.ndjson --out-dir /work           # an image with the repository's packages
webflix-recs train-and-score --phase finish --work /work      # recs image: evaluate, production run, score
```

The image: `make recs-image` builds `webflix-recs:dev` (two stages on a digest-pinned
`python:3.13-slim-bookworm`, uv from a digest-pinned image, wheels only, non-root user 10001,
entrypoint `webflix-recs`). It writes nothing outside the store and `/work` (mount an emptyDir;
the root filesystem can be read-only).

## Store layout

One bucket (the platform's `webflix-media`), private prefixes only:

| Prefix | Written by | Content |
| --- | --- | --- |
| `events/dt=YYYY-MM-DD/hh=HH/{uuid}.ndjson.gz` | the product's lake writer (tests: the simulator) | the event lake, partitioned by **receipt** hour |
| `events/dt=…/hh=…/part-{sha256-16}.parquet`, `_compaction.json` | `compact`, `erase` | one deduplicated Parquet file per closed hour, and which raw objects it covers ("Compacted hours") |
| `events-quarantine/dt=…/hh=…/{sha256-16}.ndjson.gz` | `compact` | lines that failed validation, once each |
| `catalog/v={version}/snapshot.json`, `catalog/current.json` | catalogue export job | see "Catalogue snapshot" |
| `experiments/definitions.json` | the simulator | pre-registered definitions (production: the staff API) |
| `experiments/results/…` | `analyse-experiments` | the results the experiments area imports ("Experiment results") |
| `recs-work/datasets/…`, `runs/…`, `evaluations/…`, `scored/latest.json` | this pipeline | working data (never read by the request path) |
| `recs-work/erasure/plan.json` | `erase` | keys being erased or watched (see "Erasure") |
| `recs-work/locks/lake.json` | `compact`, `erase`, `export-events` | the lake lease |
| `privacy/export-events/{requestId}/events.ndjson.gz`, `manifest.json` | `export-events` | one member's events for one data export ("Exports of members' events"); the product deletes them once folded in |
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

## The events, as the product writes them

The event schema is the product's: `packages/contracts/src/events.ts` is the single source and
`schemas/event.schema.json` is generated from it (`pnpm --filter @webflix/contracts generate`; a
contracts test fails while it is stale). Never edit it here: `src/webflix_recs/schemas.py`, the
only module that reads it, takes the event types, sources, row kinds and version from it, so a
new enum value (`row.view.rowKind` `collection`, `playback.abandon.reason` `expired`) reaches
the pipeline without a code change. Every event read is validated; invalid ones are counted and
quarantined by compaction. The contracts adopted this pipeline's original fifteen decisions
with three corrections (title and episode ids follow the contract's `Id` pattern; client events
always carry a device, a session sequence and a client platform while server events carry the
`server` platform and no sequence; sign-in and sign-up events carry no profile).

What the real writer (`createBlobLakeEventSink`, packages/core/src/ports/event-sink.ts, fed by
packages/core/src/areas/events/collector.ts) produces, and what the pipeline relies on:

* **Objects**: `events/dt=YYYY-MM-DD/hh=HH/{uuidv7}.ndjson.gz`, gzip, one JSON event per line,
  newline-terminated, partitioned by the hour of `receivedAt`; one object per client batch (at
  most 50 events and 64 KiB, one device, one receipt time), per outbox drain (up to 100 events
  of many members) or per other server event. Never overwritten by the writer. On Cloudflare
  every accepted client batch is its own object today, so expect many small objects per hour
  until the writer batches them (compaction folds them into one file per hour; the job reads
  them in parallel).
* **At least once**: a retried client batch is stored again with a later `receivedAt`; a
  redelivered queue job or a second outbox drain stores the same events with the same receipt;
  a playback milestone emitted twice has the same `eventId` (derived from the session). Every
  reader deduplicates by `eventId`, keeping the earliest receipt.
* **Late events**: `receivedAt` is stamped when the event is accepted (the request, the server
  event's emission, the playback write), not when it reaches the lake. Playback events and a few
  other kinds are written to a database outbox first and reach the lake on a scheduler tick
  (every 5 minutes by default, configurable), possibly into an hour already compacted;
  dead-letter replays can be days late. Compaction waits 15 minutes after an hour ends, readers
  take raw objects a manifest does not cover, and the next compaction folds them in. **Keep
  `--grace-minutes` (compaction, train-and-score, export-events) above the outbox tick**: the
  grace is what makes "every event received before the cutoff is in the lake" true.
* **Restricted profiles produce nothing**: a kids profile or a lowered maturity ceiling emits no
  event at all, client or server, so `subject.restricted` is always `false` in real data. The
  pipeline's own restricted rules stay as a second line (older lakes, fixtures).
* **Consent**: an account with no consented purpose stores nothing but its `consent.change`
  events; otherwise every event carries the account's consent at receipt. Consumers use the
  account's latest stamp (a `consent.change` carries the new state).
* **Subjects**: pseudonymous keys, `base64url(HMAC-SHA256(key, "account:" + id | "profile:" +
  id))[:22]`, the function `ids.pseudonym` computes (pinned to the product's by a test vector);
  server events have no `country`; sign-in and sign-up events have no profile; signed-out client
  events have neither account nor profile.
* **Envelopes**: playback events carry `context.surface = "player"` and no experiments; an
  `experiment.exposure` carries the unit's assignments and the page's policy, no device for a
  profile unit; an `abandon` with reason `expired` happened at the last report (`occurredAt`) and
  was received minutes later, when the expiry sweep ended the session.

`tests/test_ingested_lake.py` reads objects the real writer produced through the dev API, and
the product's own test (`apps/api/test/events-lake.test.ts`) runs this reader on a lake the
running HTTP app wrote.

**The simulator collects like the product.** It generates restricted and non-consenting members'
behaviour, then drops what the collector would drop (restricted subjects, accounts without any
consented purpose, an exposure repeated within 30 days of the same unit and variant) after every
random draw for the event, so every stored event is byte-identical to the run without the rules
(tested); server events have no country, playback envelopes carry the player surface only,
budget-limited stops end with `expired`, server duplicates keep their receipt.
`--object-layout writer` groups the same events into objects the way the writer does (many small
objects: for exercising compaction and erasure at realistic object counts); the default
`hourly` layout writes one object per hour and shard.

## Reading the lake (`lake.py`)

For each hour partition up to the cutoff: the current compacted Parquet file and every raw
object its manifest does not cover; every line validated; then deduplicated by `eventId`
(earliest receipt) by the consumer (dataset, analysis). An object that disappears while its hour
is read (a concurrent rewrite) makes the reader list the hour again (3 attempts). A manifest of
an unknown version is an error, never silently ignored.

## Compacted hours: the contract for readers

What `compact` leaves in an hour, precisely enough for a reader in another language: the
product's inline export path (small deployments such as dev mode) reads an account's events from
compacted hours; in a deployed mode the events of an export come from `export-events` (section
"Exports of members' events"), which follows the same rules. Fixtures produced by this compactor, with the expected answers, are in
`tests/fixtures/compacted/` (see "Fixtures for the data export").

**Objects of an hour partition** `events/dt=YYYY-MM-DD/hh=HH/` (UTC receipt hour):

* `*.ndjson.gz`: the writer's raw objects;
* `_compaction.json`: present once the hour was compacted;
* `part-{16 hex}.parquet`: compacted files; only the one the manifest names is current, any other
  is a leftover of an interrupted rewrite and is ignored;
* anything else: ignored.

**Reading one account's events in one hour** (a snapshot; no lock):

1. List the partition (every page).
2. If `_compaction.json` is listed, read it. It must have `format` = `webflix.events-compaction`.
   `formatVersion` 2: the hour is compacted (below). `formatVersion` 1 (written by this pipeline
   before November 2026; zstd, which a Worker cannot decode): ignore the manifest and read every
   raw object; the next `compact` rewrites every version 1 hour as version 2. Any other format
   or version: fail the read (do not guess: the hour may have no raw objects left).
3. Compacted hour: if the key in `parquet` is in the listing, read that file (below) and every
   raw object whose key is not in `sources[].key`. If it is not in the listing, a rewrite is
   under way: start again at 1.
4. Not compacted: read every raw object.
5. If any object you decided to read is gone when you read it (404), start again at 1. Rewrites
   write the new Parquet file, then the manifest, and only then delete the previous file and
   (with `--delete-sources`, or an erasure emptying an object) raw objects; so a second listing
   sees a consistent hour. Give up after 3 attempts (an error, not a gap).
6. From raw objects keep the lines whose `subject.account` is the key. Across everything read for
   the request, keep each `eventId` once (a straggler can repeat an event the Parquet file holds;
   a retried batch can repeat an event in a later hour); the copies are the same event, the
   earliest `receivedAt` is the one compaction keeps.

**The Parquet file** (version 2):

* Columns, in this order, every one `BYTE_ARRAY` with the `STRING` (UTF-8) logical type:
  `account` (nullable: signed-out events), `profile` (nullable), `event_id`, `type`,
  `received_at`, `occurred_at` (exactly as stored, RFC 3339 with milliseconds), `title_id`
  (nullable), `raw`. `raw` is the event exactly as the writer stored it: one JSON line, which
  `JSON.parse` turns back into the `LakeEvent` (for an hour first compacted by version 1, the
  same JSON value re-serialised).
* One row per `eventId`, the earliest receipt; only events that validated (others are in
  `events-quarantine/`).
* Sorted by `account` (ascending byte order; the keys are 22 ASCII characters, so this is also
  JavaScript's string order), nulls last, then `received_at`, then `event_id`.
* Row groups of at most `rowGroupRows` rows (the manifest says how many; 1,000 today, 16 in the
  fixture). Every column chunk has statistics; on `account`, `min_value` and `max_value` are
  exact and `null_count` is set. A group whose `account` has no `min_value`/`max_value` holds
  only signed-out events.
* Compression: `SNAPPY` on every column chunk (hyparquet decodes it natively; no WASM codec).
  Encodings: `PLAIN`, `RLE`, `RLE_DICTIONARY` (dictionary pages may be present).
* Key-value metadata: `webflix.format` = `webflix.events-compacted/2`, `webflix.hour`.

To read one account, read the footer (with hyparquet: `parquetMetadata`, over an `AsyncBuffer`
backed by ranged reads, `BlobStore.get(key, { range: { suffix } })` for the footer and
`{ offset, length }` for column chunks), select the row groups whose `account` `min_value ≤ key
≤ max_value`, read only the `account` and `raw` columns of those groups
(`parquetReadObjects({ file, metadata, columns: ["account", "raw"], rowStart, rowEnd })` per
group), and keep the rows whose `account` equals the key. A reader of one account reads one or
two groups per hour.

**The manifest** `_compaction.json` (version 2, `schemas/events-compaction.schema.json`):

| Field | Meaning |
| --- | --- |
| `format`, `formatVersion` | `"webflix.events-compaction"`, `2` |
| `hour` | start of the receipt hour (UTC) |
| `parquet` | key of the current Parquet file, `events/dt=…/hh=…/part-{16 hex}.parquet` (the first 16 hex characters of its SHA-256: the name changes exactly when the content does) |
| `parquetBytes`, `parquetSha256` | its size and digest |
| `rows`, `rowGroups`, `rowGroupRows` | events in it; row groups; the most rows a group has |
| `sortedBy` | `["account", "received_at", "event_id"]` |
| `compression` | `"SNAPPY"` |
| `columns` | `[{name, description}]`, the columns above |
| `sources` | `[{key, size, etag}]`: every raw object whose events the Parquet file holds. Readers use `key` only: an erasure may since have rewritten a covered object in place, or deleted it |
| `duplicatesDropped`, `invalid`, `erased` | counts (`erased`: rows removed by erasures; erased keys are never written here) |
| `erasedAt` | the last erasure that rewrote this hour, when one did |
| `compactedAt` | when the hour was (last) compacted |

An hour is compacted only once closed (its end plus the 15-minute grace); open hours have no
manifest. A compacted hour can still gain raw objects (late outbox drains, replays): they are
uncovered until the next compaction.

### Fixtures for the data export

`tests/fixtures/compacted/` (`make recs-fixtures` rewrites them; `tests/compacted_fixture.py`
documents how): `store/` mirrors blob keys as paths. Hour `events/dt=2026-11-22/hh=07/` holds
the 13 objects the real writer produced through the dev API (`tests/fixtures/ingested`),
compacted with row groups of 16 rows (sources kept: they must not be read), and a straggler
written after compaction (a retried batch repeating a compacted event, and a playback event of
another account that arrived late). Hour `hh=08` is not compacted. `expected.json` gives, per
account, the event ids an export must return, and per hour the raw objects to read and to skip
and the row groups a reader of each account cannot skip. `scripts/check-compacted-fixture.ts`
reads them with hyparquet exactly as above and checks every answer (run by `make recs-test`).

## Erasure

`webflix-recs erase` removes erased members from everything this pipeline stores
(`src/webflix_recs/erasure.py`):

1. **Keys**: `GET /api/admin/v1/system/privacy/erasures?limit=500` (`--keys api`, the default
   when `WEBFLIX_ADMIN_API_URL` is set), or a file (that answer, a JSON list, one key per line).
   A key matches an event when it is its `subject.account` or `subject.profile`. Keys still
   pending from an earlier failed run, and confirmed keys still in their watch period, are added.
   No database access: the operator routes are the interface.
2. **Discovery**: the account's profile keys, from the lake (events carry both) and from the
   datasets' `profiles` tables; written to `recs-work/erasure/plan.json` with the keys **before
   anything is rewritten**.
3. **Rewrite**, under the lake lease: raw objects (in place, same key; deleted when nothing is
   left), compacted hours (a new Parquet file without the rows, the manifest flipped to it, the
   old file deleted; orphan Parquet files deleted), `events-quarantine/` (a line that is not even
   JSON goes if it contains a key), datasets (rows of the account and its profiles; row counts
   updated), artefact versions (profile rows; file entries and counts recomputed;
   `recs/current.json` re-pointed at the new manifest digest when it names that version),
   exports of the member's events written by `export-events` (deleted whole). Nothing
   else holds a subject key: runs keep item factors only, evaluations and experiment reports
   are aggregates.
4. **Verify**: a full pass over the same places finds no occurrence of any key, or the job fails
   with exit 5 and confirms nothing.
5. **Confirm**: `POST /api/admin/v1/system/privacy/erasures/confirm` (at most 200 keys per call,
   with a reason) with the given keys and the profile keys discovered for them (the product
   records a key for the account and for each profile but lists only the account's; confirming
   the profile keys keeps those records from staying pending), either directly
   (`--confirm api`, the default with `--keys api`) or as request bodies written to a file or
   the summary for an operator to send (`--confirm FILE|-`).
   Confirmed keys stay in the plan for 30 days (`--watch-days`), during which every run also
   removes their late arrivals (a batch queued before the deletion and replayed from a dead
   letter), then they are forgotten.

**A failure half-way** (a crash, a store error, a kill): nothing has been confirmed, so the
product still lists the keys; the plan already holds them and their profile keys; every rewrite
only removes what still matches, so the next run finds less to do and finishes. An artefact
version being rewritten is marked in the plan first, and its manifest is recomputed from the
files on the rerun even if the crash fell between a shard write and the manifest write. Tested
by failing at the first write of each kind and rerunning. `compact --erase FILE` (the wording of
the operator route's description) runs the same operation after a compaction, under the same
lease, and returns the confirmation bodies.

Cost: three passes over the lake (discover, rewrite, verify), reading only the `account` and
`profile` columns of Parquet files and the subjects of raw objects except where a key matches;
at the full simulated size about as long as a dataset build.

## Exports of members' events

"Download your data" includes every lake event of the member's account within the raw retention
window (13 months). Read inside one invocation of the product, that is roughly 9,500 hour
partitions before a single row: beyond a Cloudflare Worker's subrequest (10,000) and CPU limits
within hours of real traffic, whatever the reader. So in a deployed mode the events part of an
export is a batch job of this pipeline, on the pattern of `erase`: the product records the
request and folds in the result; the job does the reading. (The product keeps its inline reader
for small deployments such as dev mode: that is what "Compacted hours" and its fixtures are
for.) `webflix-recs export-events` (`src/webflix_recs/exports.py`):

1. **Requests**, from a file (the product's operator route does not exist yet; when it does,
   reading it is wiring, as for erasures): `schemas/export-events-requests.schema.json`,
   `{"requests": [{"requestId", "accountKey", "from", "to"}]}`: the export request's id (a
   private document name, `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`), the account's pseudonymous key,
   and the receipt window `[from, to)` (RFC 3339 instants).
2. **Deferred**: a request whose `to` is less than the grace period ago (15 minutes; keep it
   above the outbox tick) is reported `deferred`, with `notBefore`.
3. **Erased subjects yield nothing**: a key in the erasure plan (pending, or confirmed and still
   watched) or in `--erasures` (`api`: `GET /api/admin/v1/system/privacy/erasures`, or a file) is
   reported `erased`, with no events, and any earlier output of that request is deleted.
4. **One pass for every due request**: each hour partition any window touches is read once, by
   the readers' rule (the current Parquet file and the raw objects it does not cover; nothing
   twice; a consistent state, re-listed if a rewrite deletes something meanwhile). Parquet
   files are scanned with a filter on `account`, so row groups whose statistics exclude every
   requested key are not decoded; raw objects are parsed line by line only where a requested key
   occurs. Hours run in parallel (`--workers`).
5. **Output**, per complete request, under the product's private prefix (readable with
   `EventSink.getDocument`, never served):
   * `privacy/export-events/{requestId}/events.ndjson.gz`: gzip (no timestamp: the same lake
     gives the same bytes), one event per line **exactly as the lake stored it** (the `raw`
     form), once per `eventId` (the earliest receipt), only events received in `[from, to)`,
     ordered by `receivedAt` then `eventId`, only events that validate;
   * then `privacy/export-events/{requestId}/manifest.json`
     (`schemas/export-events-manifest.schema.json`): `{format: "webflix.export-events",
     formatVersion: 1, requestId, accountKey, from, to, events, file, bytes, sha256,
     generatedAt}`, `sha256` of the gzip bytes. Written last: its presence means the events file
     is complete.
6. **Results** (`--results FILE`, or in the summary;
   `schemas/export-events-results.schema.json`): `{format: "webflix.export-events-results",
   formatVersion: 1, generatedAt, results: [{requestId, status, from, to, events?, file?,
   manifest?, bytes?, sha256?, generatedAt?, reused?, notBefore?, error?}]}`, `status` one of
   `complete`, `erased`, `deferred`, `failed`, in the order of the requests.

**Rerun safety**: a request whose manifest exists for the same account and window, with an
events file of the recorded size and SHA-256, is reported `complete` again (`reused: true`)
without reading the lake; a run that failed between the events file and the manifest (or a
manifest whose file does not match) extracts again; one request's failure is reported `failed`
and the others go on (exit 8). Outputs older than `--keep-days` (7) are pruned, a backstop: the
product deletes them once folded in. An erasure deletes any output of the erased member.

**What the product builds** (events and admin areas), so that the job can run against routes:

* `GET /api/admin/v1/system/privacy/exports?limit=N` (role `admin`): `{requests: [{requestId,
  accountKey, from, to}]}`, the export requests whose events are not extracted yet: `from` = the
  request time minus the raw retention, `to` = the request time (the outbox drained by then or
  within the job's grace). Listed until a result is recorded.
* `POST /api/admin/v1/system/privacy/exports/results` (role `admin`, `X-Webflix-Client: web`, a
  `reason` for the audit log): the results document above. For `complete`: read `file` with
  `getDocument`, check `bytes` and `sha256` against the result, parse each line with
  `LakeEvent`, put them in the export document's `events`, delete the two pipeline documents,
  finish the export (document, email). `erased`: the account is being deleted: no events (the
  erasure handles the request). `deferred` and `failed`: keep listing it.
* Until those exist: an operator passes the product's pending requests as a file and the results
  file back.

**Access the job needs**: read `events/`; read `recs-work/erasure/plan.json`; create and delete
`recs-work/locks/lake.json`; write and delete `privacy/export-events/`; with `--erasures api`, the
staff API with the `admin` role.

## Dataset rules (`build-dataset`)

Knowledge cutoff by `receivedAt`; validation; deduplication by `eventId` (earliest receipt
kept); per-device clock correction (median offset of a device's events, gaps of 12 h or more
ignored as offline delay), clamped to receipt; client events older than 7 days at receipt
dropped; every `restricted` event dropped, and every profile whose latest state is restricted or
whose account's latest consent lacks personalisation dropped with its whole history (on real
data the collector already stored nothing of restricted profiles, so those counts read 0); signed-out
and gate events dropped; unknown title ids dropped. Each rule is counted in the dataset manifest.
Tables keep `received_at` so any earlier cutoff can be rebuilt from one dataset. Impressions are
labelled from what followed *that card*: `opened` (a `title.open` with the same `rowRank` and
`rank` within 30 minutes), `started`/`played` (opened, then the title started / watched for at
least 30 s within 30 minutes) and `censored` (right of the first played card in the same
showing of the row: the member had left the row). Impressions of curated `collection` rows are
browsing rows like any other (the ranker learns from them; Continue Watching, My List, Watch It
Again and the billboard are not).

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

What the product's importer does (packages/core/src/areas/personalisation/importer.ts; CLI
`node apps/api/src/recs.ts import|rollback|status`), for reference:

* It publishes a run all at once: the new run's rows are written beside the served run's and
  become visible when the run is activated (one write), and rolling back re-activates the
  previous run, whose rows are kept.
* **Neighbours, SQL**: `recommendation_neighbours(model_version, title_id, rank, neighbour_id,
  score, support)`, primary key `(model_version, title_id, rank)`: 6 bound parameters per row,
  so 16 rows per `INSERT` within D1's 100-parameter limit.
* **Per-profile lists, SQL**: `recommendation_profile_lists(model_version, profile_key, payload,
  expires_at)`, primary key `(model_version, profile_key)`: 4 parameters per row, 25 rows per
  `INSERT`. (The single-row-per-profile `recommendation_profiles(profile_key PRIMARY KEY, …)`
  this file once suggested is superseded: it cannot hold two runs side by side.)
* **Per-profile lists, Cloudflare KV**: key `recs:v1:{run}:{profile_key}`, value `payload`.
* One profiles shard at a time, one row group at a time: bounded memory, resumable per shard.
* Lists already past `expiresAt` when imported are counted and not written.

An erasure (section "Erasure") may rewrite a version's profiles shards and manifest: the file
entries and the counts are recomputed, `recs/current.json` gets the new manifest digest when it
names that run, and the version validates and imports as before. An import that starts during
that rewrite sees a digest mismatch, refuses, and succeeds on its next schedule.

## Experiment results: the contract for the importer

`analyse-experiments` analyses every experiment the product registered and writes, per run:

```
experiments/results/r={run}/{key}.json    one webflix.experiment-result per experiment
experiments/results/r={run}/report.json   the whole webflix.experiment-report (audit)
experiments/results/current.json          the pointer, written last
```

`run` is the analysis instant, `YYYYMMDD-HHMMSS-mmm` (UTC). The pointer
(`schemas/experiment-results-pointer.schema.json`):
`{format: "webflix.experiment-results-pointer", formatVersion: 1, run, computedAt, asOf, report,
results: [{key, path, bytes, sha256, decision}], skipped: [{key, reason}], previous}`. A result
(`schemas/experiment-result.schema.json`):
`{format: "webflix.experiment-result", formatVersion: 1, key, computedAt, asOf, report}`, where
`report` is that experiment's element of the run's report (`schemas/experiment-report.schema.json`,
`$defs.experiment`).

**Importing them** (the experiments area's job, wiring only): read the pointer; for each entry
read `path`, check `bytes` and `sha256`; call
`services.experiments.saveExperimentResults(key, document.report, Date.parse(document.computedAt))`;
skip a key the product does not know (`not_found`). `saveExperimentResults` keeps one row per
(key, computedAt), so importing the same pointer twice changes nothing, and
`GET /api/admin/v1/experiments/:key/results` answers `{key, computedAt, report}` from the newest.
A run directory the pointer does not name is incomplete or old: never read it. Runs older than
30 days are pruned (the current and previous are kept). Readers refuse an unknown major version
and ignore fields they do not know.

**What the analysis reads**:

* **Definitions**: `--definitions api` reads `GET /api/admin/v1/experiments` (role
  `experiments`); a file holding that answer or the pipeline's own document also works; without
  either, `experiments/definitions.json` (the simulator writes it). Product definitions map onto
  `schemas/experiment-definitions.schema.json` (`src/webflix_recs/experiments/definitions.py`):
  drafts and archived experiments are skipped and listed under `skipped`; the window starts at
  `max(startsAt, registeredAt)` (the product assigns nobody before an experiment is started);
  `unit`, `layer`, `control`, metrics, `alpha`, `power`, `minimumDetectableEffect`,
  `srmThreshold` and `endsAt` are taken as they are.
* **Units as the product assigns them**: the profile (its pseudonymous key, `subject.profile`)
  for `unit: profile`, the device (`deviceId`) for `unit: device`, matched with the exposure's
  `payload.unitType`. Playback events carry no device, so a device unit's outcomes are those of
  the profiles signed in on that device (client events carry both), its retention that of the
  account last seen there, its consent its exposure's own stamp.
* **Exposures as the product logs them**: `experiment.exposure` server events, for both arms,
  only when a treatment could apply (the recommendation experiment: a fresh model exists), once
  per unit and variant per 30 days. A unit enters at its first exposure in the window.
* **Layers**: the per-experiment `diagnostics` count units also exposed to another experiment of
  the same layer while both ran (`layerOverlapUnits`; the product's allocations make it 0, so
  more is an assignment bug), exposure events read, and for device units the device-profile
  links found.
* Exclusions (restricted, no analytics consent, unknown variant, more than one variant), the
  sample-ratio check, per-variant means and intervals, differences and relative lifts,
  always-valid p-values and confidence sequences (mSPRT), the fixed-horizon test (labelled
  valid only at `endsAt`), the daily looks and the decision: docs/RECOMMENDATIONS-ML.md §7.

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
`scripts/`, and pytest (about a minute and a half on a quiet machine): storage layout and the S3
contract (moto), schemas, the simulator (determinism, collection like the product, the writer
layout), the lake (compaction format 2, stragglers and late outbox drains, the grace period,
deletion only after coverage, version 1 hours upgraded, a reader racing a rewrite), the
compacted-hour fixtures (current, read by this pipeline and by hyparquet), erasure (everywhere,
a failure at each kind of write then a rerun, verification, the watch period, the lease, the
staff API through a local stand-in, an S3-compatible store), dataset rules (duplicates, late
events, clock skew, consent, restricted, click attribution and cascade censoring), models on
planted data (ALS, co-watch, propensity recovery, EM vs naive ranker, re-ranking), metrics,
experiments (A/A over 300 seeds, planted effect against computed power, SRM, the product's
definitions, layers, device units, the results for the importer), exports of members' events
(the fixtures' answers, windows, deferral, erased subjects, a failure half-way then a rerun,
pruning, erasure removing outputs), and the end-to-end pipeline
on the real catalogue (the planted leak, restricted profiles absent from lake to artefacts, the
real rule engine, the gate, atomic publishing, and the scheduled jobs: train-and-score split
around the Node step, publish behind the gate, an erasure of a member who is in the dataset and
the published version). Test servers (moto, the staff API stand-in) use ports 5790-5809. Biome
lints the TypeScript and JSON here as part of the root `pnpm lint`.
