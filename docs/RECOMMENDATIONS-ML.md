# Webflix — Recommendations: the learned pipeline

How milestone 2 learns recommendations offline and hands them to the milestone 1 engine
(docs/BLUEPRINT-M2.md §6-§9). Code and operating manual: `services/recs/` and its
[README](../services/recs/README.md), which also holds the exact artefact schema for the importer.
The rule engine and its guarantees are unchanged and documented in docs/RECOMMENDATIONS.md: the
engine stays the authority for page assembly and every rule; this pipeline only supplies
candidates, scores and neighbours, precomputed.

**Outcome, measured on the current code (November 2026).** Does the learned model beat the
milestone 1 rule engine? Offline on the simulator, at medium size, yes, in every seed and week
tried; at full size, yes, in all three weeks of the one seed run (+0.101, +0.032, +0.108); at
smoke size, no; and served online in the simulator it raised
plays a little while its lists were fresh and lowered watch time once they aged. The offline
comparison is what members see under each policy: the engine's home page with the run's lists
handed to it as the learned policy's candidates, against the engine's own home page, by the true
utility of the first ten titles in reading order, with a paired 95% bootstrap interval over
profiles (§5). At medium size (8,000 households, 42 days) the learned page won at all three
rolling gate cutoffs (days 35, 28 and 21) for all three simulator seeds tried (7, 8, 9):
differences from +0.024 to +0.100, mean +0.061 with a standard deviation of 0.027 across the
nine, each interval about ±0.006. The seed and the week move the result four to five times more
than an interval admits, so the numbers support "wins in every cell", not a magnitude (§6). At
smoke size (300 households, 21 days) it does not win (−0.022, +0.004, +0.026 for the three seeds,
every interval covering zero) and the gate refuses to publish. The +0.112 [0.109, 0.115] reported
before came from an older recipe on an earlier lake with a different comparison and is
withdrawn. Online in the simulator (§7), served to half of the members, the learned pages added
+3.3% and +4.2% qualified plays in the first week while the run was fresh; over 14 days without
scoring again, +0.7% and +1.2% (within noise) with 3-4% less watch time; the product's analysis
at medium traffic would most likely detect none of it. Part of the offline win is written into
the simulator: §2, "What the simulator builds in". These are simulator results: they validate
the pipeline and the relative ordering of systems under the simulator's assumptions, not
real-world lift (§9).

**Since the product was built around the pipeline (November 2026).** The lake is written by the
product's own writer, and the simulator stores only what that writer stores (restricted profiles
produce nothing, accounts without any consented purpose only their consent changes, exposures
once per unit and variant per 30 days), dropping events after every random draw so that every
stored event is byte-identical to the earlier simulator's. Datasets and scoring leave out every
subject the product lists as pending erasure (erased accounts, restricted or deleted profiles),
retention is enforced on the store from the product's own settings (`retain`), and a run is
published only on its own gate decision across three consecutive weeks (services/recs/README.md,
"Jobs").

## 1. Pipeline

```
 behaviour: the product's lake writer (POST /events, server events, the playback outbox);
            the simulator, collecting like the product, for tests and the documented runs
        │
        ▼
 events/dt=…/hh=…/*.ndjson.gz ──compact──► part-*.parquet (deduplicated, per closed hour)
        │                         ▲
        │                         ├── erase (account deletions: lake, datasets, artefacts)
        │                         └── retain (13 months of activity, 37 of totals, by age)
        │
        ▼ build-dataset (knowledge cutoff, validation, dedup, clock correction, eligibility,
        │                subjects pending erasure left out)
 playback · actions · impressions(+labels) · profiles · accounts      (Parquet)
        │
        ▼ train (temporal stacking: candidates at T-7d → ranker on [T-7d, T) → candidates at T;
        │        a backtest at cutoff c learns from a dataset built as of c)
 co-watch (shrunk) · ALS · content (TF-IDF+SVD) · propensity · EM ranker · re-ranker
        │
        ├─► evaluate, at each rolling cutoff T−7d, T−14d, T−21d: backtests vs random,
        │   popularity, components, the real M1 engine (score order, home page, and home page
        │   with the run as its learned candidates), oracle
        │           → gate decision for the run (learned home − engine home, utility@10,
        │             paired 95% interval above zero at every cutoff)
        ▼
 score → recs/v={run}/{neighbours,profiles}/*.parquet + manifest (+ its decision)
       → publish (checks the run's own decision again) → recs/current.json
        │
        ▼ (TypeScript) importer → RecommendationStore → engine.ts

 analyse-experiments → experiments/results/current.json → (TypeScript) saveExperimentResults
```

Every stage records what it read and its knowledge cutoff; every run records the code digest,
git commit, parameters, seeds, data range and metrics (`recs-work/runs/{run}/manifest.json`).
The recipe hash (code digest + parameters) and the cutoffs tie a published run to the
backtests that justified it: a run's gate decision names the run and the evaluations of its own
rolling cutoffs, so neither a change of code or parameters nor a pass from another week can
publish it (§5).

## 2. The behaviour simulator

There is no real traffic yet, so a simulator stands in for members. It is also the only place
where the true answer is known, which the evaluation uses (regret against the oracle) and which
must never leak into training: ground truth goes to a separate directory that only the
evaluation harness reads (a test asserts the store contains only `events/` and `catalog/`).

**World.** The real catalogue (119 titles, 16 genres, 32 moods, 317 people), each title with a
hidden quality correlated with its seed popularity and an 8-dimensional latent vector only
partly explained by genre. Households of 1-5 profiles: an owner, then partners, young adults,
shared "family" profiles, teens (13+ or 16+ ceiling) and kids (7+, kids profile). Tastes are a
household component plus an individual one over genres, moods, favourite people, series vs
movies, quality sensitivity, novelty seeking and the latent factors. True static utility:

    U(p,t) = genre match + 0.4 mood match + 0.5 people match + series bias
           + quality_weight(p) · quality(t) + 0.55 · <u_p, v_t>/√8 + noise(p,t)

