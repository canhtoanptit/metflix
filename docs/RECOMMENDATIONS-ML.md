# Webflix — Recommendations: the learned pipeline

How milestone 2 learns recommendations offline and hands them to the milestone 1 engine
(docs/BLUEPRINT-M2.md §6-§9). Code and operating manual: `services/recs/` and its
[README](../services/recs/README.md), which also holds the exact artefact schema for the importer.
The rule engine and its guarantees are unchanged and documented in docs/RECOMMENDATIONS.md: the
engine stays the authority for page assembly and every rule; this pipeline only supplies
candidates, scores and neighbours, precomputed.

**Outcome (full local run, `make recs`, 60,000 simulated households, 56 days).** The learned
system beats the milestone 1 rule engine on the publish gate. The gate metric is the true utility
of the first ten recommendations: 0.787 against 0.675, a paired difference of **+0.112 (95%
bootstrap interval [0.109, 0.115])** over 46,458 profiles. It also wins on the exposure-robust
logged metric (search-discovery NDCG@10 +0.095 [0.089, 0.100]) and on plain replay
(NDCG@10 +0.073 [0.070, 0.077]). The run was published (`recs/current.json`), its artefacts
validated, and the experiment analysis reported the A/A test flat and the planted +10% effect
detected (+8.7%). These are simulator results: they validate the pipeline and the relative
ordering of systems under the simulator's assumptions, not real-world lift (§9).

**Since the product was built around the pipeline (November 2026).** The lake is now written by
the product's own writer, and the simulator stores only what that writer stores (restricted
profiles produce nothing, accounts without any consented purpose only their consent changes,
exposures once per unit and variant per 30 days), dropping events after every random draw so
that every stored event is byte-identical to the earlier simulator's. At smoke size the
evaluation is unchanged to the last digit (1,606 of 1,606 metric values, the gate interval, the
propensity estimate) and so are the experiment results; only counts of excluded data moved
(§6, §7). The full-run tables below were measured on the earlier lake; their accuracy numbers
are expected to be identical, their data-rule counts are not (§6 says which and why), and
refreshing them needs a full run on an idle machine (`make recs`, about 15 minutes and 10 GB).

## 1. Pipeline

```
 behaviour: the product's lake writer (POST /events, server events, the playback outbox);
            the simulator, collecting like the product, for tests and the documented runs
        │
        ▼
 events/dt=…/hh=…/*.ndjson.gz ──compact──► part-*.parquet (deduplicated, per closed hour)
        │                         ▲
        │                         └── erase (account deletions: lake, datasets, artefacts)
        │
        ▼ build-dataset (knowledge cutoff, validation, dedup, clock correction, eligibility)
 playback · actions · impressions(+labels) · profiles · accounts      (Parquet)
        │
        ▼ train (temporal stacking: candidates at T-7d → ranker on [T-7d, T) → candidates at T)
 co-watch (shrunk) · ALS · content (TF-IDF+SVD) · propensity · EM ranker · re-ranker
        │
        ├─► evaluate: backtest vs random, popularity, components, the real M1 engine, oracle
        │           → gate (utility@10 vs rule engine, paired 95% interval above zero)
        ▼
 score → recs/v={run}/{neighbours,profiles}/*.parquet + manifest → publish → recs/current.json
        │
        ▼ (TypeScript) importer → RecommendationStore → engine.ts

 analyse-experiments → experiments/results/current.json → (TypeScript) saveExperimentResults
```

Every stage records what it read and its knowledge cutoff; every run records the code digest,
git commit, parameters, seeds, data range and metrics (`recs-work/runs/{run}/manifest.json`).
The recipe hash (code digest + parameters) ties a published run to the backtest that justified
it: changing any code or parameter requires a new evaluation before anything can be published.

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
primary metric, move by about that much). The full run carries an A/A test and a +10% test.

