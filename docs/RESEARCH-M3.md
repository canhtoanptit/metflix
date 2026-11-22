# Webflix — Research for milestone 3: what world class would take

Written 2026-11-22 as the main input to the milestone 3 plan. This is research and a
recommendation, not a blueprint: nothing in it is decided until the owner decides it (§6.6). Read
`docs/BLUEPRINT.md` and `docs/BLUEPRINT-M2.md` first.

**How to read the evidence.** External claims cite a source from §7, with one of three marks:

- **F**: the page was fetched and read on 2026-11-22.
- **S**: seen on 2026-11-22 only as a search-result summary; the page itself was not opened, or
  refused the fetch. Good enough to point at, not to quote.
- **M**: recalled from memory and not re-verified today. A lead, not a fact.

A sentence that starts "Inference:" is this report's reasoning, not a source's statement. What
Webflix has today was read from the code and documents in this repository on the same day, while
milestone 2 was being built by others; where code and documents differ, the code was trusted.

---

## 0. The answer

**Where Webflix stands.** The application layer is at a professional standard: a typed contract,
ports with contract suites that run in three runtimes, measured failure behaviour on Kubernetes,
billing proven against a real Stripe sandbox. That is not where the distance to Netflix, Apple TV
and Prime Video lies. The distance is in three places, listed in the order engineering can close
them:

1. **The stream** (engineering; mostly provable on one laptop plus about $5 a month). Webflix
   does not measure playback quality at all. Every video segment passes through application code
   in both modes. Media is unencrypted H.264 on a fixed bitrate ladder. The leaders run on
   measured quality of experience, serve bytes from caches that hold no application logic,
   protect every stream with DRM, and encode each title on its own ladder in several codecs.
2. **The screens** (engineering that needs toolchains, devices and store accounts). Webflix has
   one browser client, tested on Playwright's engines. The leaders are television products first:
   Prime Video alone ships to more than 8,000 device types [A1 F].
3. **The business** (money, licences and partners; no milestone closes it). The catalogue is 13
   freely licensed films reused across 119 titles. Netflix guides to about $20 billion of cash
   content spend in 2026 [N11 S]. DRM credentials, live rights, advertisers and tax registration
   all need a legal entity and counterparties.

**The next challenge is the stream**: make playback measured, protected, efficiently encoded, and
served by caches, and prove it on a real edge. It ranks first on both tests the owner set. A
member feels it as faster starts, fewer stalls and a sharper picture on a slow connection;
Netflix reports that its AV1 sessions use a third less bandwidth and have 45 % fewer buffering
interruptions than AVC and HEVC sessions [N5 F]. An engineer from one of those companies would
ask about measurement and the byte path before anything else, and today's answers are "none" and
"through the API". It also unblocks everything after it: every future client's player depends on
the packaging and DRM choices, and no rights holder licenses content to an unprotected service.

**Recommended milestone 3, "The stream".** Four workstreams on the pattern of milestone 2
(foundation, parallel build, adoption, verification): (1) quality-of-experience telemetry from
the player into the milestone 2 event lake, with playback metrics, targets and a synthetic viewer
fleet that plays under recorded network conditions; (2) protected, cache-served delivery:
encrypted CMAF media, a licence endpoint that carries the entitlement, stream-slot and plan
decisions, immutable content-addressed media that a CDN serves with no application code per
segment, proven locally with ClearKey and against real Widevine through a multi-DRM vendor trial;
(3) a per-title encoding ladder judged by VMAF, in H.264 and AV1, run as a job-driven container
pipeline and evaluated with milestone 2's experiment platform; (4) the first real Cloudflare
deployment, to turn the largest unverified claims (edge cache, cost per viewing hour, latency)
into measurements. Details in §6.2.

**Deliberately not yet**: native phone and TV apps, live events, an advertising tier, downloads,
multi-region operation, microservices or a federated graph, more recommendation work, and any
spending on content. Reasons in §5.3.

**Decisions only the owner can make** (§6.6): what Webflix is for (a product to launch or a
reference platform); a real Cloudflare account, domain and monthly budget; a DRM vendor trial and
when to start Apple's FairPlay approval; the client stack (recommended: React Native through Expo
for phones and TV boxes, the existing web player in a 10-foot shell for Samsung and LG); codec
policy; whether "both modes" may mean the control plane only from now on; the privacy basis for
playback telemetry; whether to invite real testers.

**The findings that most change the plan:**

- Nobody had listed playback-quality measurement. It is the first gap and the cheapest large one
  (§3.4, §4 row 1).
- DRM is not a feature to bolt on later. It is what lets the delivery architecture be right, and
  the way in has changed: Google's free Widevine Cloud License Service is reported to retire in
  April 2027, and Apple approves FairPlay credentials only for teams that already run a consumer
  streaming service (§3.3).
- Personalisation is not where the distance is. Netflix's own October 2026 estimate puts plain
  matrix factorisation 4 % below its production system in engagement, and random recommendations
  16 % below [N1c F]. Milestone 2's pipeline is already in the right class.
- A real Cloudflare deployment matters more than its place on the waiting list, and DRM matters
  more than its place; downloads and a hand-built ingest studio matter less (§5.2).

---

## 1. Terms

| Term | Meaning here |
| --- | --- |
| ABR, ladder | Adaptive bitrate streaming: the same video encoded at several bitrates and sizes (the ladder); the player switches between them as the network changes. |
| CMAF, HLS, DASH | CMAF is the fragmented-MP4 segment format both major streaming protocols can share. HLS (Apple) and DASH describe the segments to the player with playlists or manifests. Webflix uses HLS over CMAF. |
| CDN, edge cache | Servers near viewers that store and serve segments so the origin does not have to. |
| Control plane, data plane | Control plane: the services that decide (sign-in, entitlement, which file, which server). Data plane: whatever serves the video bytes. |
| DRM | Encrypted media whose keys are released by a licence server to a protected decoder. Three systems cover the market: Widevine (Google), PlayReady (Microsoft), FairPlay (Apple). ClearKey is the unprotected reference system every browser with Encrypted Media Extensions (EME) supports; it proves the flow, not the protection. |
| `cbcs` | The encryption scheme that lets one set of CMAF files serve all three DRM systems. |
| QoE | Quality of experience: what the viewer felt. The usual measures are start-up time, start failures, rebuffering ratio, and delivered picture quality. |
| VMAF | Netflix's open perceptual video quality score (0 to 100), used to compare encodes. |
| Per-title, per-shot encoding | Choosing the ladder for each title (or each shot) from quality measurements instead of one fixed ladder for everything. |
| CMCD | Common Media Client Data (CTA-5004): fields a player adds to segment requests so CDN logs can explain playback problems. |
| SSAI, SGAI, DAI | Server-side, server-guided and dynamic ad insertion: ways to put advertisements into a stream. |
| OCA | Open Connect Appliance: a Netflix cache server, often inside an internet provider's network. |
| Merchant of record | A company that sells on your behalf and takes on tax collection and remittance. |

---

## 2. The architecture as it is

Read from the code on 2026-11-22. Milestone 1 is complete; milestone 2's member-facing areas are
committed and in flux.

