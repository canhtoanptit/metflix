# Webflix — Recommendations

How browse pages are composed and personalised. Code: `packages/core/src/recommendations/`
(`engine.ts`, `features.ts`) and `packages/core/src/catalog/` (snapshot and caches). Tests:
`packages/core/test/services/browse.test.ts`.

## Goals and constraints

- **A page that feels alive on first load**: a freshly seeded demo profile gets a billboard and a
  dozen-plus varied rows, a populated Top 10 and a credible match score on every card.
- **Explainable and deterministic.** No model training, no randomness: the same inputs produce
  the same page (ties fall back to the title id; "rotation" is a hash of profile and day).
  Unit tests assert on concrete rows.
- **Maturity filtering everywhere, server-side.** Every candidate set starts from the titles at
  or below the active profile's ceiling: rows, billboard, Top 10, genre pages, More Like This,
  search (filtered inside the index), My List, history, notifications, playback.
- **Cheap on the hot path, including D1.** Browse costs two round trips when caches are warm
  (session lookup + one batch for the profile's library), whatever the number of rows. Everything
  else is computed in memory from cached, non-personal data.

## Inputs

| Input | Source | Cached? |
| --- | --- | --- |
| Catalog snapshot: titles, genres, credits, seasons, episode summaries, packaged assets' best rendition | `CatalogRepository.loadSnapshot()` (one batch of 8 SELECTs) | yes: process memory 30 s, then `KeyValueCache` (Valkey / Workers KV) 5 min |
| Popularity: views per title and day | `title_stats` (seed baseline + real playback rollups) | yes: memory 60 s, then KV 5 min, keyed by UTC day |
| Profile signals: My List, ratings, progress | `LibraryRepository.loadSignals()` (one batch of 3 SELECTs) | **never** (read-after-write: adding to My List must show on the next page) |
| Clock | `Clock` port | — |

Caching is limited to data that tolerates minutes of staleness. Personal state is never cached,
so the page reflects the last click.

## Content features

Each title is a sparse, L2-normalised feature vector (`features.ts`):

| Feature | Weight |
| --- | --- |
| genre (`g:`), by relevance order | 1.0, 0.8, 0.6, then 0.5 |
| mood tag (`m:`) | 0.5 |
| director / creator (`p:`) | 0.6 |
| lead cast (first 3) / other cast / writer | 0.4 / 0.2 / 0.3 |
| type (`t:movie`, `t:series`) | 0.3 |
| era (`e:2010` decade) | 0.15 |
| Webflix Original (`o:`) | 0.1 |

Genre dominates "alikeness"; mood and people refine it (a cerebral sci-fi thriller by the same
director beats a slapstick sci-fi comedy). Feature vectors and item-to-item neighbours are
memoised on the snapshot; neighbours are found through an inverted index over features, so cost
grows with feature overlap, not catalog size squared.

**Item similarity** = cosine of the two vectors (0..1). It drives **More Like This** and
**Because You Watched**.

## Taste profile

The profile's taste vector is the signal-weighted sum of the features of titles it engaged with:

| Signal | Weight |
| --- | --- |
| Rated love / like | +3.0 / +1.5 |
| Rated dislike | −3.0 (overrides every other signal for that title) |
| In My List | +1.2 × decay (half-life 60 days, floor 0.5) |
| Watched | +2.0 × engagement × decay (half-life 30 days, floor 0.25) |

Engagement: a finished movie is 1.0; a partly watched movie is `1.2 × watched fraction`, clamped
to 0.15–0.9; a series is `0.3 + 0.12 × episodes started + 0.08 × episodes finished`, clamped to
0.3–1.0. Only titles visible under the current ceiling contribute (lowering a ceiling also
removes the influence of what is no longer visible).

**Affinity** of a title = cosine(taste, title), −1..1. A profile whose total absolute signal
weight is below 0.5 is **cold**: no taste, no match score, popularity-led ranking.

## Scores

```
score(t) = cold  ? 0.50·popularity + 0.35·trend + 0.15·freshness
                 : 0.55·affinity + 0.20·popularity + 0.15·trend + 0.10·freshness
```

- `popularity` = seed popularity / 100; `trend` = recency-weighted views of the last 7 days
  (×0.8 per day of age), normalised to the most trending title; `freshness` = e^(−days since
  added / 45).
- **Match score** (0–100, shown on cards): `52 + 46 × (0.8 × relative affinity + 0.2 × popularity)`,
  where relative affinity is the title's affinity divided by the profile's 95th-percentile
  affinity (so each profile's best matches read ~95–98% whatever the absolute level of its
  taste). Range 52–98; a disliked title is capped at 55; cold profiles get `null` ("unknown",
  per the contract).

## Row composition

`Personalization.rows(view)` returns ordered row plans; the service renders the first page of
each (20 items; Top 10 has 10) and serves the rest through `GET /browse/rows/:rowId`. Rows arrive
in batches of 6 (`nextCursor` on the page). Row ids are stable and readable
(`home:genre:thriller`, `home:because-you-watched:t-sintel`), so a row can be recomputed from its
id alone.

**Home** (rows without enough items are skipped):

1. Continue Watching — what the profile is in the middle of, most recent activity first (layout `continue`; rules below)
2. Top 10 on Webflix Today — by views today + yesterday (layout `ranked`)
3. Trending Now — `0.75 × trend + 0.25 × affinity`
4. My List
5. Because You Watched *A*
6. New Releases — added in the last 45 days, newest first
7. Genre #1
8. Only on Webflix — Originals by score (layout `tall`)
9. Because You Watched *B*
10. Genre #2, Genre #3
11. Watch It Again — finished titles, most recent first
12. Genre #4, Because You Watched *C*, Genres #5–#8

**Series / Movies**: the same structure restricted to one type (Top 10 Series/Movies Today, up to
10 genre rows). **New & Popular**: New on Webflix, Top 10 Series, Top 10 Movies, Trending, Fresh
from Webflix (originals by arrival); no billboard.

Details:

- **Because You Watched**: sources are watched titles with signal weight ≥ 1 (finished, more
  than half watched, or watched and liked), not disliked, most recent first; up to three rows.
  Items are the source's neighbours ranked by `0.75 × similarity + 0.25 × max(affinity, 0)`,
  excluding finished and disliked titles. A row needs at least 4 items.
- **Genre rows**: genres are ordered by the profile's taste for the genre (its `g:` component)
  plus a small prior (popularity-weighted size among visible titles), so a thriller fan sees
  Thrillers first while other genres still appear (exploration). A genre needs at least 6
  visible titles of the view's type. Items are ordered by score.
- **Variety**: a title shown in the first 6 positions of an earlier row moves to the back of
  later *browsing* rows (Trending, genres, Originals). It is never removed, so rows stay full.
  Rows whose order is the point keep it (Continue Watching, My List, Top 10, Watch It Again,
  Because You Watched, New Releases).
- **Dislikes** never appear in suggested rows: Continue Watching, Trending, New Releases, the
  genre rows, Originals, Because You Watched (neither as a source nor as an item) and Watch It
  Again. Two rows keep them, by design: **Top 10** is a chart, the same for every profile (a
  rank that disappeared for one member would make "#3 on Webflix Today" wrong), and **My List**
  holds the member's own picks until they remove them. Disliked titles stay reachable through
  search, genre pages and detail, with a match score capped at 55. **Finished titles** sink in
  score-ordered rows and surface in Watch It Again.
- **Top 10** is not personalised (it is a popularity chart), only maturity- and type-filtered.
  If fewer than 10 visible titles have views, it is padded by seed popularity so it is never
  empty.

### Badges

Each card carries at most one status badge, chosen by the server for the surface the card is
on (`Personalization.cardSurface`); clients draw what they are given. A badge is the exception:
on the seeded demo profile's first home page 11 of 88 cards carry one (it was 41, 47 %), on a
new profile's 9 of 109 (it was 41, 38 %).

- **What each badge means.** `new` ("Recently added"): the title arrived in the last 14 days and
  this profile has played none of it. `new-episodes`: a series this profile has watched, added in
  the last 14 days with more than one season (the catalog dates seasons, not episodes, so its
  latest season is what is new), with an episode of that season beyond the furthest the profile
  has watched. `top-10`: the title is in the Top 10 list of the page's view. `leaving-soon` is
  reserved (the catalog has no availability windows).
- **Priority**: `new-episodes`, then `top-10`, then `new`. A badge about the member's next action
  beats a popularity label; popularity beats "recently added", the weakest signal.
- **Per surface.** The Top 10 row: none, the numeral is the badge. Continue Watching: only "new
  episodes". New Releases: no "new" (the row says it). Every list (a row, a genre page, search
  results, My List, More Like This): at most `BADGES_PER_LIST` = 2 badges, the first earned in
  list order and decided over the whole list (later pages never add more), of which at most
  `TOP_10_BADGES_PER_LIST` = 2 Top 10. Billboard and title detail: the title's badge.