**Determinism and scale.** One generator per account (seed, account index): the lake is
byte-identical whatever the number of worker processes (tested). Generation is separate from
output: the same generator drives an in-memory sink (tests) or the lake writer. Objects are one
per hour and shard by default; `--object-layout writer` groups the same events the way the
product's writer does (client batches of at most 50 events and 64 KiB per device, outbox drains
of up to 100 playback events, one object per other server event), which multiplies the number
of objects and is meant for exercising compaction and erasure, not for the documented runs. A
replay sink for the real `POST /events` would batch client events the same way and drive the
playback routes for server events.

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
ranker (debiased) and its naive twin; `learned` (the final list: re-ranked top picks, then the
rest by score); **the real milestone 1 engine**, run through `scripts/rule-engine-rankings.ts`
on each profile's library as of T (its `score()` order, and its home page in reading order);
and the oracle (true utility). Intervals: 1000 bootstrap resamples over profiles, paired for
differences.

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

**The gate.** `publish` refuses a run unless an evaluation of the same recipe shows
**utility@10 of `learned` above the rule engine's, with the 95% paired bootstrap interval of the
difference entirely above zero**. Why this metric: it is what "beats the rule engine on the
simulator" (blueprint §7.1) means once exposure bias is taken seriously; it measures what members
get from the first screen (ten is about the billboard and the visible cards of the first rows);
and it is a property of the ranked list, not of what the incumbent happened to show. Why paired
and interval-based: a point estimate would let noise publish. Without truth (real data) the gate
falls back to search-discovery NDCG@10, and the online experiment (§7) is the real decision.

**Leakage.** The harness refuses (`LeakError`) a run trained after the cutoff, a run that read
any event received at or after it, a dataset that does not cover the test window, and an
external rankings file produced after the cutoff. The leak test plants two leaks on the real
catalogue: a run trained through the test window, and a rankings file that peeked at it; both
are refused, and with the guard bypassed both inflate the metrics (the peek reaches recall@20
of 1.0; in a medium-scale probe during development the leaky run moved NDCG@10 from 0.513 to
0.545, four times the interval half-width).

## 6. Results (full local run)

`make recs` from an empty `.cache/recs/full`: 60,000 households (135,679 profiles, of which
89,004 eligible after excluding 27,973 restricted and 14,267 non-consenting; on the product-shaped
lake the restricted ones are not in the lake at all, see below), 56 days from
2026-09-01, 3.35 million sessions, 39.6 million lake events. Backtest cutoff 2026-10-20, test
window to 2026-10-27; 46,458 profiles with at least one discovery (1.55 per profile; 10,078 with
a search discovery); 113 titles available, 11 of them under 14 days old. Recipe `986d4ce2`
(the code digest and parameters of the repository as delivered). Means with 95% bootstrap
intervals (1000 resamples over profiles).