**Behaviour.** Sessions per day (Poisson; weekend uplift; evening peak), a log-normal time
budget (median 45 min). The home page comes from a *logging policy*: a Python stand-in for the
milestone 1 engine (same score formula and row order, simplified rules; it sees only the
profile's library, never the truth). Members resume Continue Watching, then scan modules
top-down with their own patience; a card on screen at position k of module r is examined with
probability `k^-0.7 · max(0.45, 1 - 0.05 (r - 1))` (6 cards visible, 12 when the row is scrolled);
an examined card is clicked with `σ(2.2 (U_dyn - 2))`, where the dynamic utility adds a novelty
boost for new arrivals and subtracts fatigue from repeated impressions and penalties for titles
finished or dropped. Opening leads to play with a utility-dependent probability; watching
completes or stops after a Beta-distributed fraction (then the title is dropped); budget can
run out mid-title (resumed later); series play episode by episode with autoplay bingeing; 4% of
plays are accidental samples. 7% of sessions search for a title the member wants, whatever the
rows show. Ratings and list actions follow utility. Account satisfaction drives a daily churn
hazard; 35% of accounts sign up during the window (cold profiles), with trials and billing
transitions. 5% of sessions are *exploration* sessions: module order and item order within rows
are randomised and flagged `context.policy.explore`.

**Privacy-relevant behaviour, collected like the product.** Kids profiles and teens with a
lowered ceiling are simulated (they share their household's devices and evenings), but, as in
the product (packages/core/src/areas/events/collector.ts), nothing of theirs is stored, client
or server: `restricted: true` never reaches the lake. 12% of accounts decline personalisation,
6% analytics, 3% change their mind during the window (a `consent.change` event); an account
with neither purpose stores nothing but its consent changes. The rules are applied after every
random draw for an event, so switching them off reproduces the earlier lake exactly plus the
dropped events (a test checks both directions).

**Delivery faults.** 1% of events delivered twice: a client event either redelivered by the
queue (same receipt) or retried by the client hours later (a later receipt), a server event
always with its original receipt (a job retry or a second outbox drain); 2% of app sessions
delivered late (offline for 1-72 h); 3% of devices with a clock off by minutes to hours. A title
interrupted because the member ran out of time ends as the product ends a session nobody
released: an `abandon` with reason `expired`, at the last report, received 140-200 s later.

**Experiments.** Profiles are assigned by a hash of salt, key and profile key; exposure is logged
when the home page is rendered, once per profile and variant per 30 days, with the unit's
assignments and the page's policy, as the product logs it; the planted effect multiplies the
treatment profiles' session rate by 1 + effect (so qualified plays per member, the registered
primary metric, move by about that much). The documented runs carry an A/A test and a +10%
test. A planted effect only tests that the analysis detects a difference of a known size; it
says nothing about learned versus rules. For that, an experiment can be **served**
(`--experiment key:served=learned:start=DAY --learned-store … --learned-run …`): from its start
day the treatment arm's home pages are composed with a scored run's lists the way the engine
composes them under the learned policy (the model's billboard and Top Picks, rows ordered by
its personal scores, its Because You Watched rows first, its percentiles as the taste term, a
session boost for neighbours of what was just watched; the rules still dispose), in the
simulator's Python stand-in for the engine; the control arm keeps the rule pages. Nothing about
the experiment happens before its start, so a first pass without the run produces the same
lake up to that day (event for event, tested), the run is trained on it, and a second pass
serves it (§7, "Learned against rules, online").

**Determinism and scale.** One generator per account (seed, account index): the lake is
byte-identical whatever the number of worker processes (tested). Generation is separate from
output: the same generator drives an in-memory sink (tests) or the lake writer. Objects are one
per hour and shard by default; `--object-layout writer` groups the same events the way the
product's writer does (client batches of at most 50 events and 64 KiB per device, outbox drains
of up to 100 playback events, one object per other server event), which multiplies the number
of objects and is meant for exercising compaction and erasure, not for the documented runs. A
replay sink for the real `POST /events` would batch client events the same way and drive the
playback routes for server events.

### What the simulator builds in