```
 browser: apps/web (React SPA) with @webflix/player on hls.js        the only client
   │ one origin:  /api/v1   /media/{token}/vod/…   /cdn/…   POST /api/v1/events
   ▼
 ┌────────────── control plane and data plane are the same process ────────────────────────────┐
 │ packages/http  createApp(): route table, auth, CSRF header, rate limits, media routes       │
 │ packages/core  services by area: identity, billing, streaming, personalisation, events,     │
 │                experiments, admin; every external system behind a port                      │
 │ packages/db    one Kysely repository layer for SQLite, PostgreSQL and D1                    │
 └──────────────┬──────────────────────────┬───────────────────────────┬──────────────────────┘
                dev: one Node process      k8s: Helm chart on kind      cloudflare: one Worker,
                                                                        local workerd only
 database       SQLite file                PostgreSQL, one instance     D1, one primary, no replicas
 cache          memory                     Valkey                       Workers KV
 limits, slots  memory                     Valkey (Lua scripts)         Durable Objects
 jobs           in process                 Valkey Streams + worker      Queues + Cron Trigger
 blobs, media   filesystem                 Garage (S3 API); the API     R2 behind the Workers edge
                                           pods stream every segment;   cache; two Worker requests
                                           no CDN                       per segment
 payments       fake provider              fake, or Stripe sandbox      fake, or Stripe sandbox
 sign-in        development issuer         development issuer           development issuer

 offline, on the laptop
   tools/media    13 open films → ffmpeg in Docker → fixed H.264 ladder + AAC stereo, CMAF HLS,
                  4 s segments, WebVTT, trick-play sheets, preview clips → blob store. No encryption.
   services/recs  event lake (events/dt=…/hh=…/*.ndjson.gz in the blob store) → Parquet →
                  co-watch similarity + matrix factorisation + gradient-boosted ranker →
                  recs/v=…/ artefacts → importer → RecommendationStore → engine.ts, which keeps
                  every rule and falls back to the milestone 1 engine
```

**Request path.** Same origin for the app, the API and media, so no CORS and an httpOnly session
cookie. `POST /playback/sessions` checks entitlement and maturity, takes a stream slot
(`StreamGate`), and returns a manifest URL with an HMAC token in its path. Playlist requests
re-check the slot; segment requests verify only the token (docs/DECISIONS.md D1). Heartbeats every
30 s renew the slot and record progress.

**Media.** Packaged once, offline. One codec (H.264), a fixed ladder per profile
(`tools/media/src/profiles.ts`: up to five rungs, 1080p at most 5.5 Mbit/s), one stereo AAC
track, side-car WebVTT. Blob keys are rewritten in place on re-packaging, which is why the
Cloudflare mode carries a "media generation" in its cache keys (docs/CLOUDFLARE.md §3). A revoked
viewer can keep fetching segments until the token expires, 6 hours by default (D1, accepted
because there is no DRM).

**Events and recommendations.** 22 typed event types (`packages/contracts/src/events.ts`):
browsing, search, list and rating changes, sign-up steps, four server-side playback events
(start, progress by quarter, complete, abandon), billing, sign-in, experiment exposure, consent.
**None describes playback quality**: no start-up time, rebuffering, bitrate or dropped frames.
The player has that data (its Shift+D overlay shows rendition, buffer and dropped frames) and
reports none of it. `client.error` carries a code and a fatal flag only.

**What is real and what is a stand-in.**

| Thing | Status |
| --- | --- |
| Services, repositories, port contract suites | Real; the same code runs on Node, PostgreSQL, and D1 in workerd |
| PostgreSQL, Valkey, Garage, Envoy Gateway on kind | Real software, single instances, one laptop; failure injection measured (docs/KUBERNETES.md §3) |
| D1, KV, R2, Durable Objects, Queues | Local emulation. The production deploy has only been rehearsed dry; the Workers edge cache has never run (docs/CLOUDFLARE.md §8) |
| Stripe | A real sandbox, proven (11 scenarios, 323 webhook deliveries); tax and wallets unverified (docs/STRIPE.md) |
| Google and Apple sign-in, email, staff issuer | Stand-ins: a development OpenID issuer with a fault catalogue, a local mailbox. No real client is configured |
| Members and their behaviour | Simulated: 39.6 million events from 135,679 simulated profiles. Nothing in the repository shows a real member |
| Content | 13 open films; fictional titles play borrowed footage |
| Scale | The largest load recorded is 1,500 requests a second from 16 clients on the laptop |
| Observability | JSON logs with request ids, Prometheus metrics on Node. No tracing, no service-level objectives, no dashboards, no alerting |
| DRM, native apps, live, ads, a second region | Absent |
| Milestone 2 still open, as read | The staff API has only `GET /me` (31 handlers answer 501); `apps/admin` does not exist; the chart has no Keycloak, mailbox or recommendation CronJobs; `apps/web` does not yet use the new checkout, federated sign-in or the telemetry SDK |

**Limits already written down that matter at larger scale**: the catalogue snapshot is one value
that stops fitting the shared cache near 270 titles (docs/RECOMMENDATIONS.md); D1 runs one
primary with read replication deliberately off; heartbeats are the steady write load, about 100
D1 queries a second per 1,000 concurrent viewers (docs/CLOUDFLARE.md §5).

---

## 3. How the leaders are built

The three publish very unequally. Netflix documents its systems in detail. Amazon publishes
selectively through Amazon Science, AWS case studies and conference talks. Apple publishes
standards and developer documentation and almost nothing about its service architecture; where
this section is thin on Apple, that is why.

### 3.1 Delivery and CDN

- **Netflix** runs its own CDN, Open Connect. Its site says embedded appliances sit with "over a
  thousand ISPs", are given to qualifying providers at no charge, and have the same capabilities
  as the appliances in Netflix's "60+ global data centers"; providers steer traffic to them with
  BGP, and appliances are filled nightly [N3 F]. Appliances serve all of Netflix's video traffic
  [N12 S]. The control plane (sign-in, browse, playback decisions) runs on AWS and decides which
  appliance a client uses [N12 S]. For live, Netflix connects its top-tier appliances directly to
  the origin instead of using origin shields, and extended nginx on the appliances with
  millisecond cache control [N2 F]. Secondary coverage gives 18,000+ servers in 6,000+ locations
  [N12 S].
- **Prime Video** builds on AWS: CloudFront for delivery and AWS Elemental for live encoding and
  packaging, across several AWS regions [A4 S]. A network-analysis article says Amazon offers
  internet providers embedded CloudFront caches and runs Sye, a synchronised low-latency live
  protocol it bought from Net Insight in 2020, on CloudFront edges; the article relays this
  second-hand [A3 F]. Whether Prime Video also uses third-party CDNs could not be verified.
- **Apple** has made no statement that could be found. Old trade reporting describes Apple
  building its own CDN from 2014, and third-party fingerprinting shows Apple TV hostnames on
  Akamai and Fastly addresses [P4 S]. Low confidence.
- Inference: what the three share is the separation. Bytes come from caches with no application
  logic; the application only decides who may play what and from where. Netflix owns the caches
  because at its scale delivery cost and quality justify it; Amazon rents its own cloud's; Apple
  mixes. Webflix has no separation: the API process (Kubernetes) or a Worker invocation
  (Cloudflare) handles every segment.

### 3.2 Encoding and packaging

- **Netflix** introduced per-title encoding in 2015 and per-shot optimisation (the Dynamic
  Optimizer) in 2018, both judged by VMAF [N16 S, original posts M]. In December 2025 it said AV1
  carries about 30 % of viewing and would soon be its top codec; AV1 sessions score 4.3 VMAF
  points above AVC and 0.9 above HEVC with a third less bandwidth; 88 % of large-screen devices
  submitted for certification from 2021 to 2025 support AV1; HDR is delivered as AV1 with HDR10+;
  film grain is removed before encoding and synthesised in the decoder [N5 F]. It is evaluating
  AV1 for live [N5 F].
- **AV2**, AV1's successor, has a final 1.0 specification (AOMedia press release dated
  2026-06-09) and no consumer decoding hardware that could be found [X5 S]. Not relevant to
  Webflix for years.