Data rules at work (measured on the earlier lake, which still held restricted subjects' events):
all 39.3 million events received before the cutoff validated (0 invalid); compaction dropped
211,676 duplicate deliveries; the dataset build removed 111,392 more that crossed hour
boundaries (client retries), corrected the clocks of 4,132 devices, accepted 272,842 client
events delivered more than an hour late (by receipt, as production would have), and dropped 3.3
million events of profiles that were not eligible, on top of every event flagged restricted.

What collecting like the product changes in these counts, measured at smoke size (same seed,
before → after) and expected in the same proportions at full size: lake events 134,335 →
107,139 (−20%: restricted subjects and accounts without consent store nothing); profiles seen
637 → 508 and excluded as restricted 128 → 0 (they are no longer in the lake at all); excluded
for consent 72 → 71 (an account with neither purpose now has no profile events); duplicates the
dataset removes in playback 131 → 0 (a server event's duplicate now keeps its receipt, so
compaction drops it within the hour); devices whose clock was corrected 15 → 13 (two devices
used only by restricted profiles). Every evaluated profile, every metric and the gate are
identical, because every stored event of an eligible profile is.

| System | Utility@10 ↑ | Regret@10 ↓ | NDCG@10 (replay) | Recall@20 | MAP@10 | Search NDCG@10 | Diversity@10 | Novelty@10 | Coverage@10 |
|---|---|---|---|---|---|---|---|---|---|
| oracle (true utility) | 1.657 [1.653, 1.661] | 0 | 0.538 [0.535, 0.542] | 0.915 | 0.436 | 0.486 [0.479, 0.494] | 0.851 | 4.74 | 1.00 |
| **learned** (published list) | **0.787 [0.784, 0.791]** | **0.870 [0.867, 0.873]** | 0.548 [0.545, 0.551] | 0.874 | 0.446 | 0.271 [0.265, 0.278] | 0.890 | 5.10 | 0.89 |
| ranker (before re-ranking) | 0.814 [0.810, 0.818] | 0.843 | 0.560 [0.557, 0.563] | 0.879 | 0.460 | 0.275 [0.269, 0.282] | 0.877 | 5.13 | 0.91 |
| ranker, naive labels | 0.766 [0.762, 0.770] | 0.891 | 0.550 [0.547, 0.552] | 0.880 | 0.447 | 0.272 [0.265, 0.279] | 0.880 | 5.21 | 0.94 |
| **rule engine** (M1, score order) | 0.675 [0.671, 0.679] | 0.982 [0.979, 0.985] | 0.475 [0.472, 0.478] | 0.861 | 0.386 | 0.176 [0.171, 0.182] | 0.821 | 3.54 | 0.99 |
| rule engine, home page order | 0.590 [0.586, 0.594] | 1.067 | 0.460 [0.456, 0.463] | 0.771 | 0.376 | 0.193 [0.187, 0.199] | 0.881 | 3.16 | 1.00 |
| ALS | 0.686 [0.681, 0.690] | 0.972 | 0.233 | 0.587 | 0.169 | 0.136 | 0.814 | 3.67 | 0.88 |
| co-watch item-kNN | 0.488 [0.484, 0.492] | 1.169 | 0.172 | 0.520 | 0.116 | 0.088 | 0.821 | 2.56 | 0.90 |
| content | 0.447 [0.443, 0.452] | 1.210 | 0.160 | 0.461 | 0.111 | 0.092 | 0.709 | 5.19 | 1.00 |
| popularity | 0.338 [0.334, 0.341] | 1.319 | 0.101 | 0.556 | 0.063 | 0.072 | 0.875 | 2.39 | 0.32 |
| random | -0.191 [-0.196, -0.187] | 1.849 | 0.047 | 0.188 | 0.028 | 0.044 | 0.887 | 5.63 | 1.00 |

**Gate**: utility@10 of `learned` minus the rule engine = **+0.112 [+0.109, +0.115] → pass**
(+16.6% relative; regret down from 0.982 to 0.870). Paired differences against the rule engine:

| System | Utility@10 | NDCG@10 (replay) | Search NDCG@10 | Recall@20 |
|---|---|---|---|---|
| learned | +0.112 [+0.109, +0.115] | +0.073 [+0.070, +0.077] | +0.095 [+0.089, +0.100] | +0.013 [+0.011, +0.016] |
| ranker | +0.138 [+0.136, +0.141] | +0.085 [+0.082, +0.089] | +0.099 [+0.093, +0.105] | +0.019 [+0.016, +0.022] |
| ALS alone | +0.010 [+0.007, +0.013] | −0.242 [−0.245, −0.239] | −0.041 [−0.046, −0.035] | −0.274 [−0.278, −0.270] |
| engine home order | −0.085 [−0.088, −0.083] | −0.015 [−0.018, −0.013] | +0.017 [+0.013, +0.021] | −0.090 [−0.093, −0.087] |

**Ablations** (paired):

| Change | Utility@10 | NDCG@10 | Search NDCG@10 | Diversity@10 | Novelty@10 |
|---|---|---|---|---|---|
| position-bias correction (EM ranker − naive ranker) | +0.048 [+0.046, +0.049] | +0.011 [+0.010, +0.012] | +0.003 [+0.001, +0.005] | −0.003 | −0.075 |
| re-ranking (published list − ranker) | −0.026 [−0.027, −0.025] | −0.012 [−0.013, −0.011] | −0.004 [−0.006, −0.002] | +0.013 | −0.032 |

The position-bias correction is worth a third of the gain over the engine. The re-ranker buys
diversity with some measured utility; part of that cost is an artefact of the static oracle,
which ignores the novelty members show in the simulation (§10), but the trade-off is real and
its weights are a product decision, not a tuned optimum.

**Slices** (utility@10; learned vs rule engine): new and recent profiles (cold: under 14 days or
under 3 plays, 9,690 profiles) 0.776 [0.769, 0.784] vs 0.728 [0.719, 0.737]; warm (36,768)
0.790 [0.786, 0.794] vs 0.661 [0.657, 0.665]. By profile type: owners 0.776 vs 0.663, partners
0.802 vs 0.689, shared family profiles 0.830 vs 0.734, young adults 0.786 vs 0.673 (all
intervals disjoint). On replay NDCG@10 the cold slice is close (0.450 [0.444, 0.456] vs 0.430
[0.424, 0.436]): with no history, both lean on popularity and freshness. **Cold-start titles**
(discoveries of titles under 14 days old): recall@20 0.981 [0.980, 0.982] for the learned
list, 0.948 [0.946, 0.950] for the engine, 0.578 for popularity; near the ceiling for every
system with freshness signals, because simulated members like new arrivals.

**Position bias**: γ̂ = 0.76 [0.725, 0.795] at full scale and 0.75 [0.67, 0.83] at medium scale,
against the true 0.7; the row-attention estimate decays from 1 at the first shuffled module to
about 0.37 at module 12 (truth relative to that module: 0.45/0.95 = 0.47), steeper than the truth because
deeper modules are reached by members who found nothing above (§4).

**Smaller sizes** (same code): at medium (8,000 households, 42 days; 6,486 evaluated profiles)
the gate passes with +0.046 [0.038, 0.054]; replay NDCG@10 cannot separate learned and engine
(0.511 vs 0.516) and the engine's home order scores above the oracle there (0.541 vs 0.514). At
smoke size (300 households, 21 days; 245 profiles) the learned models lose to the engine
(−0.165 [−0.217, −0.116], unchanged by the product-shaped lake) and **the gate refuses to
publish**: with a few thousand ranker examples the content-and-popularity engine is the better
bet, which is the point of having a gate.

### Run time and memory

On this machine (18 cores, 48 GB) shared with another project's Kubernetes cluster (load
average 15-30 throughout), `WEBFLIX_RECS_THREADS=4`, 12 worker processes for simulation, compaction and
lake reading. Peak RSS is per step (the larger of the main process and any worker).