- **Top 10 means the list a member can open from that page**: the "Top 10 ... Today" row of the
  view the card is shown in (the overall list on Home, the series or movies list on those
  views, the title's own type on New & Popular, the overall list on genre pages, search, My
  List, More Like This and title detail). It always agrees with a visible row.
- **The rank is always stated where there is room for it**: every card carries `top10Rank` when
  the title is in the surface's Top 10 list, badge or not, so the hover preview and the detail
  say "#3 on Webflix Today" (or "#2 in Series Today") for every genuinely ranked title.

### Billboard

A strong personal match the profile has **not started** (what it is watching already leads
Continue Watching): the 12 best-scored visible, playable, not-disliked, unstarted titles of the
view's type are re-ranked by
`0.60 × score rank + 0.20 × freshness + 0.10 × original + 0.07 × has preview + 0.03 × has logo`,
and one of the top 3 is picked by `hash(profile, view, UTC day)`. It is stable within a day and
rotates across days. On the seeded demo profiles this yields billboards with 85–93% matches.

### Continue Watching and play targets

One computation per title (`Personalization` builds it from the profile's progress rows) decides
Continue Watching, every Play button (`playTarget`: title detail, billboard, rows) and where
`POST /playback/sessions` starts, so they cannot disagree.

Per item (an episode, or the movie itself):

- **Sampled**: less than `MIN_RESUME_SEC` (30 s) watched and not finished. A few seconds of
  something is browsing, not watching (autoplay started the next episode and the member left;
  a title opened by mistake). A sample is never a resume point: Play starts it from 0.
- **In progress**: at least 30 s watched and below `COMPLETION_RATIO` (95%) of its duration.
  Play resumes it where it was left, whatever the item's length (there is no fixed tail: a
  three-minute fast-profile clip resumes at 2:40 like a film resumes at 1:40:00).