- **Apple** publishes the HLS Authoring Specification: fragmented MP4, HEVC for HDR as HDR10, HLG
  or Dolby Vision profile 5 [P2 S]. A vendor article says Apple devices play AV1 only where they
  have hardware decoding [P2 S].
- **Prime Video**: no current primary source found on codecs or ladders.
- Inference: the leaders treat encoding as a measured optimisation problem with quality as the
  objective, and keep H.264 for reach while moving volume to newer codecs. Webflix's fixed H.264
  ladder is where they were before 2015.

### 3.3 DRM and device security

- All three protect every stream with the DRM system native to each device: FairPlay on Apple
  devices, Widevine on Android, Chrome and many televisions, PlayReady on Windows, Xbox and many
  televisions [M]. One `cbcs`-encrypted CMAF encode can serve all three [X6 S].
- Studios set the bar through MovieLabs' Enhanced Content Protection specification (v1.3, 2020):
  a hardware root of trust for the highest-value content and the ability to watermark streams
  forensically; each studio decides what it requires [X4 S].
- **FairPlay**: Apple's page lists Server SDK 27 and says production credentials need approval,
  requested by the Apple Developer Program account holder: "Your request will be approved only if
  your team provides a streaming service to consumers" [P1 F].
- **Widevine**: access needs a corporate email address and a signed Widevine Master License
  Agreement [X1 F]. Google's free hosted licence service (the Cloud License Service) is reported
  to retire on 2027-04-13; the sources are DRM vendors and one sponsored article, and no Google
  notice was found [X2 F/S]. The stated alternatives are Google's License Server SDK or a
  certified multi-DRM provider.
- **Multi-DRM vendors** sell licence issuance for all three systems as a service. Search
  summaries show Axinom with a 60-day evaluation and an entry tier of about $259 a month charged
  only in months of use, and castLabs DRMtoday with 1,000 free test licence requests through AWS
  Marketplace [X3 S]. Prices are unverified.
- Netflix additionally certifies devices before they may run its app [N5 F mentions the
  programme].
- Inference: for Webflix the practical route is a multi-DRM vendor, not direct agreements; do not
  build on Google's hosted service; expect FairPlay to stay closed until Webflix is a real
  consumer service.

### 3.4 Playback quality and how it is measured

- Netflix reports encoding results as viewer outcomes: VMAF, bandwidth, buffering interruptions
  [N5 F]. Its operational health signal is stream starts per second per region [N6 F]. Its
  published experimentation statistics use play delay as a worked example [N10 S]. Live writes
  have explicit budgets: a failed segment write within 500 ms "is considered a bug" [N2 F].
- The vocabulary is standardised: CTA-2066 defines player events and metrics such as video
  start-up time, exits before video start, start failures, rebuffering ratio and playback
  failures [X6 S]. CMCD (CTA-5004) carries player state on segment requests; version 2 adds an
  event mode, dash.js announced support in a 5.2.0 release candidate, and hls.js is reported to
  implement version 1 with version 2 requested [X6 S].
- Prime Video and Apple: no primary source found today on their measurement.
- Inference: this is the widest gap relative to its cost. Webflix has an event lake, an
  experiment platform and a player that already knows its own state; the three are not connected
  for playback quality.

### 3.5 Clients and the device ecosystem

- **Prime Video** ships one living-room app to more than 8,000 device types: a thin native C++
  engine stays on the device, and the application is downloaded at launch and can update "as
  often as every few hours" [A1 F]. It moved the low-level systems from JavaScript to Rust
  compiled to WebAssembly (frame time on a mid-range television from 28 ms to 18 ms) [A1 F], and
  later rebuilt the interface on a Rust UI kit using an entity-component system [A2 F/S].
- **Netflix** runs its television interface as JavaScript on its own rendering engine; this
  comes from community sources, not an official post [N14 S]. It shipped a rebuilt television
  experience in 2025 [N14 S]. In November 2026 it described AI Discover, a television tab for
  theme-based discovery built on a plan-validate-execute harness where rules are enforced in
  code, not in prompts, and there is no free-text input [N1a F]. Its mobile app has a vertical
  video feed, Clips [N1e F].
- **Apple** builds native apps for its own platforms; no architecture source found.
- **What vendors recommend to teams that are not Netflix**: Amazon's developer blog (2026-05-21)
  describes one monorepo with a shared package, a Vega OS package (Fire TV's React Native
  platform) and an Expo TV package for Android TV, Apple TV and web, and estimates 70 to 85 % of
  the code can be shared; media playback and DRM stay per platform [A6 F]. Expo's guide says TV
  support uses the `react-native-tvos` fork (0.85 for SDK 56) and that Apple TV builds need Xcode
  16 or later on macOS [X10 F]. Samsung televisions run web applications; Samsung ships a
  simulator and a macOS toolchain (February 2026) and says final testing needs the emulator or a
  television [X11 S]. LG was not checked.
- Inference: the leaders' client stacks are custom because they have hundreds of client
  engineers and must run on very weak hardware. None is a model Webflix can copy. The transferable
  ideas are a thin native shell with an updatable application layer, and server-described
  screens, which Webflix's row contract already does.

### 3.6 Service architecture and the API layer

- **Netflix**: hundreds of services owned by separate teams behind a federated GraphQL layer; it
  moved its mobile apps from its earlier Falcor API to GraphQL in 2022 [N8 S]. Workloads run on
  its Titus container platform [N1f F]. State sits behind shared abstractions: the Live Origin
  uses a key-value abstraction over Cassandra with a write-through EVCache [N2 F].
- **Prime Video**: one of its teams wrote in 2023 that moving a monitoring service from
  serverless functions to a single process cut its cost by 90 % [A7 M].
- **Apple**: not public.
- Inference: service count follows team count. A federated graph exists so that hundreds of
  teams can ship independently. Webflix has one owner and AI agents; its modular monolith with
  ports is the right architecture, and splitting it would add operating cost with no benefit.

### 3.7 Data, experimentation and personalisation

- Netflix defines experiment metrics once in a semantic layer (DataJunction); before it, metric
  authoring for the experimentation platform "would take weeks" [N1d F]. It publishes
  anytime-valid sequential methods so tests can be watched continuously [N10 S].
- Its personalisation now centres on a foundation model: a transformer trained by next-event
  prediction, pre-trained monthly and fine-tuned daily, consumed by product teams as embeddings,
  as a subgraph inside their own models, or by fine-tuning [N1b F].
- Its own counterfactual estimate, validated against randomised experiments (correlation 0.86):
  relative to the production system, random recommendations lose 16 % of engagement,
  popularity-based 12 %, matrix factorisation 4 % [N1c F].
- Prime Video and Apple: nothing comparable found today.
- Inference: milestone 2 (matrix factorisation, a learned ranker, deterministic assignment,
  exposure logging, a sequential guard) is the right class of system. The remaining distance is
  real data and scale, which engineering on a laptop cannot supply.

### 3.8 Resilience and multi-region

- Netflix ran on three AWS regions in 2018 and could move all traffic out of one in seven
  minutes by injecting pre-warmed shadow capacity and switching DNS; before that work it took
  about 45 minutes [N6 F]. Current region count was not verified.
- It sheds load by priority, first at the gateway and since 2024 inside services, so playback
  survives when browsing is degraded [N7 S].
- For live it runs redundant regional pipelines and lets the origin pick a good segment from
  either [N2 F].
- Prime Video's Thursday Night Football platform is described as multi-region with in-region
  redundancy [A4 S].
- Inference: Webflix's single-cluster failure behaviour is carefully measured and better than
  most spikes. Multi-region is absent, and cannot be proven honestly on one laptop.

### 3.9 Live events