| Step | smoke (s / MB) | medium (s / MB) | full (s / MB) |
|---|---|---|---|
| simulate | 1.8 / 130 | 24 / 177 | 161 / 237 |
| compact | 0.5 / 144 | 6.4 / 427 | 138 / 961 |
| build-dataset | 1.9 / 226 | 9.2 / 1,737 | 156 / 6,650 |
| train (backtest) | 32 / 293 | 58 / 2,037 | 119 / 7,254 |
| evaluate (incl. the Node rule engine) | 1.0 / 311 | 4.7 / 1,780 | 43 / 7,537 |
| train (production) | 33 / 308 | 36 / 1,716 | 168 / 9,212 |
| score | 0.7 / 332 | 3.5 / 1,511 | 23 / 8,214 |
| publish + validate | refused | 1.5 / 245 | 5 / 534 |
| analyse-experiments | 2.2 / 265 | 9.2 / 1,665 | 85 / 9,701 |
| **whole run** | **76 s** | **158 s** | **916 s (15.3 min)** |
| events / profiles | 134 k / 696 | 4.96 M / 18,049 | 39.6 M / 135,679 |

Memory at full size is dominated by holding the whole dataset (8.8 M playback rows, 9.8 M
impressions) in memory with string profile keys; streaming the tables per profile shard would
bound it, and is the next step before a catalogue or member base ten times larger.

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
  registration when staff set its start earlier, since the product assigns nobody before.