- **Finished**: at least 95% watched, or reported `ended`.

Per title, the state is **anchored on the most recent item that was watched far enough to
count** (in progress or finished); samples never move the anchor:

| Anchor | Continue Watching | Play |
| --- | --- | --- |
| none (only samples) | not listed: a title sampled for a few seconds is not something the member is watching (as on the reference product) | movie from 0; series from its first playable episode at 0 |
| movie in progress | listed at its position | resume there |
| movie finished | not listed; in Watch It Again | from 0 |
| episode in progress | listed at that episode and position | resume it |
| episode finished, a next episode exists and is playable | listed at the next episode, at its own position if that one is in progress, else at 0 (a sample of it starts over) | that episode, there |
| episode finished, it was the finale | not listed; in Watch It Again | first episode at 0 |
| episode finished, the next one is not playable | not listed (nothing to play) | first playable episode at 0 |

Consequences, each covered by `packages/core/test/services/continue-watching.test.ts`:

- Finishing episode 1 and leaving episode 2 after 2 s keeps the series in the row at episode 2,
  from the start (the reported defect: the 2 s sample used to drop the series).
- A brand-new series sampled for a few seconds stays out; 30 s in, it enters.
- Rewatching an earlier episode: a sample of it changes nothing; watching it for real makes it
  the resume point; finishing it moves on to the episode after it (resumed where it was left).