The simulator's members were written by us, and part of the learned model's offline win comes
from that writing. What the gated difference (learned home page − engine home page, utility@10)
is made of, by component of the true utility, at medium size and the latest cutoff (day 35;
the reviewer's decomposition, re-run on the current harness; seeds 7 / 8 / 9):

| Component of U (`world.py`) | Share of within-profile variance | Contribution to the gated difference |
| --- | --- | --- |
| genre match | 0.44 (34-37%) | +0.005 / +0.011 / +0.036 |
| quality (linear in seed popularity) | 0.37 to 0.47 (30-36%) | −0.026 / −0.001 / +0.010 |
| latent part content features cannot see (`latent_free`) | 0.18 to 0.20 (14-16%) | +0.019 / +0.017 / +0.003 |
| latent part aligned with genres | 0.09 (7%) | +0.011 / +0.005 / +0.007 |
| series bias | 0.06 (5%) | +0.012 / +0.009 / +0.010 |
| idiosyncratic noise | 0.12 (9-10%) | +0.005 / +0.005 / +0.004 |
| mood, people | 0.03 | about 0 |
| **total** | | **+0.024 / +0.045 / +0.071** |

* A rank-8 bilinear term (`0.55 · <u_p, v_t>/√8`, world.py) is about 15% of each member's
  utility variance by construction. Content features cannot see it; collaborative filtering
  (ALS) is built to find it. It is the largest single source of the win for seeds 7 and 8 (four
  fifths and two fifths of it) and almost none for seed 9, where the model wins on genre match.
* The engine's weights are fixed (popularity 0.2, trend 0.15, freshness 0.1 of the score),
  while simulated quality is linear in seed popularity: whether ranking by popularity helps or
  hurts against quality depends on numbers we chose.
* Members examine cards exactly as the position-bias model and the EM ranker assume
  (`k^-0.7` times a row attention, behaviour.py): the correction is fitting the true model.
* The gate scores static utility, while members also act on a novelty boost for new arrivals.
  Scored with that boost too, the gated difference stays about where it is (+0.025 / +0.040 /
  +0.058 against +0.024 / +0.045 / +0.071 static): the static oracle is not what makes the
  learned page win.

For real members the sign of the difference depends on magnitudes the simulator cannot know.
The relative ordering of components is informative about the pipeline; the size of the win is
not a prediction.

## 3. The dataset

`build-dataset --as-of T` reads only events **received** before T: a backtest at T sees exactly
what production knew at T, late arrivals included. Then: schema validation, deduplication by
`eventId` (earliest receipt kept), per-device clock correction (the median offset between client
and server clocks over a device's events; 12 h or more counts as offline delay, not clock
error), and eligibility: every restricted event dropped, and every profile whose latest state is
restricted or whose account's latest consent stamp lacks personalisation dropped with its whole
history. Each rule is counted in the dataset manifest (the full run's counts are in §6). On the
product's lake the restricted rule finds nothing (the collector stored nothing of restricted
profiles); it stays as the second line, and §11 notes what it no longer covers.

Implicit feedback strength per profile and title (blueprint §7.1):

    watch    movie: 0.3 + 1.2 · watched fraction + 0.5 · completed      (needs ≥ 30 s)
             series: min(3, 0.3 + 0.25 · episodes started + 0.15 · episodes completed)
    + 0.8 while in My List, + 2 love / + 1 like; a dislike zeroes it and marks a negative
    × max(0.2, 0.5 ^ (days since last interaction / 60))

Impression labels are attributed to the card itself: *opened* when a `title.open` with the same
module and card position (`context.rowRank`, `context.rank`) follows within 30 minutes;
*played* when, in addition, the title starts within 30 minutes and is watched for at least
30 s. A play of the same title reached another way (another row showing it, search) does not
count for this card. Impressions after the first played card of the same showing of a row are
marked *censored* (the member left the row; those cards never had a chance). Impressions in the
last 30 minutes before the cutoff are left out (their label is not known yet).

## 4. Models

**Co-watch similarity with shrinkage.** Cosine over profiles' qualified plays with inverse user
frequency weights `1/log2(2 + n_u)`, multiplied by `n_ij / (n_ij + 20)` so pairs with little
support shrink toward zero (Koren 2008). Neighbours blend it with content similarity per pair,
weighted by support `min(n_i, n_j) / (min(n_i, n_j) + 30)`: a new title gets content
neighbours, then earns co-watch ones.

**Implicit matrix factorisation.** Alternating least squares on confidence-weighted
preferences (Hu, Koren, Volinsky 2008): preference 1 for positive strength, confidence
`1 + 8 · strength`; a dislike is a confident 0. 12 factors, regularisation 30, 12 iterations.
With ~120 titles, 32 factors overfit badly (NDCG@10 of ALS alone 0.13 vs 0.25); the setting was
chosen on the validation week *before* the cutoff by logged NDCG@10, never on the simulator's
truth. Profiles are folded in at scoring time from their current history (one k×k solve), so a
profile created after training still gets a vector. Titles nobody had played at training time
get factors from a ridge regression of factors on content vectors.

**Content vectors.** TF-IDF over name, tagline and synopsis (English stop words, sublinear term
frequency) concatenated with weighted metadata tokens (genres by relevance, moods, directors,
creators, lead cast, type, decade, original), reduced to 24 dimensions by truncated SVD and
L2-normalised. A sentence-embedding model would add gigabytes of dependencies for 120 synopses
whose metadata already carries most of the signal; this is milliseconds and deterministic.

**Learned ranker with position bias corrected.** Training examples are impressions in the week
before the cutoff, in browsing rows (not Continue Watching, My List, Watch It Again or the
billboard), not censored, of titles the profile had not watched; label: played (attributed). 23 features: ALS score and
within-profile percentile, co-watch score and maximum similarity to watched titles, content
and genre affinity, plays in the last 7 and 28 days and their trend, seed popularity, age and
"new", type, original, length, profile tenure, activity, series share and match, repetition
(impressions without a play in 14 days), in My List, opened before, cold profile.

A play depends on the title and on where it was shown. Under the examination hypothesis
`P(play | shown at row r, rank k, x) = θ(r, k) · γ(x)`, and ranking should use γ, the chance the
member plays the title once they have seen it. Two deliberate steps:

1. **θ from exploration traffic.** In exploration sessions rows and items are shuffled, so what a
   card shows is independent of where; the rate at which cards are opened, by rank relative to
   rank 1, estimates `k^-γ` (weighted least squares, bootstrap interval over profiles), and by
   module position the row attention (made monotone). Two details decide whether this works,
   and the simulator's truth (γ = 0.7) shows it: with unattributed labels (any play of the
   title within 30 minutes) the curve flattens, γ̂ = 0.645 [0.610, 0.685] at full scale,
   because a title shown in several rows is credited everywhere; with attributed labels but no
   censoring it steepens, γ̂ = 0.875 at medium scale, because members leave a row once they
   play something (a cascade the examination hypothesis does not model). Attribution plus
   cascade censoring gives the estimate in §6. What remains is survivorship: showings where
   nothing was played early stay uncensored further right and are less appealing on average,
   which still tilts γ̂ upward.
2. **Regression-EM with θ fixed** (Wang et al., WSDM 2018). E-step: a play means relevant; for an
   impression without a play, `P(relevant | no play) = (1 - θ)γ / (1 - θγ)`. M-step: refit the
   gradient-boosted classifier on soft labels written as two weighted copies of each example
   (positive with weight P(relevant), negative with the complement): the exact expected
   log-likelihood, with non-negative weights. Three rounds from the naive model.