* **Sample-ratio mismatch**: chi-square against the design weights; below p = 0.001 the decision
  is `invalid-sample-ratio-mismatch`.
* **Metrics** per unit since first exposure: qualified plays, watch hours, any play, active
  days, retained; per-variant means with intervals, Welch difference, delta-method relative lift.
* **Peeking protection**: the mixture sequential probability ratio test (Johari et al. 2017)
  with a normal mixture, at daily looks, giving always-valid p-values and confidence sequences.
  Staff read results in the admin console whenever they like; a fixed-horizon test checked daily
  rejects a true null far more often than its nominal 5%, while the always-valid p-value keeps
  the false-positive rate at or below α under any looking schedule. Mixing scale τ = MDE ×
  control mean: the prior puts its mass on effects the experiment was sized for. The
  fixed-horizon Welch test is reported too, valid only at the registered end.
* **Calibration** (tests, deterministic): 300 simulated A/A experiments with 14 daily looks:
  mSPRT false-positive rate 0.000 (bound α + 3σ ≈ 0.088), naive daily peeking 0.170 — the
  protection is necessary and works. A planted +20% effect on qualified plays, 200 seeds, 5,000
  units: detected 68.5% of the time against a computed mSPRT power of 63.4% (Monte Carlo of the
  estimator's Gaussian path at the planned looks), inside the tolerance; the fixed-horizon power
  for the same design is 90.6%, which is the price of looking any time.

**Full run (simulator, events through the real lake path).** Two experiments registered before
the start, profiles as units, qualified plays as the primary metric, MDE 5%, daily looks:

| Experiment | Units (control / treatment) | SRM p | Control mean | Difference [95% CI] | Lift | Always-valid p | Decision |
|---|---|---|---|---|---|---|---|
| `recs-aa` (identical variants) | 48,873 / 48,109 | 0.014 (threshold 0.001) | 26.32 | −0.01 [−0.29, +0.27] | −0.0% | 1.0 | not significant |
| `recs-ranking` (planted +10% visits) | 48,502 / 48,480 | 0.94 | 25.23 | +2.18 [+1.90, +2.46] | +8.7% | 5e-50 | significant |

The planted effect multiplies visits by 1.10; qualified plays per member move by 8.7% because
churn and viewing time do not scale exactly with visits. At medium scale the same pair reads
A/A not significant (p 0.87) and +7.5% detected (p 1e-5); at smoke size (489 units) neither is
significant, as the computed power predicts for that sample. Collecting like the product left
the smoke results identical (units, metrics, sample-ratio checks); the count of units excluded
for missing analytics consent went from 20 to 19 in each experiment, because an account with no
consented purpose at all now stores no exposure (it is absent rather than excluded). The full
run's unit counts are expected to move the same way: slightly fewer exclusions, the same units.

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
  events, privacy exclusions, leakage guards, atomic publishing) and that, *under the
  simulator's assumptions*, the learned system ranks better than the milestone 1 engine by the
  measure that matters, with intervals that exclude no difference.
* They do not show real-world lift. The simulator's members were written by us; its utility
  model shares structure with both the engine (content features, popularity) and the learned
  models (latent factors). The relative ordering of systems is informative; the magnitudes are
  not transferable. Only the online experiment (rule engine vs learned, §7) measures lift.
* The logging policy is a stand-in for the engine, not the engine; the real engine is used for
  the baseline rankings, but members in the simulation reacted to the stand-in's pages.
* Popularity in the logging policy comes from the seed baseline, not from simulated plays (shards
  run in parallel), so there is no popularity feedback loop in the simulated data.

## 10. Limitations

* 119 titles make candidate generation nearly exhaustive and let ALS hold dense matrices; a
  catalogue of tens of thousands would need sparse ALS (e.g. the `implicit` library), an
  approximate-nearest-neighbour candidate stage and top-N storage instead of per-title loops.