- Removing an episode from viewing activity deletes its progress, so the state is recomputed
  from what remains (episode 2 removed after episode 1 finished: episode 2 from the start;
  both removed: the series leaves the row).
- "Remove from row" hides the title (every progress row of it) until it is **watched again for
  real**: a sample does not bring it back (the anchor is still the hidden item), 30 s of any
  episode does. Hidden titles keep their resume point for Play; only the row omits them.
- The row is ordered by the latest activity on the title, samples included (the member was just
  there). Disliked titles and titles above the profile's ceiling are not listed.
- The billboard picks titles the profile has not **started** (no anchor), so a sampled title can
  still be featured.

## Learned candidates (milestone 2)

The Python pipeline (docs/RECOMMENDATIONS-ML.md, services/recs) publishes per-profile lists
(`personal`, `top-picks`, `billboard`, `because-you-watched`) and item neighbours. The engine
stays the authority: **the model proposes, the rules dispose**. Code:
`packages/core/src/areas/personalisation/` (`importer.ts`, `serving.ts`) and the engine.

**Publishing (the importer).** `recs/current.json` → manifest (its SHA-256 must be the
pointer's; format `webflix.recs`, major 1) → every file checked against the manifest's byte
count and SHA-256 as it is read → the run is begun, filled in bounded batches (neighbours; each
profile shard one Parquet row group at a time) and activated in **one write**. Everything is
keyed by run (`recommendation_neighbours`, `recommendation_profile_lists` on SQL;
`recs:v1:{run}:{profileKey}` in Workers KV), so a half-imported run is never read: readers only
ask for the active run. A failure marks the run `failed` and leaves the served one alone. The
importer keeps two runs; **rollback** is `activate(previous)`, one write again. Lists already
expired at import are skipped. Measured: the medium simulated run (11,198 profiles, 4,760
neighbour rows) imports into SQLite in 0.4 s (64 round trips); the full run (83,322 profiles) in
3.0 s (354 round trips, peak RSS 0.9 GB: a shard is read whole).

On Cloudflare the switch is a D1 statement and the lists are KV keys named by run: the new run's
keys are written beside the old ones, then D1 flips the active run, so publishing needs no
transaction across KV and D1. KV is eventually consistent (a new key can take 60 s or more to
reach other locations, and a miss is cached): a location that sees the activation before the
keys serves the rule engine for those profiles meanwhile (cold start, never an error). Keys expire
a day after their lists. Limits relied on (developers.cloudflare.com, read 2026-11-22): the KV
binding writes one key per `put` and a Worker invocation has **1,000 KV operations**, so an
import inside the Worker (the staff API's `POST /system/recommendations/import`, the job) takes
at most 800 lists (`importCapacity`) and **refuses a larger run before writing anything**: the
staff request answers `422 recommendation_import_too_large` naming `make cf-recs-import`, and a
job records the run as `failed` with the same explanation (`GET /system/recommendations`). A full
run is written from outside Workers through the REST bulk endpoint (**10,000 pairs and 100 MB
per request**, `createKvRestBulkWriter`, `make cf-recs-import`); D1 allows 100 bound parameters per statement and 1,000 queries per
invocation (a batch counts once), which the 16- and 25-row INSERTs and the batching respect.

**Serving.** For each browse page (`RecommendationServing.plan`):

| Situation | What the page is | `policy` |
| --- | --- | --- |
| Kids or lowered-ceiling profile | the rule engine; no learned data read, no experiment | `rules` |
| No active model, or the model is past `expiresAt` | the rule engine | `rules` |
| Store down, or slower than `WEBFLIX_RECS_READ_TIMEOUT_MS` (250 ms) | the rule engine; the store is skipped for 30 s | `rules` |
| The experiment assigns the control variant | the rule engine; no list, no neighbour | `rules` |
| Learned, profile has fresh lists | learned candidates (below) | `learned:{run}` |
| Learned, no lists (not in the run, lists unreadable), and the model's neighbours help (a session boost, or a Because You Watched source the model knows) | the rule engine plus the model's neighbours | `neighbours:{run}` |
| Learned, no lists, and nothing the model knows touches the page (a new profile with no history) | exactly the rule engine | `rules` |

**The label says what ranked the page, never more**: `rules` when nothing from a model shaped it,
`neighbours:{run}` when a fresh model's neighbours helped the rule engine but no personal list
did, `learned:{run}` only when a fresh personal list ranked it. The ranker's position-bias
estimate and the experiment analysis read it from impressions (the pipeline treats it as free
text: only `explore` is interpreted), so a page ranked without a personal list is never counted
as learned. The engine decides the label after composing the page (`Personalization.modelUse`).

With learned candidates: **Top Picks for {name}** (the model's re-ranked list in its order) comes
after Continue Watching; the billboard is the model's first eligible pick (rotating daily among
three); every score-ordered row (genre rows, Originals, genre pages "suggested") puts the titles
the model scored first, by its score, then the rest by the engine's own score; Trending's taste
term is the model's percentile; Because You Watched (sources still chosen by the engine) leads
with the model's row for the source, then the model's neighbours, then content similarity; More
Like This uses the model's neighbours for titles it knows and content similarity for the rest (a
title the model has never seen gets content only). **Session re-ranking**: titles watched since the
lists were generated (or in the last two days without lists) boost their learned neighbours at
once. Every candidate passes the rules first: ceiling, availability, dislikes (also those made
after the run), what was started or finished since, the view's type, badges and deduplication.

**Exploration.** A deterministic share of sessions (`WEBFLIX_RECS_EXPLORE_SHARE`, 5 % in
production; keyed by session and UTC day) gets the rows in random order (Continue Watching keeps
its place) and the items of every non-canonical row in random order (My List, Top 10, Watch It
Again and curated collections keep theirs), under either policy, and says so in
`policy.explore`. Row pages agree with the page. Without this slice the ranker's position-bias
correction cannot be estimated from real traffic.

**Experiments.** `WEBFLIX_RECS_EXPERIMENT` (default `recs.learned-vs-rules`) decides the policy
of the profiles it assigns: its control variant gets the rule engine, the others learned
candidates; unassigned profiles get `WEBFLIX_RECS_DEFAULT_POLICY`. An `experiment.exposure` is
logged for both arms when the treatment can apply (a fresh model is active), never on
assignment alone, once per unit and variant (process memory, then a shared-cache marker).
Replicas and isolates each cache the definitions (a copy is used at most 30 s after its database
read), so a start, pause or stop is **scheduled** `WEBFLIX_EXPERIMENTS_PROPAGATION_SEC` ahead (60 s
on k8s and Cloudflare, 0 in dev): staff see the new `status` at once, with `statusChangeAt` saying
when it takes effect everywhere (a start also sets `startsAt` to it); until then every instance
assigns as under `previousStatus`, so a unit's assignment never depends on which instance
answered (finding K4).

**Editorial.** Staff decisions (`services.personalisation`, the staff API's handlers): titles
pinned to a view's billboard come first (under the same rules), published curated collections
are rows (`kind: collection`) at their position in their curated order, and a title made
unavailable (or outside its window) leaves every browse surface and search (results and title
suggestions); a direct link to it (title detail, its episodes, More Like This) answers
`not_found`, as if the catalogue did not have it, so nothing contradicts browse. Playback start is
the streaming area's (`services.personalisation.isTitleUnavailable`). They are read in one batch
and cached like the catalogue (30 s in memory, 5 min shared); a staff change invalidates them.

**Account deletion.** Profile keys are the lake's own subject keys (`createSubjectKeys`, the
events area's; the pipeline's `ids.pseudonym`). The events area's erasure job calls
`eraseAccountData` before the account row goes: the lists of the account's profiles are deleted
in every registered run (database rows, or the KV keys on Cloudflare) and dropped from the
caches, at once rather than at their expiry.

**Budget, measured** (database round trips per `GET /browse`; Node on SQLite in
`apps/api/test/personalisation.test.ts`, the Worker on D1 in
`apps/edge/test/personalisation.test.ts`):

| | SQLite warm | SQLite cold | D1 warm | D1 cold |
| --- | --- | --- | --- | --- |
| Milestone 1 (before) | 2 | 4 | 2 | 4 |
| Database store, no model | 2 | 7 | 2 | 7 |
| Learned candidates | 2 | 8 | 2 (+1 KV read) | 7 |
| An experiment running (plan-targeted on SQLite) | 2 | 8 | 2 | 7 |

Cold is every shared cache dropped (catalogue, popularity, model, experiment definitions,
editorial data, lists). The three extra cold reads are the model with its neighbours, the
experiment definitions and the editorial data; on SQL a profile's lists are one more (KV on
Cloudflare); a plan-targeted experiment reads the member's plan once a minute. Warm stays at the
session lookup and the library batch: the model, the definitions and the editorial data are
cached per process and in the shared cache (Valkey, Workers KV), a run's lists per profile (they
never change once it is active, so a profile without lists is cached as such). A fresh process
also pays its one-time schema check on the first request.