Why pointwise gradient boosting (scikit-learn's histogram GBDT) and not LambdaMART: LightGBM's
and XGBoost's macOS wheels need a system OpenMP runtime (`brew install libomp`), which this
project rules out; the pointwise EM objective is the standard unbiased one for this setting and
yields calibrated probabilities the re-ranker can trade against diversity. On Linux images
LightGBM's lambdarank (with its own position-bias option) would be a drop-in experiment; it has
not been measured here. The naive model (round 0, raw labels) is kept for the ablation.

**Re-ranking.** For the "top picks" row and the billboard: greedy maximal marginal relevance over
the 60 best candidates, `0.85 · relevance − 0.15 · max similarity to already chosen + 0.06 ·
freshness (titles under 30 days) − 0.05 · log(1 + impressions without a play in 14 days)`,
relevance being the within-profile percentile of the ranker score. Billboard candidates are
restricted to titles the profile has not started.

**Temporal stacking.** Stage A fits the candidate models on the history as of T − 7 days; stage
B trains the ranker on the impressions of [T − 7 d, T) with stage-A features (so a feature never
saw its own label); stage C refits the candidate models as of T for scoring. All seeds fixed.

## 5. Evaluation

**Protocol.** Cutoff T = the run's knowledge cutoff; test window [T, T + 7 days). Population:
eligible profiles with at least one *discovery* in the window (a qualified play of a title that
had arrived by T and that they had not played before T); gain 1, or 2 if they completed an
item. Every system ranks the same universe per profile (arrived by T, not watched before T).
Systems: random; popularity (plays in the last 28 days); co-watch item-kNN; ALS; content; the
ranker (debiased) and its naive twin; `learned` (the pipeline's final list: re-ranked top
picks, then the rest by score); **the real milestone 1 engine**, run through
`scripts/rule-engine-rankings.ts` on each profile's library as of T: its `score()` order
(`rule-engine`), its home page in reading order (`rule-engine-home`: billboard, then the first
six cards of every row, then the next six), and **its home page with the run handed to it as the
learned policy's candidates** (`learned-home`: the run's neighbours and the profile's lists, as
serving passes them; the model proposes, the rules dispose). `learned-home` is what members are
served under the learned policy; `learned` is a component. Every system sees item statistics
(plays in the last 7 and 28 days, distinct viewers, the engine's Trending and Top 10 views) over
all eligible profiles, as training, scoring and the product compute them, not over the evaluated
population only. And the oracle (true utility). Intervals: 1000 bootstrap resamples over
profiles, paired for differences.

**Metrics @K** (K = 10, 20): recall, NDCG (graded), MAP, hit rate; diversity (1 − mean pairwise
similarity in the engine's content-feature space, model-independent); novelty (mean
−log2 of the share of training profiles who played the title); coverage (share of available
titles in anyone's top K); and, from the simulator's truth, utility@K (mean true utility of the
top K) and regret@K (oracle's utility@K minus the system's).

**Logged plays are not a neutral judge.** Members can only play what the platform showed them,
and the platform showed them what the incumbent ranked high. Replay metrics on all discoveries
therefore reward resembling the logging policy and predicting what members did with what they
were shown, rather than what they value. On the simulator at medium scale the engine's own home
page order scores *above the oracle* on replay NDCG@10 (0.541 vs 0.514) while delivering far less
true utility (0.631 vs 1.722); at full scale the learned system also scores above the oracle on
replay (0.548 vs 0.538). The oracle knows every member's true preferences exactly.
The report keeps three families apart: replay on all discoveries (biased toward the incumbent);
replay on *search* discoveries (titles members sought out whatever the rows showed; robust to
exposure, smaller sample); and true utility (unbiased, simulator only).

**The gate.** One backtest passes when **utility@10 of `learned-home` minus `rule-engine-home`**
has its 95% paired bootstrap interval entirely above zero (a positive mean whose interval
reaches zero is within noise, and within noise is a loss). A production run trained as of T is
published only if the backtests of its own recipe at **every** rolling cutoff T − 7 d, T − 14 d,
T − 21 d passed (`WEBFLIX_RECS_GATE_CUTOFFS`, default 3): `train-and-score` trains and evaluates
each, writes the run's decision (`recs-work/evaluations/{recipe}/decision-{run}.json`, also in
the version's manifest), and `publish` checks it again against the evaluation reports as they
are then. A pass from another week cannot stand in for the run's own, and an evaluation re-run
later that failed makes the run unpublishable (services/recs/README.md, "The gate").

Why this comparison: it is what members see under each policy, the page the engine assembles
with and without the model, rather than the pipeline's own list against the engine's score order
(the engine's home page usually costs about 0.08 of utility@10 against its score order, and the
assembled page with the model costs up to 0.09 against the model's list: comparing lists would
measure neither page). Why utility@10: it is what "beats the rule engine on the simulator"
(blueprint §7.1) means once exposure bias is taken seriously, and ten is about the first screen.
Why several cutoffs: the bootstrap interval only covers which profiles were sampled; the
simulator's seed and the week move the result four to five times more (§6), so one week's pass
is weak evidence and three consecutive weeks are less weak. It is still not a measure of real
lift: without truth (real data) the gate falls back to search-discovery NDCG@10, and the online
experiment (§7) is the decision. A young lake cannot pass: each cutoff needs plays from before
it minus 7 days, so three cutoffs need four weeks of lake, and nothing is published (the product
serves the rules) until then.

**Leakage.** The harness refuses (`LeakError`) a run trained after the cutoff, a run that read
any event received at or after it, a dataset that does not cover the test window, and an
external rankings file produced after the cutoff. A backtest learns from a dataset built as of
its own cutoff, not from the job's dataset as of T: a dataset built later decides eligibility
and device clock offsets with later events and labels the ranker's impressions with plays (and
watched seconds) received after the cutoff, while every row it hands over passes the
received-before-cutoff filter. Measured at medium size (seed 7, day 35) before the change: the
later dataset inflated the gated difference from +0.024 [0.019, 0.029] to +0.035 [0.030, 0.040],
and the ranker's utility@10 from 0.723 to 0.750. Small per event, a third of the result. The
leak test plants two leaks on the real
catalogue: a run trained through the test window, and a rankings file that peeked at it; both
are refused, and with the guard bypassed both inflate the metrics (the peek reaches recall@20
of 1.0; in a medium-scale probe during development the leaky run moved NDCG@10 from 0.513 to
0.545, four times the interval half-width).

## 6. Results

What was run on the current code (recipe `75bc3909`): smoke (300 households, 21 days: one gate
cutoff fits, day 14) and medium (8,000 households, 42 days: cutoffs at days 35, 28 and 21) for
simulator seeds 7, 8 and 9 (`SEED=N WORKERS=4 services/recs/scripts/run-local.sh medium`), and
the full size once (below). The +0.112 [0.109, 0.115] this document reported before came from an
older recipe (`986d4ce2`) on an earlier lake, compared the pipeline's own list with the engine's
score order, and was one seed at one week: it is withdrawn. Means with 95% bootstrap intervals
(1,000 resamples over profiles).

**The gate at medium size, every seed and every cutoff** (utility@10; the gated difference is
`learned-home` − `rule-engine-home`; the last column is the comparison the gate used before, the
pipeline's list against the engine's score order, kept as a component):

| Seed | Cutoff | Profiles | learned-home | rule-engine-home | Gated difference | learned − rule-engine |
| --- | --- | --- | --- | --- | --- | --- |
| 7 | day 35 | 6,486 | 0.655 | 0.631 | **+0.024 [+0.019, +0.029]** | −0.009 [−0.017, −0.001] |
| 7 | day 28 | 5,873 | 0.532 | 0.479 | **+0.053 [+0.047, +0.058]** | +0.023 [+0.014, +0.031] |
| 7 | day 21 | 5,695 | 0.559 | 0.459 | **+0.100 [+0.094, +0.108]** | +0.084 [+0.075, +0.093] |
| 8 | day 35 | 6,544 | 0.695 | 0.650 | **+0.045 [+0.039, +0.051]** | +0.030 [+0.022, +0.038] |
| 8 | day 28 | 5,785 | 0.572 | 0.534 | **+0.038 [+0.033, +0.044]** | −0.010 [−0.020, −0.000] |
| 8 | day 21 | 6,067 | 0.759 | 0.660 | **+0.100 [+0.093, +0.106]** | +0.054 [+0.044, +0.063] |
| 9 | day 35 | 6,211 | 0.705 | 0.634 | **+0.071 [+0.066, +0.076]** | +0.095 [+0.086, +0.103] |
| 9 | day 28 | 5,277 | 0.641 | 0.568 | **+0.073 [+0.066, +0.080]** | +0.155 [+0.145, +0.166] |
| 9 | day 21 | 5,109 | 0.625 | 0.581 | **+0.044 [+0.038, +0.050]** | +0.074 [+0.064, +0.083] |

All nine pass and all three runs were published. Across the nine: mean +0.061, standard
deviation 0.027, range +0.024 to +0.100 (4% to 22% of the engine's home page). Each interval's
half-width is 0.005 to 0.007: **the seed and the week move the result four to five times more
than the interval admits**, so no single interval is the uncertainty of the magnitude. What
these numbers support: at medium size, on this simulator, the learned home page beat the
engine's home page in every one of nine seed-and-week cells, by 0.024 to 0.100. The comparison
of lists the gate used before loses in two of the nine (seed 7 day 35, seed 8 day 28).

* **Exposure-robust replay** mostly agrees: search-discovery NDCG@10 of the learned home page
  minus the engine's is +0.004 to +0.036, every lower bound at or above zero except one (seed 7,
  day 35: −0.006). Replay NDCG@10 on all discoveries disagrees (−0.040 to −0.127): members were
  shown the engine stand-in's pages, and that family rewards resembling them (§5). It is
  reported, never used to decide.
* **Ablations vary as much as the gate.** Position-bias correction (debiased − naive ranker):
  −0.024 to +0.113, median +0.023, negative in two of nine; "worth a third of the gain", as
  written before, was a single draw. Re-ranking (published list − ranker): −0.022 to −0.051, the
  price of diversity. The engine assembling the page with the model (learned-home − learned):
  −0.092 to +0.028, negative in eight of nine (the page's rows that are not personal, Continue
  Watching, Top 10, and the rules take space from the model's best titles). The engine's own home
  page against its score order: −0.08 in six of nine cells, about 0 in the others.
* **Slices** (day 35): warm profiles gain in every seed (0.634 vs 0.604, 0.680 vs 0.610, 0.676
  vs 0.608); cold profiles (under 14 days or 3 plays, about 1,800) gain in one seed of three
  (0.710 vs 0.698, 0.731 vs 0.753, 0.782 vs 0.703: the first two within noise). Cold-start titles:
  recall@20 of discoveries of titles under 14 days old is 0.99 for every system with freshness
  signals.
* **Position bias** (day 35): γ̂ = 0.75 [0.65, 0.84], 0.70 [0.61, 0.78], 0.82 [0.72, 0.92] for
  seeds 7, 8, 9, against the true 0.7 (§4 on why it tilts upward).

**Smoke size** (about 245 profiles, cutoff day 14, seeds 7 / 8 / 9): the learned home page does
not win, −0.022 [−0.048, +0.007] / +0.004 [−0.027, +0.037] / +0.026 [−0.011, +0.058], and the
gate refuses every time; the list comparison loses clearly, −0.093 / −0.153 / −0.131. With a few
thousand ranker examples the content-and-popularity engine is as good a bet, which is the point
of a gate.

**Full size, once** (60,000 households, 56 days, seed 7; recipe `81724e67`, the code as this
round leaves it; 28.7 million lake events, 89,016 eligible profiles): the gate passed at all three
cutoffs and the run was published.

| Cutoff | Profiles | learned-home | rule-engine-home | Gated difference | learned − rule-engine |
| --- | --- | --- | --- | --- | --- |
| day 49 | 46,467 | 0.691 | 0.590 | **+0.101 [+0.099, +0.103]** | +0.113 [+0.110, +0.116] |
| day 42 | 42,826 | 0.518 | 0.486 | **+0.032 [+0.030, +0.034]** | +0.059 [+0.055, +0.062] |
| day 35 | 41,470 | 0.564 | 0.456 | **+0.108 [+0.106, +0.110]** | +0.179 [+0.176, +0.182] |

The intervals are ±0.002 and the week alone moves the result from +0.032 to +0.108; one seed was
run, so the spread across seeds at this size is not known. Search-discovery NDCG@10 agrees
(+0.058, +0.016, +0.027, all above zero); position-bias correction +0.014 to +0.034; re-ranking
−0.024 to −0.046; the engine assembling the page with the model −0.071 to −0.131 against the
model's list. Warm profiles 0.677 vs 0.563, cold (9,702) 0.742 vs 0.693 at day 49. γ̂ = 0.76
[0.73, 0.80]. Experiments: the A/A not significant (−0.0%, p 1.0; SRM p 0.014 against the 0.001
threshold), the planted +10% read as +8.7% [+7.5%, +9.8%] (p 5e-50), as on the earlier lake.


**What this round changed in the numbers** (medium, seed 7, day 35): computing the evaluated
systems' item statistics over all eligible profiles, as scoring does, moved the list comparison
from +0.040 to +0.023; training the backtest on a dataset as of its own cutoff instead of the
job's dataset (§5, leakage) moved the gated difference from +0.035 to +0.024 and the list
comparison from +0.023 to −0.009.

### Run time and memory

On an 18-core, 48 GB laptop, `WORKERS=4`, `WEBFLIX_RECS_THREADS=4`, three gate cutoffs (one at
smoke size), each backtest on its own dataset. Peak RSS is per step (the larger of the main
process and any worker).

| Step | smoke (s / MB) | medium, seed 9 (s / MB) | full (s / MB) |
|---|---|---|---|
| simulate | 1.9 / 124 | 37 / 176 | 300 / 261 |
| compact | 0.5 / 129 | 8.0 / 261 | 52 / 747 |
| build-dataset (as of T) | 1.8 / 227 | 11.9 / 1,862 | 61 / 8,437 |
| build-dataset, each cutoff | 1 to 3 / 185 | 6.5 to 10.9 / 1,047 to 1,543 | 35 to 52 / 5,510 to 7,573 |
| train, each backtest | 36 / 296 | 37 to 48 / 1,187 to 1,600 | 49 to 55 / 6,718 to 9,124 |
| evaluate, each (incl. the Node rule engine, three pages) | 1.8 / 321 | 6.5 to 7.9 / 1,528 to 1,855 | 47 to 53 / 7,865 to 9,901 |
| train (production) | 44 / 308 | 39 / 1,713 | 47 / 10,278 |
| score | 1.0 / 331 | 3.6 / 1,558 | 23 / 8,140 |
| publish + validate | refused | 1.5 / 245 | 4.7 / 541 |
| analyse-experiments | 3.0 / 241 | 12.3 / 1,425 | 68 / 8,199 |
| **whole run** | **about 90 s** | **286 s** | **995 s (16.6 min), peak 10.3 GB, no swap** |
| events / profiles | 107 k / 696 | 3.69 M / 17,990 | 28.7 M / 135,679 |

Memory at full size is dominated by holding a whole dataset (8.8 M playback rows, 9.9 M
impressions) in memory with string profile keys; streaming the tables per profile shard would
bound it, and is the next step before a member base ten times larger.

## 7. Experiment analysis

`analyse-experiments` reads exposures and outcomes from the lake, per pre-registered experiment
(the product's definitions, read from the staff API, or the simulator's), and writes the
results where the experiments area imports them (services/recs/README.md, "Experiment
results"):

* **Population**: units as the product assigns them, the profile (pseudonymous key) or, before
  sign-in, the device; a unit enters at its first `experiment.exposure` inside the window. The
  product logs an exposure for both arms, only when a treatment could apply (a fresh model, for
  the recommendation experiment), once per unit and variant per 30 days. Excluded and counted:
  restricted (0 on the product's lake), no analytics consent (the account's latest stamp; a
  device's own), unknown variant, more than one variant. A device unit's outcomes are those of
  the profiles signed in on that device (playback events carry no device).
* **Layers**: units also exposed to another experiment of the same layer while both ran are
  counted (`diagnostics.layerOverlapUnits`); the product's disjoint allocations make it 0.
* **Pre-registration**: refused if registered after the start or exposed before registration;
  the primary metric is fixed by the definition. A product experiment's window starts at its
  registration when staff set its start earlier, since the product assigns nobody before. Its
  latest status change bounds the window too: a start scheduled for later starts it then, and a
  `completed` or `paused` experiment's window ends when that took effect (not at an absent or
  later `endsAt`); a `completed` one with neither time is skipped. A definition carries only the
  latest change, so a pause that has since been resumed cannot be seen and its days count as
  running.
* **Sample-ratio mismatch**: chi-square against the design weights; below p = 0.001 the decision
  is `invalid-sample-ratio-mismatch`.
* **Metrics** per unit since first exposure: qualified plays, watch hours, any play, active
  days, retained; per-variant means with intervals, Welch difference, delta-method relative lift.
  The primary metric decides at α (split over treatments); secondary metrics are judged at α
  split over them as well (Bonferroni), so `significant` on one of four secondaries is not the
  one-in-five chance finding it would be at the primary's level.
* **Peeking protection**: the mixture sequential probability ratio test (Johari et al. 2017)
  with a normal mixture, at daily looks, giving always-valid p-values and confidence sequences.
  Staff read results in the admin console whenever they like; a fixed-horizon test checked daily
  rejects a true null far more often than its nominal 5%, while the always-valid p-value keeps
  the false-positive rate at or below α under any looking schedule. Mixing scale τ = MDE ×
  control mean: the prior puts its mass on effects the experiment was sized for. The
  fixed-horizon Welch test is reported too, valid only at the registered end.
* **Calibration** (tests, deterministic): 300 simulated A/A experiments with 14 daily looks:
  mSPRT false-positive rate 0.000, naive daily peeking 0.170 — the protection is necessary and
  works. The bound asserted is 0.02, not α: on this generator the mixture test is conservative
  (about 1 in 600 over 1,000 seeds, measured in review), and a bound at α let through an
  estimator whose variance was half the truth (false positives 0.045 to 0.062). A second test
  recomputes the always-valid p-value from the units' values with plain numpy (Welch variance
  at each look, the mixture likelihood ratio, the running maximum) and requires the report to
  match it exactly, so a variance off by any factor fails whatever the A/A rate. A planted +20%
  effect on qualified plays, 200 seeds, 5,000 units: detected 68.5% of the time against a
  computed mSPRT power of 63.4% (Monte Carlo of the estimator's Gaussian path at the planned
  looks), inside the tolerance; the fixed-horizon power for the same design is 90.6%, which is
  the price of looking any time. The mixing scale is recomputed at each look from the control
  mean (τ = MDE × control mean); fixing it at the design would make the guarantee exact for a
  fixed estimand, but the estimand of a cumulative metric grows with the window and a scale
  fixed on day one would be too small by the end; the A/A calibration is the check.
* **What the analysis can detect** (minimum detectable effect at 80% power, mSPRT, daily looks,
  α = 0.05, from the medium lake's own A/A experiment: per-unit qualified plays and their
  covariance across the 42 looks; other sizes by scaling the units): **5.4% at medium** (12,825
  units), **2.0% at full size** (97,000 units; an approximation, the full window is 56 days),
  **43% at smoke size** (489 units). Power at +5%: 0.73 at medium, 0.00 at smoke. The registered
  MDE of the simulated experiments (5%) is therefore just within reach at medium and far out of
  reach at smoke size, where no experiment result means anything.

**Planted effects, medium size (simulator, events through the real lake path), seeds 7 / 8 /
9.** Two experiments registered before the start, profiles as units, qualified plays as the
primary metric, MDE 5%, daily looks:

| Experiment | Units | Control mean | Lift [difference 95% CI] | Always-valid p | Decision |
|---|---|---|---|---|---|
| `recs-aa` (identical variants) | 12,825 / 12,969 / 12,797 | 20.7 / 22.6 / 24.3 | +2.1% / +0.5% / −0.5% (every CI covers 0) | 0.87 / 1.0 / 0.83 | not significant ×3 |
| `recs-ranking` (planted +10% visits) | 12,825 / 12,969 / 12,797 | 20.2 / 21.5 / 23.1 | +7.5% / +10.0% / +10.4% | 1e-5 / 8e-8 / 7e-10 | significant ×3 |

The planted effect multiplies visits by 1.10; qualified plays per member move by 7.5% to 10.4%
because churn and viewing time do not scale exactly with visits. At smoke size (489 units)
neither is significant, as the computed power predicts for that sample; at full size (one seed,
97,000 units) the A/A reads −0.0% (p 1.0) and the planted effect +8.7% (p 5e-50).

**Learned against rules, online (simulator).** What the offline gate cannot show is what
members do when they are served the learned pages. `served=learned` (§2) measures it: medium
households over 56 days; experiment `recs-learned` starts on day 42; a first pass simulates the
whole window with both arms on rule pages; a run is trained and scored as of day 42 from that
lake; a second pass, identical up to day 42, serves that run's lists to the treatment arm for the
last 14 days; the analysis runs on the second pass as the product would run it. Because both
passes share every member and random stream up to day 42, each unit's change between the passes
estimates what serving the run did to it (control arm: the spill-over through shared
households), which is far more precise than comparing arms within one pass.

Two seeds (7, 8), the run trained as of day 42 and served unchanged for the 14 days (about 6,000
units per arm). Effect of serving the run (paired estimate, 95% interval, relative to the
treatment arm's first-pass mean), by how long the run had been served when measured:

| Window after the start | Qualified plays (primary) | Watch hours | Active days |
| --- | --- | --- | --- |
| first 3 days | +1.1% [−1.8%, +4.0%] / +3.3% [+0.8%, +5.8%] | −1.9% [−4.8%, +1.0%] / +0.2% [−2.5%, +2.9%] | −0.3% / −0.0% (both within noise) |
| first 7 days | **+3.3% [+1.0%, +5.6%] / +4.2% [+2.0%, +6.4%]** | −0.7% [−3.0%, +1.7%] / −1.4% [−3.7%, +1.0%] | −0.2% / +0.2% (both within noise) |
| all 14 days | +0.7% [−1.1%, +2.4%] / +1.2% [−0.6%, +3.0%] | **−4.4% [−6.2%, −2.5%] / −3.4% [−5.2%, −1.5%]** | −1.9% [−3.1%, −0.6%] / −1.3% [−2.5%, 0.0%] |

* While the lists are fresh, the learned pages bring a few percent more qualified plays and no
  measurable change in watch time. As the run ages without being scored again, the gain in
  plays fades and members watch 3-4% less. What changes on the page (treatment arm, second pass
  against first): the model's billboard is opened half as often as the engine's (0.65 against
  1.29 and 1.35 opens per unit), its Top Picks row takes 0.45 opens, Top 10 loses some, and
  members resume and finish more of what they started (Continue Watching opens +9% to +10%,
  completions +8% to +10%) in shorter plays (27-28 minutes per play against 29).
* The product scores daily and falls back to the rules once a run's lists are three days old;
  the simulator serves one run for 14 days, so the 14-day row overstates what staleness costs in
  the product, and the first rows are closer to it. Serving a fresh run every day needs a pass
  per refresh, each identical to the previous one up to its day and trained on it (about two
  minutes per pass at medium size); it was not run.
* **Power.** The product's analysis (mSPRT, daily looks, the registered MDE of 5%) reads these
  experiments as not significant on the primary metric (+1.2% and −1.7% unpaired, CIs about
  ±3%); on watch hours, a secondary metric, it reads −2.6% (not significant) and −6.3%
  (significant at the split α). At medium size its power to detect the first week's effect
  (+3.3% / +4.2%) is 0.19 /
  0.42, and 0.99 / 1.00 at full size; for the 14-day effect it is 0.02 / 0.04 at medium and
  0.07 / 0.28 at full size. An online test sized like the medium simulation would most likely
  miss an effect of the size the simulator shows; one with full-size traffic would see the
  fresh-list effect.
* This is the simulator's members reacting to the simulator's port of the engine's learned
  integration (§9); it measures the direction and rough size the offline gate cannot, under the
  same assumptions as everything else here.


## 8. Serving hand-off

Artefacts (`recs/v={run}/…`, manifest last, pointer `recs/current.json` flipped last after
validation) and the importer recipe are specified in services/recs/README.md: neighbours as rows
(16 rows per `INSERT` at 6 bound parameters), per-profile lists as one JSON value per profile
(one KV key or one row; bulk writes), every list excluding watched, finished and disliked
titles, an `expiresAt` after which the engine falls back to the milestone 1 rules. Restricted
profiles are never in the artefacts; the engine also falls back for them by rule. An account
deletion reaches the artefacts too: `erase` removes the member's profile rows from every
retained version, recomputes the manifest and re-points `recs/current.json` (the version still
validates and imports).

## 9. What the numbers do and do not show

* They show that the pipeline is correct end to end (validation, deduplication, late and skewed
  events, privacy exclusions, retention, leakage guards, a gate tied to the run, atomic
  publishing), and that at medium size, on this simulator, the engine's home page with the
  learned candidates scored higher true utility@10 than the engine's own home page in every one
  of nine seed-and-week cells (+0.035 to +0.118).
* They do not show a magnitude. Each interval covers only which profiles were sampled; the seed
  and the week move the result four to five times more (§6), and part of the win is written into
  the simulator (§2, "What the simulator builds in").
* They do not show that members are better off. Served online in the simulator, the learned
  pages did not raise what members played and lowered how long they watched (§7, "Learned
  against rules, online"): the offline gate measures a ranked first screen against a static
  utility, members respond to whole pages, novelty, fatigue and bingeing. The product therefore
  defaults to the rules in production and the online experiment decides.
* They do not show real-world lift. The simulator's members were written by us; its utility
  model shares structure with both the engine (content features, popularity) and the learned
  models (latent factors).
* The logging policy is a stand-in for the engine, not the engine; the real engine is used for
  the baseline and learned pages offline, but simulated members reacted to the stand-in's pages,
  and the online experiment's learned pages come from a Python port of the engine's learned
  integration, not from `engine.ts`.
* Popularity in the logging policy comes from the seed baseline, not from simulated plays (shards
  run in parallel), so there is no popularity feedback loop in the simulated data.

## 10. Limitations

* 119 titles make candidate generation nearly exhaustive and let ALS hold dense matrices; a
  catalogue of tens of thousands would need sparse ALS (e.g. the `implicit` library), an
  approximate-nearest-neighbour candidate stage and top-N storage instead of per-title loops.
* The ranker is pointwise; a pairwise or listwise objective was not compared (see §4).
* Static true utility: the oracle ignores novelty and fatigue (scored with novelty, the gated
  difference barely moves, §2).
* Hyperparameters were set once on a validation week (ALS) or by design (re-ranking); there is no
  systematic search.
* The experiment analysis treats metrics that accumulate over the exposure window; its
  always-valid guarantee is verified empirically (A/A calibration) rather than proved for that
  estimand.
* Pickled scikit-learn models are verified by SHA-256 before loading but tie a run to the
  library version that wrote it.
* A fresh lake has nothing to train for its first two weeks and cannot pass the three-cutoff
  gate for four: `train-and-score` and `publish` report that and exit cleanly, and the engine
  serves the milestone 1 rules meanwhile.
* The evaluation's own population is chosen with the dataset as of the end of the test window:
  eligibility (consent, restriction) as of then, so a profile that withdrew consent during the
  test week is not evaluated. That is the privacy rule, applied to the judge; it does not reach
  what the models learned (below, §5).
* Erasure reads the whole lake three times (discover, rewrite, verify), reading only subject
  columns except where a key matches; daily that is about the cost of a dataset build at full
  size. Measured at smoke size only. Compacted hours are sorted by account with 1,000-row groups
  so the data export reads one or two groups per hour; at a much larger member base a per-account
  index would replace the scan.
* Erasure works on subject keys: device ids of signed-out events (no account, no profile) stay in
  the lake until retention removes them, since nothing ties them to the erased member.
* Device units of an experiment take the outcomes of every profile signed in on the device, so a
  shared device counts its household's plays once per device unit (and a profile on two devices
  twice); profile units, the product's default, are not affected.
* An event of a version this code cannot read yet is quarantined; every compaction re-validates
  the quarantine, so after an upgrade such events go back into their hour (services/recs
  `lake.py`); until the upgrade they are in no dataset.

## 11. From the simulator to real data

1. Done: the product's contracts adopted the event schema (`packages/contracts/src/events.ts`
   generates `services/recs/schemas/event.schema.json`), the reader is proven on objects the real
   writer produced (`tests/test_ingested_lake.py`, and the product's own test runs it on a lake
   the HTTP app wrote), the simulator stores only what that writer stores, compaction writes a
   format a small JavaScript reader decodes, erasure runs as an operation against the staff API,
   the events of members' data exports are extracted by a batch job (`export-events`: every
   hour still held, about 9,500 partitions at the default retention, does not fit a Worker
   invocation), retention is enforced on the store by age (`retain`, from the product's own
   settings), and experiment results land where the product imports them. Two facts of the
   product's writer the jobs account for:
   playback events and a few other kinds reach the lake from a database outbox on a scheduler
   tick (5 minutes by default, configurable: keep the jobs' 15-minute grace above it), and on
   Cloudflare every accepted client batch is its own object for now (many small objects per
   hour, which compaction folds into one file).
2. Start with replay metrics on search discoveries plus coverage and diversity guardrails as the
   offline gate (the evaluator does this when no truth is given), and keep an exploration slice
   (`context.policy.explore`) in production: without it position bias cannot be estimated.
3. Run the rule engine vs learned experiment (§7) before any default switch (the product's
   default policy in production is the rules); keep the A/A running in the same layer to watch
   the assignment and logging. Size it for what it must detect: at medium traffic the analysis
   detects about 5% on qualified plays, and the simulator's online effect of the learned pages
   was well below that on plays and negative on watch time.
4. Recalibrate the simulator against real aggregates (session rates, play rates by position,
   completion distributions) so that it stays useful for testing changes before they ship.
5. Restricted profiles emit nothing, so the pipeline cannot see a profile *become* restricted
   (a kids flag set, a ceiling lowered) from the lake. The product lists such a profile's key as
   pending erasure (and a deleted profile's, and an erased account's), and every dataset and
   scoring run leaves out every key pending when it starts, so neither its earlier history nor
   its lists survive the next run; the erase job then removes its events everywhere.
6. Consent is the account's latest stamp, except that a grant recorded by support never counts:
   staff can no longer grant for a member, and an old support grant in the lake makes the account
   count as not consenting until the member answers again (services/recs `consent.py`).

## 12. Mode mapping

| | dev | k8s | cloudflare |
| --- | --- | --- | --- |
| Jobs | `make recs` on the developer machine, store = the dev filesystem store | CronJobs running the `webflix-recs` image (docs/KUBERNETES.md §9.6): a lake round running `erase`, `export-events`, `compact` and `retain` one after another (Garage ignores conditional writes, so the scheduler is the lake's lock and says so with `WEBFLIX_RECS_LAKE_SERIALIZED=true`; without it the jobs refuse, exit 10), `train-and-score` and `publish`, `analyse-experiments` daily, store = Garage through `WEBFLIX_S3_*` | the same image run outside Workers (a container or any scheduler) against R2's S3 API, where the lake lease itself excludes overlapping jobs |
| Rule-engine baseline | Node script from the repository, in-process | `train-and-score --phase prepare`, the Node script in an image with the repository's packages, `--phase finish`, sharing an `emptyDir` | same |
| Erasure keys, experiment definitions | files, or the dev API with an access token | the staff API with a service account of the staff issuer (client credentials) | same |
| Artefacts read by | importer via the filesystem store | importer via S3 | importer via R2 binding |
| Members' exported events | the product's inline reader (raw and compacted hours) | `export-events`, the product folding its output into the export | same (`export-events` against R2) |

## 13. Public datasets

None was used. Every command runs on the simulator and the repository's catalogue only.