* The ranker is pointwise; a pairwise or listwise objective was not compared (see §4).
* Static true utility: the oracle ignores novelty and fatigue, so freshness boosts in the
  re-ranker cost measured utility even where members, in the simulation, like new titles.
* Hyperparameters were set once on a validation week (ALS) or by design (re-ranking); there is no
  systematic search.
* The experiment analysis treats metrics that accumulate over the exposure window; its
  always-valid guarantee is verified empirically (A/A calibration) rather than proved for that
  estimand.
* Pickled scikit-learn models are verified by SHA-256 before loading but tie a run to the
  library version that wrote it.
* Erasure reads the whole lake three times (discover, rewrite, verify), reading only subject
  columns except where a key matches; daily that is about the cost of a dataset build at full
  size. Measured at smoke size only. Compacted hours are sorted by account with 1,000-row groups
  so the data export reads one or two groups per hour; at a much larger member base a per-account
  index would replace the scan.

## 11. From the simulator to real data

1. Done: the product's contracts adopted the event schema (`packages/contracts/src/events.ts`
   generates `services/recs/schemas/event.schema.json`), the reader is proven on objects the real
   writer produced (`tests/test_ingested_lake.py`, and the product's own test runs it on a lake
   the HTTP app wrote), the simulator stores only what that writer stores, compaction writes a
   format a small JavaScript reader decodes, erasure runs as an operation against the staff API,
   the events of members' data exports are extracted by a batch job (`export-events`: thirteen
   months of hourly partitions do not fit a Worker invocation), and experiment results land
   where the product imports them. Two facts of the product's writer the jobs account for:
   playback events and a few other kinds reach the lake from a database outbox on a scheduler
   tick (5 minutes by default, configurable: keep the jobs' 15-minute grace above it), and on
   Cloudflare every accepted client batch is its own object for now (many small objects per
   hour, which compaction folds into one file).
2. Start with replay metrics on search discoveries plus coverage and diversity guardrails as the
   offline gate (the evaluator does this when no truth is given), and keep an exploration slice
   (`context.policy.explore`) in production: without it position bias cannot be estimated.
3. Run the rule engine vs learned experiment (§7) before any default switch; keep the A/A
   running in the same layer to watch the assignment and logging.
4. Recalibrate the simulator against real aggregates (session rates, play rates by position,
   completion distributions) so that it stays useful for testing changes before they ship.
5. A gap the product's lake opens: restricted profiles emit nothing, so the pipeline cannot see
   a profile *become* restricted (a kids flag set, a ceiling lowered). The earlier rule dropped
   a profile whose latest state was restricted with its whole history; on the product's lake
   such a profile keeps its earlier, unrestricted history in training data and can still be
   scored (serving falls back to the rules for it, so nothing is shown). Closing it needs one
   signal from the product: a server event when a profile's standing changes, or the profile
   keys listed for exclusion the way erasure keys are.

## 12. Mode mapping

| | dev | k8s | cloudflare |
| --- | --- | --- | --- |
| Jobs | `make recs` on the developer machine, store = the dev filesystem store | CronJobs running the `webflix-recs` image: `compact` hourly, `erase`, `train-and-score`, `publish`, `analyse-experiments` daily (services/recs/README.md, "Jobs"), store = Garage through `WEBFLIX_S3_*` | the same image run outside Workers (a container or any scheduler) against R2's S3 API |
| Rule-engine baseline | Node script from the repository, in-process | `train-and-score --phase prepare`, the Node script in an image with the repository's packages, `--phase finish`, sharing an `emptyDir` | same |
| Erasure keys, experiment definitions | files, or the dev API with an access token | the staff API with a service account of the staff issuer (client credentials) | same |
| Artefacts read by | importer via the filesystem store | importer via S3 | importer via R2 binding |
| Members' exported events | the product's inline reader (raw and compacted hours) | `export-events`, the product folding its output into the export | same (`export-events` against R2) |

## 13. Public datasets

None was used. Every command runs on the simulator and the repository's catalogue only.