## Popularity: where views come from

- **Real playback**: each heartbeat (and the final report a release may carry) credits watched
  time to its playback session: the position advance, but only over an interval that began
  playing (a paused interval earns nothing, so a seek while paused is not watching), never more
  than the wall-clock time since the session's credit clock, which moves forward by what it
  credits and lags the last heartbeat by at most 5 s of carried jitter (DECISIONS.md D16).
  However many heartbeats arrive and whatever positions they claim, a session is never credited
  more than the time it existed; faster playback is credited at wall-clock speed. The
  `stats.rollup-day` job recomputes a day's counters from playback sessions (`INSERT ... SELECT
  ... GROUP BY ... ON CONFLICT DO UPDATE`): a view is one profile credited with at least 60 s of
  a title that day. It is a recomputation, not an increment, so at-least-once job delivery
  cannot double count. Playback end publishes a rollup; the scheduler also rolls up today and
  yesterday every few minutes.
- **Observing it**: outside production, `GET /titles/:id/popularity` returns a title's stored
  daily counters (baseline views, playback views, credited seconds, profiles that played) for
  the last 7 days, uncached; the conformance suite uses it to see one honest minute add exactly
  one view and a burst of heartbeats add none. Browse reads the same counters through the
  popularity cache (60 s in memory, 5 min shared), invalidated when a rollup finishes.
- **Synthetic baseline** (`source = seed`): `views = ((popularity/100)² × 400 + 5) × launch
  spike × deterministic noise`, where the spike is `1 + 2.5 e^(−age/5)` during a title's first
  three weeks. The seeder writes 14 days; the `stats.baseline-day` job adds each new day, so
  Trending and Top 10 stay alive in a long-running dev or demo deployment without re-seeding.
  Real and synthetic rows are separate (`source` column) and summed when read.

## Tuning

All weights are named constants at the top of `engine.ts` and `features.ts`. Change them with a
test in `browse.test.ts` that shows the intended effect on the fixture catalog.

## Known limits (spike scope)

- Content-based only: no collaborative filtering ("people who watched X also watched Y"). The
  playback sessions table has what that would need.
- The snapshot is held whole in memory and in one KV value: 388 KB for the 119-title catalog
  (≈ 3.3 KB per title including credits and episodes); above 900 KB it is not written to the
  shared cache (about 270 titles), and each process/isolate loads it from the database instead.
  A large catalog would shard the snapshot or precompute rows in a job. Computing every title's
  neighbours for that catalog takes ~6 ms.
- Milestone 1 had no A/B testing or exploration; milestone 2 adds both (Learned candidates).