- Netflix: 2-second segments, two redundant encoding pipelines, an origin on EC2 between the
  pipelines and Open Connect that serves the first valid candidate, priority for the live edge
  over rewind traffic, and a recorded peak of 65 million concurrent streams [N2 F].
- Prime Video: AWS Elemental and CloudFront [A4 S], Sye for synchronisation [A3 F]; Amazon
  reports 122 million unique US viewers across the 2025-26 Thursday Night Football season
  [A5 S].
- Apple: live sport (MLS, and Formula 1 in the US from 2026) inside the base subscription
  [P3 S]; technology not documented.
- Media over QUIC, the proposed successor transport for low-latency live, is still an IETF
  draft (draft-20, 2026-08-31) [X7 S].
- Inference: live is where the three compete hardest in 2026. It is an engineering system on
  top of a solved on-demand one, and worthless without rights.

### 3.10 Advertising

- Netflix built its own ad platform and runs it in all 12 ad countries, reaches "more than 190M
  Monthly Active Viewers", sells through five programmatic partners, and began dynamic ad
  insertion in live events in late 2025 [N4 F]. In October 2026 it cut its 2026 advertising
  revenue forecast from about $3 billion to $2.7 billion and scheduled 15 more ad countries for
  2027 [N11 S].
- Prime Video shows ads by default [M] and reports ad-supported reach above 315 million
  worldwide (Amazon's figure through a third-party summary) [A5 S].
- Apple: no advertising tier was found; not verified.
- Inference: an ad tier is a business line with its own platform. It depends on manifest control
  and measurement, which the recommended milestone builds anyway.

### 3.11 Payments, tax and app stores

- A Netflix principal engineer presented the evolution of its billing and payment systems at
  QCon London 2026; the write-up could not be opened [N9 S].
- App stores: Google says that since 2026-06-30 in the US, UK and EEA its billing fee (5 %)
  applies only to purchases through Play billing, with alternative billing and external links
  allowed and a service fee from 10 % [X13 S]. Apple's August 2026 EU terms set 26 % for in-app
  purchase, 20 % for alternative processing and 15 % for links out [P5 S]. In the US the fee on
  external links is in litigation and its current state could not be confirmed [P5 S].
- Stripe now offers a merchant-of-record product (Managed Payments) to all digital businesses,
  covering indirect tax in more than 80 countries for an added 3.5 % per transaction; migrating
  existing subscriptions is still on its roadmap [X12 S].
- Inference: Webflix's Stripe integration is sound. What is missing is not code: a legal entity,
  tax registration or a merchant of record, and a store-billing position once apps exist.

### 3.12 Content supply chain and cost

- Netflix takes deliveries as IMF packages with separate timed text (TTML, IMSC 1.1) and audio
  description to published specifications [N13 S].
- Money: Netflix guides to $51.1 billion revenue and about $20 billion cash content spend for
  2026 [N11 S]. Apple's service was reported in 2025 to lose over $1 billion a year with about 45
  million subscribers [P3 S]. Netflix withdrew its bid for Warner Bros. Discovery in 2026 after a
  higher Paramount Skydance offer [N15 S].
- Cloudflare's terms (updated 2026-09-28) say that, unless you are an Enterprise customer, you
  must use specific paid services "(e.g., the Developer Platform, Images, and Stream)" to serve
  video and other large files through its CDN [X8 F]. Workers with R2 are Developer Platform
  services; the page does not name R2. Cloudflare Containers became generally available on
  2026-04-13 [X9 S], and its managed data platform (pipelines, an Iceberg catalogue on R2, SQL
  over it) now bills [X9 S].
- Inference: content is the cost that defines the category, and delivery is the second.
  Webflix's own estimate of about $0.002 per viewing hour on Cloudflare (docs/CLOUDFLARE.md §5)
  is dominated by two billed Worker requests per segment, and has never been measured on a real
  account.

### 3.13 Where the three differ, and why

| | Netflix | Prime Video | Apple TV |
| --- | --- | --- | --- |
| Business | Subscriptions and ads are the whole company | One benefit of Prime, a storefront for channels and rentals, an ad and sports business | A showcase for Apple's devices and services |
| Delivery | Owns its CDN inside provider networks | Rents its own cloud's CDN and media services | Mix of own and third-party (unverified) |
| Clients | Own TV runtime, device certification | One downloadable app over a native engine on 8,000+ device types | Native on its own platforms |
| Formats | Codec research in the open: VMAF, AV1, film grain synthesis | AWS Elemental | Sets the standards: HLS, FairPlay, HEVC with Dolby Vision |
| Openness | Publishes architecture | Publishes selectively | Publishes specifications only |

Inference: Netflix optimises cost per stream and engagement because streaming is its only
business. Amazon reuses AWS and optimises reach across hardware it does not control. Apple
optimises quality on hardware it does control. Webflix resembles none of them in resources; what
it can share with all three is the shape: a small control plane, bytes from caches, measured
quality, protected media.

---

## 4. The gap, capability by capability

Distance is judged against the leaders, not against other spikes. "One laptop?" asks whether the
capability can be built and proven here, as milestone 1 and 2 were.

| # | Capability | Webflix today | World class | Distance | Depends on | One laptop? | Kind |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Playback-quality measurement | None. No start-up, rebuffering, bitrate or failure events | Every session reports; QoE judges every encoding, player and delivery change | Large, cheap to close | The event lake and experiments from milestone 2 | Yes, with synthetic viewers; real networks need a deployment | Engineering |
| 2 | Delivery | Application code in the byte path in both modes; per-session URLs; the edge cache never ran for real | Caches serve bytes; the control plane authorises and steers | Large | Row 3 frees the URL; a real account | Design and local proof yes; cache behaviour and cost no | Engineering, small money |
| 3 | Content protection | Signed URL tokens over clear media; a 6-hour revocation gap | Three DRM systems, hardware-backed for high resolutions, licence policy per plan | Large | A DRM vendor; Apple and Google approvals | The architecture yes (ClearKey); real DRM needs accounts | Engineering, then partners |
| 4 | Encoding | H.264 only, fixed ladder, stereo AAC, SDR | Per-title or per-shot ladders by VMAF; AVC, HEVC and AV1; HDR; surround | Large in efficiency, medium in what a member sees at this scale | Row 1 to judge it; CPU hours | Yes; HDR and surround need sources and licences | Engineering |
| 5 | Devices | One web app; Playwright engines only; no real Safari, phone or television | Television first, phones, consoles; thousands of device types | Very large | Rows 2 to 4 fix the player contract; Xcode, Android SDK, devices, store accounts | A television web app yes; native apps not on this machine today | Engineering, toolchain, accounts |
| 6 | Web player | Strong: full controls, accessibility, recovery, plan cap | The same plus DRM, measured adaptation, several audio tracks | Small to medium | Rows 1 and 3 | Yes | Engineering |
| 7 | Real deployment, scale, observability | Local only; no tracing, objectives or alerting | Global production with objectives, tracing, load tests, canaries | Large | An account, a domain, a budget | No | Engineering, small money |
| 8 | Resilience and regions | One region, single-instance stores, well-measured single-cluster failures | Active-active regions, evacuation in minutes, prioritised load shedding | Large | Row 7; real infrastructure | No (two local clusters would be theatre) | Engineering, money |
| 9 | Service architecture and API | Modular monolith, typed REST contract, server-described rows | Hundreds of services behind a federated graph | Not a gap at this team size | — | — | Organisation |
| 10 | Data and experimentation | Lake, batch Parquet, deterministic assignment, guarded analysis; never run on real members | Stream and batch on table formats, thousands of concurrent tests, a metric layer | Medium | Real traffic | Mechanics yes; validity needs members | Engineering, users |
| 11 | Personalisation | Rules, co-watch, matrix factorisation, learned ranker, batch | Foundation models, near-real-time signals, guided discovery | Medium | Real behaviour data | Technically yes; meaningless without data | Engineering, users |
| 12 | Search and catalogue scale | Full-text search in the application database; snapshot design fits about 270 titles in the shared cache | Thousands of titles per country, multilingual search, rights per territory | Medium | A real catalogue | Yes | Engineering |
| 13 | Supply chain, localisation, accessibility | A CLI on a laptop; English only; one audio track; no audio description | Standard mezzanine ingest, automated checks, dozens of subtitle and dub languages | Large | Content; the row 4 pipeline | Pipeline and interface translation yes; real assets no | Engineering, content |
| 14 | Live | None | Redundant pipelines, 2-second segments, tens of millions concurrent | Very large | Rows 1 and 2; rights | A miniature yes | Engineering; pointless without rights |
| 15 | Advertising | None | Own ad server, dynamic insertion, measurement partners | Very large | Rows 1 and 2; advertisers | A stand-in yes | Engineering, business |
| 16 | Payments, tax, stores | Stripe proven in a sandbox; tax unverified; web only | Many methods and processors, tax everywhere, store billing where required | Medium | A legal entity; apps | Mostly no | Business, engineering |
| 17 | Downloads | None | Offline playback with persistent licences on phones | Medium | Rows 3 and 5 | No | Engineering, after apps |
| 18 | Content | 13 freely licensed films as 119 titles | Tens of billions of dollars a year of programming | Not closable by engineering | Money, rights, row 3 | No | Business |
| 19 | Operating it | One owner and AI agents; no on-call, support desk or abuse handling beyond the staff API | Round-the-clock operations, support, trust and safety, compliance per country | Large | Deciding to launch | No | Organisation |

Bluntly: rows 1 to 4 and 6 are engineering that this project's method can close. Rows 5, 7 and 8
are engineering that needs things this laptop does not have. Rows 14 to 16 are engineering whose
value depends on business that does not exist yet. Rows 18 and 19 are not engineering. Row 9 is
not a gap.

---

## 5. The next challenge

### 5.1 Candidates, ranked

| Rank | Candidate | A member would notice | Credible to a streaming engineer | Provable now | Unblocks |
| --- | --- | --- | --- | --- | --- |
| 1 | **The stream**: measure QoE; encrypt and licence-gate media; serve it from caches; per-title ladder with AV1; deploy for real | Faster starts, fewer stalls, better picture per bit; felt more than seen | Highest: answers the first questions they would ask | Mostly; the real edge for about $5 a month | Every client, any licensed content, ads, live |
| 2 | **The screens**: a television web app, then phone and TV-box apps | Highest: it is the first thing missing | Medium; client breadth is expected, not admired | Partly: toolchains and devices are missing | Downloads, store billing, real audiences |
| 3 | Studio, localisation, accessibility | Medium, large outside English | Medium | Yes for the pipeline and the interface | Operating a real catalogue |
| 4 | Scale and a second region | Nothing until something fails | High | No | A real launch |
| 5 | Live events | Nothing without rights | High | A miniature | A sports or events strategy |
| 6 | Advertising tier | A cheaper plan, only after launch | Medium to high | A stand-in | A revenue line |
| 7 | More personalisation, guided discovery | Medium | Low: no data to learn from | Technically | Little |
| 8 | Downloads | Medium | Low | No | Little |
| — | Content licensing | Everything | Not engineering | No | Being a service at all |

### 5.2 The one or two that matter most

**First, the stream.** Three reasons beyond its rank.

- It is a dependency, not a preference. Each client platform plays through its own player
  (AVPlayer with FairPlay, Android's player with Widevine, browser EME on televisions), and what
  those players need is fixed by the packaging, encryption and capability decisions in this
  milestone. Building clients first means rebuilding their playback later.
- It turns milestone 2 into something with a purpose. The experiment platform and the lake exist
  but have no real members; playback quality gives them a question that synthetic viewers under
  recorded network conditions can answer honestly: does the new ladder start faster and stall
  less than the old one?
- It removes a design debt the documents already admit: the 6-hour revocation gap (D1), two
  Worker requests per segment, the media-generation mechanism, and media streamed through API
  pods.

**Second, the screens**, as the milestone after. On the member's test it would rank first; it is
second because it depends on the stream and because this machine cannot build native apps yet.

**Testing the waiting list.** Matters more than its position suggested: DRM (it is half of the
delivery architecture and the gate to any licensed content) and the real Cloudflare deployment
(the cheapest way to replace the largest "not verified" with a measurement). About as listed:
per-title encoding, as long as it arrives with the measurement that judges it; television and
phone apps. Matters less for now: downloads (after apps and DRM, and a phone-only benefit); the
ingest studio as a console (the pipeline half belongs in milestone 3, the screens for it can
wait for a catalogue worth managing). Content licensing stays what it was: decisive and outside
engineering. Not on the list and now on it: QoE measurement, the control and data plane split,
tracing and objectives, localisation and accessibility, a tax and merchant-of-record position.

### 5.3 What not to do yet, and why

- **Native phone and TV apps.** Blocked by toolchain today and dependent on this milestone's
  packaging and DRM decisions. Decide the stack now (§6.6), build after.
- **Live.** The most impressive system on the list and the least useful without rights. It
  reuses the delivery and measurement built here.
- **An advertising tier.** Needs manifest control and measurement first, and advertisers to be
  worth more than a demonstration.
- **Multi-region, real Kubernetes in a cloud.** Needs money and operators. Cloudflare gives a
  global control plane for the real deployment; Kubernetes stays on kind as the portability
  proof.
- **Microservices or a federated graph.** Solves a problem of hundreds of teams (§3.6).
- **More recommendation models or LLM discovery.** By Netflix's own numbers the remaining gain
  over matrix factorisation is a few percent, and Webflix has no real behaviour to learn from.
- **Downloads.** After apps.
- **Spending on content or on store accounts.** Nothing in milestone 3 needs it.

---

## 6. Proposal

### 6.1 Target architecture

```
 clients        web · later: 10-foot web shell (Samsung, LG) · React Native phone and TV-box apps
                each one: platform player + QoE reporting + a capability report
   │
   │ CONTROL PLANE: portable, as today (Node on Kubernetes, one Worker on Cloudflare)
   ├─ /api/v1            identity, billing, browse, recommendations, experiments      unchanged
   ├─ playback session   entitlement + stream slot + device capabilities
   │                     → the manifest for this device: codecs it decodes, its DRM system, its plan
   ├─ licence            releases content keys: checks session, slot and plan; short-lived, renewed
   │                     KeyProvider port: ClearKey server (local, portable)
   │                                       or a multi-DRM vendor (Widevine, PlayReady, FairPlay)
   ├─ playlists          still served and gated by the control plane (few requests per playback)
   └─ events             behaviour and QoE → queue → lake
   │
   │ DATA PLANE: one delivery contract, one implementation per mode, no application code per segment
   └─ media host         immutable, content-addressed, encrypted CMAF segments
                         cloudflare: R2 behind the CDN cache
                         k8s: the object store behind a caching tier (a CDN in production)

 MEDIA PIPELINE: containers (Kubernetes Jobs, Cloudflare Containers, or the laptop)
   source → probe and checks → per-title analysis (VMAF) → encode H.264 + AV1 → package CMAF
   → encrypt (cbcs, one key per quality tier) → validate → publish (a pointer flip)

 DATA: the lake in the object store; batch jobs in containers, as in milestone 2
   events + QoE → Parquet → playback metrics, experiment analysis, a playback-health page, alerts
```

**What changes from today.**

| Area | Today | Target | Portable across both modes? |
| --- | --- | --- | --- |
| Who authorises a segment | An HMAC token in the URL, checked by application code on every request | The licence request; segments are encrypted and need no token | Licence issuance yes; real DRM is a vendor service |
| Media keys in the store | Rewritten in place; a "media generation" protects the cache | Content-addressed and immutable; publishing flips a pointer; the generation mechanism goes | Yes |
| Who serves bytes | API pods on Kubernetes; two Worker requests per segment on Cloudflare | A cache in front of the object store | No, by design: one contract, two implementations |
| Plan quality cap | A token claim and a refusal per rendition (D26) | One key per quality tier; the licence carries only the tiers the plan pays for | Yes |
| Revoking a stream | Next playlist or heartbeat; segments flow up to 6 hours (D1) | The next licence renewal, minutes, with real DRM; unchanged under ClearKey | Yes |
| Playback session | Title and episode in, one manifest out | Adds what the device can decode and protect | Yes |
| Encoding | Fixed H.264 ladder | Per-title ladder from a quality analysis; H.264 for reach, AV1 for efficiency | No: needs containers |
| Media pipeline | A CLI run by hand | The same stages as jobs with recorded state, which is the back half of the ingest studio | Runs wherever a container runs |
| Quality measurement | None | QoE events from every player, metrics and targets | Ingestion yes; analysis is a batch job |
| Observability | Logs; Prometheus on Node | Adds traces through the control plane and playback objectives | Emitting yes; backends differ |
| Deployment | Local in every mode | Cloudflare for real; Kubernetes stays on kind | — |

**What stays portable.** Everything a member's request touches in the control plane, including
the licence decision (the ClearKey server is Web Crypto; a vendor is an HTTP call), per-device
manifests and event ingestion. Principle 1 of milestone 2 holds unchanged.

**What stops being portable, and why.**

1. The media pipeline needs encoder binaries and CPU hours; a Worker can run neither. It already
   lived outside the request path; it becomes a container workload like milestone 2's Python
   jobs.
2. The data plane is infrastructure, not application code. Trying to keep it "the same code in
   both modes" is what put application code in the byte path. The portable thing becomes the
   delivery contract (key layout, cache headers, range behaviour, cross-origin rules), checked by
   a conformance suite pointed at a URL, as `tools/smoke` does for the API.
3. Real DRM is a third party's service in both modes. The local stand-in is ClearKey.

The rule "a feature is done only when it works in both required modes" should be restated for
milestone 3: the control plane and its contract in both modes; each data plane passing the same
delivery checks; the pipeline producing the same output wherever its container runs.

Inference on cost: after the change a viewing hour should cost the Worker roughly the heartbeats,
playlists and licence calls (a few hundred requests) instead of about 3,700, with segments served
by the cache straight from R2. This is arithmetic on docs/CLOUDFLARE.md §5, not a measurement;
the real deployment measures it.

### 6.2 Recommended milestone 3: "The stream"

Precondition: milestone 2 is closed, including the web adoption and the staff API. Milestone 3
builds on its lake, experiments and admin surface.

| Workstream | In scope | Done means |
| --- | --- | --- |
| **A. Quality of experience** | QoE event types in the contract using CTA-2066 vocabulary (play attempt, time to first frame, exit before start, rebuffer start and end, rendition switch, fatal and recovered errors, dropped frames); the player reports them through the telemetry SDK; CMCD on segment requests; batch metrics (start-up time p50 and p95, start failure rate, rebuffering ratio, average delivered quality) per mode, browser, ladder and experiment variant; a playback-health page in the admin console; a synthetic viewer fleet: headless players under recorded network profiles, the playback counterpart of milestone 2's behaviour simulator | Every playback in both modes produces the events; the metrics job reproduces a known injected degradation (a throttled network raises rebuffering by the expected amount); an A/A comparison is flat |
| **B. Protected, cache-served delivery** | `cbcs` encryption in packaging; a `KeyProvider` port with a portable ClearKey implementation and a vendor adapter; a licence route that applies entitlement, stream slot and plan tier; one key per quality tier; content-addressed immutable media layout and pointer-flip publishing; a media host with no application code per segment in each mode; the delivery conformance checks; capability-aware playback sessions | No clear media in the bucket; playback without a licence fails; a Basic plan cannot obtain a higher tier's key; the Cloudflare budget test shows zero Worker invocations per segment; API pods serve no segment bytes; the vendor lane plays Widevine in Chrome at least once per mode, or reports skipped with the reason, as the Stripe lane does |
| **C. Encoding ladder** | Per-title analysis with VMAF over sampled scenes; ladders in H.264 and AV1; the pipeline as jobs with recorded state and automated checks; ladder metadata in the manifest | For the 13 source films: measured bitrate saving of the per-title ladder against the fixed one at equal VMAF, and of AV1 against H.264; an experiment through milestone 2's platform, run by the synthetic fleet, shows the new ladder is no worse on start-up and rebuffering and better on delivered quality |
| **D. A real edge** | The first real Cloudflare deployment on a custom domain: provisioning, remote migrations, secrets, the media host, budget alerts; traces and playback objectives; QoE from real browsers and at least one real phone and television browser on real networks | The deploy runbook of docs/CLOUDFLARE.md §8 has run for real; edge cache hit ratio and cost per viewing hour are measured, not estimated; the conformance and browser suites pass against the public origin |

Sequence, as in docs/BLUEPRINT-M2.md §11: a foundation step (contracts for QoE events, playback
capabilities and the licence route; the `KeyProvider` port with its memory implementation and
contract suite; the media manifest's new shape), then A to D in parallel, then adoption in the
web player, then verification with independent reviews of the protection design and of the
measurement's correctness.

What it needs from the owner: a Cloudflare account on Workers Paid and a domain (D); a decision
to open a DRM vendor evaluation (B); nothing else.

Open design questions to settle in the foundation step (confidence low until spiked):

- **Safari and iOS without FairPlay.** Apple browsers will not play `cbcs` media through
  ClearKey reliably, and FairPlay credentials are out of reach for now (§3.3). Options: keep a
  clear or AES-128 rendition for Apple browsers until credentials exist, or accept that protected
  playback is proven on Chromium and Firefox only. This needs a spike before the layout is fixed.
- **hls.js and the key systems.** hls.js is believed to support ClearKey, Widevine, PlayReady
  and FairPlay through EME [M]; confirm against the pinned version before committing.
- **Analysis cost on this laptop.** A full quality analysis is many encodes per title. Sampling
  scenes should keep it to hours for 13 films; this is an estimate, not a measurement.
- **Cache behaviour for `.m4s` on an R2 custom domain** and the cross-origin rules a separate
  media hostname needs; verify against current Cloudflare documentation.

### 6.3 Alternatives

| Alternative | What it is | For | Against |
| --- | --- | --- | --- |
| **B. Screens first** | A 10-foot web app for televisions and React Native apps for phones and TV boxes, on today's unprotected stream | The most visible progress; a second client tests the contract | Needs Xcode, the Android SDK, devices and store accounts first; every client's playback is rebuilt when packaging and DRM change; new clients would ship unmeasured |
| **C. Live** | A miniature of the leaders' live system: redundant encoders, 2-second segments, an origin that picks the good pipeline | The frontier in 2026; an impressive demonstration | Nothing to broadcast; less portable; rests on delivery and measurement that would still be missing |
| **A-minus** | Workstreams A and D only: measure and deploy, leave protection and encoding | About half the size; fastest route to real numbers | Leaves the byte path wrong and the gate to licensed content closed; the measurement would mostly document known weaknesses |

Recommendation: the full milestone of §6.2. If it must be cut, cut workstream C's AV1 half
before anything in A or B.

### 6.4 The milestones after

| Milestone | Scope | Needs |
| --- | --- | --- |
| 4. The screens | A 10-foot web shell for Samsung and LG; React Native (Expo with `react-native-tvos`) for iOS, Android, Apple TV, Android TV and Fire TV; native players with the DRM of each platform; the QoE contract on every client; HEVC if Apple clients need it | Xcode and the Android SDK on a Mac; an Apple Developer membership and a Google Play account; a television and two phones; FairPlay approval, or clear playback on Apple devices |
| 5. The studio | The ingest console on milestone 3's pipeline; interface translation; several audio tracks and subtitle languages; audio description; rights by territory and date; a catalogue design that holds tens of thousands of titles | A decision that a real catalogue is coming |
| 6. Operating at scale | A second region or D1 read replication with session bookmarks; load tests on real infrastructure; prioritised load shedding; an on-call and support model | A launch decision and a budget |
| 7. Business-led | Downloads; an advertising tier; live events; store billing; tax or a merchant of record | Rights, advertisers, a legal entity |

### 6.5 Risks

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| A DRM vendor will not open an evaluation to an individual without a company | The real-DRM lane cannot run | ClearKey proves the architecture; the vendor lane is non-blocking and reports skipped with the reason |
| ClearKey protects nothing | A reader takes the stand-in for security | Say so in every document; the claim of milestone 3 is the architecture and the vendor lane, not robustness |
| Apple browsers cannot play the protected stream | Protected playback is proven on two engines of three | Decide the fallback in the foundation step (§6.2) |
| Measurement without real viewers | Numbers describe the synthetic fleet, not the world | Use recorded network profiles; add real devices on the real deployment; invite testers if the owner agrees |
| The data plane differs per mode and the local edge cache is not emulated | A local pass says less than before about production | The delivery conformance suite runs against the real deployment as a gate |
| A public deployment with a known demo account | Abuse and an unexpected bill | Do not seed the demo account in production; budget alerts; Cloudflare rules in front |
| Milestone 3 starts on an unfinished milestone 2 | Two moving bases | Make closing milestone 2 the entry condition |
| Encoding work outgrows the laptop | Slow iteration | Sample scenes; cache by input hash as `tools/media` does; run long encodes in Cloudflare Containers once deployed |

### 6.6 Decisions only the owner can make

| # | Decision | Recommendation | Confidence |
| --- | --- | --- | --- |
| 1 | What Webflix is for: a product to launch, or a reference platform that proves the architecture | Treat it as a reference platform until a content source exists; it keeps rows 16, 18 and 19 of §4 out of scope honestly | High |
| 2 | A real Cloudflare account, a domain and a budget | Yes, in milestone 3: Workers Paid at $5 a month (docs/CLOUDFLARE.md §5), a domain, storage in cents; set a hard monthly alert | High |
| 3 | A DRM provider | Open a multi-DRM vendor evaluation (Axinom or castLabs DRMtoday) for the Widevine and PlayReady lane; do not use Google's hosted service; verify prices directly | Medium: prices and eligibility were seen only in search summaries |
| 4 | When to start Apple's FairPlay approval | With milestone 4, when an Apple Developer membership is needed anyway; expect refusal until Webflix is a consumer service | Medium |
| 5 | The phone and television stack | React Native through Expo, with `react-native-tvos`, sharing contracts and logic with the web in this monorepo; the existing web player in a 10-foot shell for Samsung and LG. Not native per platform: one owner cannot staff five codebases, and Amazon's own guidance for Fire TV points the same way | Medium: no client was prototyped for this report |
| 6 | Codec policy | H.264 and AV1 in milestone 3; HEVC only when Apple clients need it | Medium |
| 7 | Whether "both modes" may mean the control plane only | Yes: restate the rule as in §6.1 | High |
| 8 | The first real mode | Cloudflare. Kubernetes in a cloud adds egress charges and operating work with no member benefit at this stage | High |
| 9 | The privacy basis for playback telemetry, including on kids profiles | Treat QoE as operational data needed to run the service, with no behavioural use, and state it in the privacy text; this is a legal judgement and needs the owner's sign-off | Low: not legal advice |
| 10 | Real testers | Invite a small group once deployed; real networks and devices are worth more than any further simulation | Medium |
| 11 | Content | Decide by milestone 5 whether to pursue a licensable catalogue; until then spend nothing | High |

### 6.7 Confidence

High: the description of Webflix (read from code); the ranking of the stream first; the
recommendation not to split the monolith, not to build live or ads yet, and to deploy on
Cloudflare. Medium: the DRM route (vendor terms seen only as summaries; the Widevine retirement
rests on vendor sources); the client stack; the size of milestone 3. Low: anything said about
Apple's and Prime Video's internals beyond the cited pages; the Safari path; cost per viewing
hour before it is measured; the privacy basis.

---

## 7. Sources

Marks as defined at the top: **F** fetched and read today, **S** search summary only, **M** memory.

**Netflix**

- N1 [F] Netflix Technology Blog feed, https://netflixtechblog.com/feed, read 2026-11-22. The
  post pages refuse automated fetches; these posts were read through the feed:
  - N1a "Engineering AI Discover", 2026-11-17, https://netflixtechblog.com/engineering-ai-discover-e244944cdc38
  - N1b "Integrating Netflix's Foundation Model into Personalization applications", 2026-10-14, https://netflixtechblog.com/integrating-netflixs-foundation-model-into-personalization-applications-cf176b5860eb
  - N1c "Measuring the Impact of Personalized Recommendations", 2026-10-14, https://netflixtechblog.com/measuring-the-impact-of-personalized-recommendations-4c26be3a4d96
  - N1d "DataJunction as Netflix's answer to the missing piece of the modern data stack", 2026-10-14, https://netflixtechblog.com/datajunction-as-netflixs-answer-to-the-missing-piece-of-the-modern-data-stack-92af926b40a5
  - N1e "Multi-Ratio Video Resizing for Mobile Feed and Marketing", 2026-10-26, https://netflixtechblog.com/multi-ratio-video-resizing-for-mobile-feed-and-marketing-2e6b42810f49
  - N1f "Single-tenant Titus: VM-level isolation on a multi-tenant container platform", 2026-10-22, https://netflixtechblog.com/single-tenant-titus-vm-level-isolation-on-a-multi-tenant-container-platform-6d8b1909d163
- N2 [F, through a repost] "Netflix Live Origin", Netflix Technology Blog, December 2025,
  https://netflixtechblog.com/netflix-live-origin-41f1b0ad5371; read at
  https://noise.getoto.net/2025/12/15/netflix-live-origin/ (dated 2025-12-15).
- N3 [F] Netflix Open Connect, https://openconnect.netflix.com/en/ (page copyright 2026).
- N4 [F] "Netflix's third season of ads and a look ahead at what's next", 2025-11-05,
  https://about.netflix.com/en/news/netflix-third-season-of-ads-and-a-look-ahead-at-whats-next
- N5 [F, secondary] D. Rayburn, "Netflix Says AV1 Codec Now Powers 30% of Netflix VOD Streaming",
  2025-12-23, https://www.streamingmediablog.com/2025/12/netflix-av1.html, summarising
  https://netflixtechblog.com/av1-now-powering-30-of-netflix-streaming-02f592242d80 (not opened).
- N6 [F] A. Ramanujam, "How Netflix does failovers in 7 minutes flat", 2018-04-17,
  https://opensource.com/article/18/4/how-netflix-does-failovers-7-minutes-flat
- N7 [S] InfoQ on Netflix's prioritised load shedding, 2024-11 and 2025-11,
  https://www.infoq.com/news/2024/11/netflix-load-shedding/ and
  https://www.infoq.com/news/2025/11/netflix-prioritized-loadshedding
- N8 [S] InfoQ, "federated GraphQL platform Netflix",
  https://www.infoq.com/articles/federated-GraphQL-platform-Netflix; The New Stack on the mobile
  migration, https://thenewstack.io/netflixs-testing-strategies-for-migrating-to-graphql/
- N9 [S] InfoQ, 2026-03, QCon London talk on Netflix billing and payments,
  https://www.infoq.com/news/2026/03/netflix-dvds-to-global-streaming (fetch refused).
- N10 [S] Lindon et al., "Anytime-Valid Linear Models and Regression Adjusted Causal Inference in
  Randomized Experiments", https://arxiv.org/pdf/2210.08589
- N11 [S] Q3 2026 results: https://thedesk.net/2026/10/netflix-q3-2026-earnings-report/ and
  https://www.screendaily.com/news/netflix-reports-solid-q3-financials-lowers-2026-ad-revenue-forecast/5221637.article
  (2026-10); content spend guidance:
  https://finance.yahoo.com/news/netflix-q4-earnings-call-highlights-231246984.html (2026-01).
- N12 [S] APNIC, "Netflix content distribution through Open Connect", 2018-06-20,
  https://blog.apnic.net/2018/06/20/netflix-content-distribution-through-open-connect/; Open
  Connect overview, https://openconnect.netflix.com/Open-Connect-Overview.pdf; server and
  location counts from https://blog.bytebytego.com/p/how-netflix-live-streams-to-100-million
- N13 [S] Netflix partner help centre, for example
  https://backlothelp.netflix.com/hc/en-us/articles/360053755033-Netflix-IMSC-1-1-Text-Profile
- N14 [S] "Unveiling our innovative new TV experience", 2025-05,
  https://about.netflix.com/en/news/unveiling-our-innovative-new-tv-experience; the rendering
  engine detail comes from community sources only.
- N15 [S] CBS News on Netflix withdrawing its Warner Bros. Discovery bid,
  https://www.cbsnews.com/news/netflix-warner-paramount-skydance-deal (date not shown).
- N16 [S] Secondary accounts of per-title encoding (2015) and the Dynamic Optimizer (2018), for
  example https://www.mux.com/blog/better-video-quality-through-deep-learning; the Netflix posts
  themselves are M.

**Amazon**

- A1 [F] A. Ene, "How Prime Video updates its app for more than 8,000 device types", 2022-01-27,
  https://www.amazon.science/blog/how-prime-video-updates-its-app-for-more-than-8-000-device-types
- A2 [F] "Prime Video with Alexandru Ene", Rust in Production, 2025-10-02,
  https://corrode.dev/podcast/s05e01-prime-video/; [S] QCon San Francisco 2024,
  https://qconsf.com/presentation/nov2024/rebuilding-prime-video-ui-rust-and-webassembly
- A3 [F, third party] N. Bargisen, Kentik, 2023-05-25,
  https://www.kentik.com/blog/the-subtle-details-of-livestreaming-prime-video-with-embedded-cdns
- A4 [S] AWS case study, https://aws.amazon.com/solutions/case-studies/amazon-prime-video/
- A5 [S] Amazon Ads on the 2025 Thursday Night Football season,
  https://advertising.amazon.com/library/news/prime-video-tnf-2025-viewership-advertising; the
  315 million reach figure was seen only in a third-party summary.
- A6 [F] A. Malde, "Sharing your Vega app across platforms", 2026-05-21,
  https://developer.amazon.com/apps-and-games/blogs/2026/05/sharing-your-vega-app-across-platforms
- A7 [M] Prime Video Tech, 2023, on moving a monitoring service from serverless functions to a
  single process.

**Apple**

- P1 [F] FairPlay Streaming, https://developer.apple.com/streaming/fps/, read 2026-11-22.
- P2 [S] HLS Authoring Specification for Apple devices,
  https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices;
  AV1 on Apple devices from https://bitmovin.com/blog/apple-av1-support/
- P3 [S] The rename and bundled sport: https://www.thewrap.com/apple-tv-streaming-service-rebrand/
  and https://9to5mac.com/2025/11/14/apple-tv-dropped-the-but-keeps-adding-value-to-win-subscribers/
- P4 [S] Streaming Media, 2014, on Apple's CDN,
  https://www.streamingmedia.com/Articles/Editorial/Featured-Articles/Apples-$100M-Investment-Marks-a-Shift-Away-From-Third-Party-CDNs-99832.aspx;
  hostname fingerprinting at https://www.netify.ai/resources/applications/apple-tv
- P5 [S] Apple newsroom, 2026-08,
  https://www.apple.com/ca/newsroom/2026/08/apple-announces-changes-for-apps-in-the-european-union/;
  MacRumors, 2025-12-11, https://www.macrumors.com/2025/12/11/apple-app-store-fees-external-payment-links/

**Standards, platforms and vendors**

- X1 [F] Widevine access, https://developers.google.com/widevine/access
- X2 [F, sponsored] J. Siska, Streaming Media, 2026-03-26,
  https://www.streamingmedia.com/Articles/Editorial/Spotlights/View-From-the-Top-What-Googles-2027-License-Service-Deadline-Means-for-Streamers-174083.aspx;
  [S] vendor notices: https://www.axinom.com/media/article/widevine-cls-sunset and
  https://nagra.vision/widevine-cloud-licence-service-shutdown/
- X3 [S] https://www.axinom.com/products/drm; DRMtoday on AWS Marketplace,
  https://aws.amazon.com/marketplace/pp/B07885W88Q
- X4 [S] MovieLabs Enhanced Content Protection v1.3,
  https://movielabs.com/ngvideo/MovieLabs_ECP_Spec_v1.3.pdf
- X5 [S] AOMedia, 2026-06-09,
  https://aomedia.org/press%20releases/Alliance-for-Open-Media-Releases-AV2-Codec/
- X6 [S] CTA-2066, https://www.cta.tech/standards/cta-2066/; CMCD,
  https://cta-wave.github.io/Resources/common-media-client-data--cta-5004-a.html and
  https://www.fastly.com/blog/cmcdv2-leveling-up-your-video-streaming-telemetry; hls.js issue
  7724 (seen through a mirror); one-encode multi-DRM from
  https://dev.to/masonwritescode/package-one-cmaf-asset-for-widevine-playready-and-fairplay-no-second-encode-3glf
- X7 [S] https://datatracker.ietf.org/doc/draft-ietf-moq-transport/
- X8 [F] Cloudflare Service-Specific Terms, last updated 2026-09-28,
  https://www.cloudflare.com/service-specific-terms-application-services/
- X9 [S] https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/ and
  https://blog.cloudflare.com/cloudflare-data-platform
- X10 [F] Expo, "Building for TV", https://docs.expo.dev/guides/building-for-tv/
- X11 [S] Samsung TV simulator,
  https://developer.samsung.com/tv/develop/getting-started/using-sdk/tv-simulator
- X12 [S] Stripe Managed Payments, https://docs.stripe.com/payments/managed-payments/how-it-works
  and https://stripe.com/blog/everything-we-announced-at-sessions-2026
- X13 [S] Android Developers Blog, 2026-06,
  https://android-developers.googleblog.com/2026/06/play-expanded-billing.html

**Not verified today, and said so in the text**: Prime Video's use of third-party CDNs and its
codecs; Apple's delivery and service architecture; whether Apple has an advertising tier; the
current number of AWS regions Netflix uses; the share of viewing that happens on televisions;
vendor prices; hls.js's current key-system and CMCD support; LG's television platform.
