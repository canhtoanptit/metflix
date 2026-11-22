# Webflix

Webflix is a subscription video streaming product with its own brand, built as a spike to prove
that one TypeScript codebase can ship to two very different targets: Kubernetes (a Helm chart,
run locally on kind) and Cloudflare's serverless platform, plus a zero-infrastructure Node mode
for development. A feature counts as done only when it works in both deployment modes,
`make check` passes, and the behaviour has been exercised for real against a running mode.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node | 26.8 (`.nvmrc` pins 26.8.1) | everything |
| pnpm | 10.5 (`packageManager` pins 10.5.2) | everything |
| Docker with buildx | recent (29.7 used) | `make content` (ffmpeg runs in a container) and the Kubernetes mode |
| kind | 0.31 or later (0.33 used) | Kubernetes mode |
| Helm | 4.0.1 or later (4.2 used; releases are applied server-side, see docs/KUBERNETES.md §2) | Kubernetes mode |
| kubectl | recent (1.37 used) | Kubernetes mode |

What each mode does not need: the dev mode needs no Docker, no database and no environment
variables; the Cloudflare local mode needs no Docker and no Cloudflare account (Wrangler and
workerd are dev dependencies); `make k8s-up` itself needs no Node on the host (images, media
upload and chart checks run in containers), although the verification scripts do. `make doctor`
prints what is installed.

```sh
make setup      # pnpm install, then Playwright's Chromium, Firefox and WebKit (for make verify)
```

## Quickstart

### Dev mode

```sh
pnpm install
make dev        # API on http://localhost:4000, web app on http://localhost:5173
```

Open http://localhost:5173. On first start the API migrates and seeds a SQLite database in
`.data/webflix.sqlite` (a few seconds), keeps blobs in `.data/blobs` and everything else in
process. The API reference is at http://localhost:4000/api/docs. To start from scratch, stop it
and delete `.data/`. Until `make content` has run, every title plays a public HLS test stream
from the internet and artwork shows as flat colour.

`make web-mock` runs the web app with no backend at all: a mock API in the browser with its own
small catalogue ([docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) §6).

### Demo media: `make content`

```sh
make content                # PROFILE=fast: short clips; PROFILE=full packages the complete films
```

Needs Docker and the network. It downloads the open films and photographs, renders artwork for
every title, packages HLS with subtitles, trick-play thumbnails and preview clips into
`.cache/media/fast/`, and copies the result into the dev blob store. Measured on a 12-core arm64
Mac with 16 MB/s downloads ([tools/media/README.md](tools/media/README.md)): about 17 minutes of
building on the first run, plus up to 10 minutes of photo downloads; 5 s when nothing changed.
Disk: about 2 GB of downloads, 2.4 GB of packaged output and a 2.3 GB copy in `.data/blobs`.
Restart `make dev` to use it; `make k8s-up` and `make cf-dev` upload it to their own stores.

### Kubernetes mode (kind)

```sh
make k8s-up                     # cluster, gateway, images, Helm release, media: http://localhost:8080
make k8s-status                 # release, pods, routes, autoscalers, recent jobs
make k8s-down                   # delete the cluster and its kubeconfig
```

`make k8s-up` creates a three-node kind cluster named `webflix` (port 8080 must be free),
installs Envoy Gateway, builds the API and web images, and deploys the chart: API replicas
behind the gateway, the job worker, PostgreSQL, Valkey and Garage (S3), with migrate and seed
Jobs. If `make content` has run, it uploads the media. It is safe to re-run. Measured in
[docs/KUBERNETES.md](docs/KUBERNETES.md) §2: 177 s from nothing with a warm Docker cache (about
2 minutes more without one), 28 s for a re-run with nothing changed, about 40 s for
`make k8s-redeploy` after a code change. Idle, the node containers use about 2.5 GiB of memory
(§7 there).

The rate limits are the strict production values, and every local client shares one address.
For browser runs use `make k8s-up RATE_LIMITS=relaxed`; run `make k8s-up` again to go back.

`make k8s-down` leaves the built `webflix-api`, `webflix-web` and `webflix-media-tools` images
(so the next `k8s-up` is fast; `make k8s-clean` also removes them), Docker's BuildKit cache and
the pulled base images. To use kubectl or k9s: `export KUBECONFIG=$(make -s k8s-kubeconfig)`.

### Cloudflare mode (local)

```sh
make cf-dev                     # build, migrate, upload media, seed, serve: http://localhost:8787
make cf-stop                    # from another shell: stop this repository's dev server
make cf-reset                   # stop it and delete its local state
```

`make cf-dev` runs the Worker in workerd through `wrangler dev`, with D1, KV, R2, Durable
Objects and Queues emulated locally in `apps/edge/.wrangler/state`; Ctrl-C stops it. Measured in
[docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) §7: 121 s from nothing, most of it uploading the fast
media profile into local R2, and 7 s for a re-run. A second instance can run beside the first:

```sh
make cf-dev CF_PORT=4620 CF_INSPECTOR_PORT=4621 CF_STATE=/tmp/cf-b/state CF_ASSETS=/tmp/cf-b/public
make cf-stop CF_PORT=4620 CF_STATE=/tmp/cf-b/state
```

`make cf-deploy-dry-run` rehearses the production deploy without an account. `make cf-deploy`
targets a real account; see the limitations below before relying on it.

### Demo sign-in

| | |
| --- | --- |
| Email | `demo@webflix.dev` |
| Password | `webflix-demo` |
| Profiles | Alex, Jordan (PIN `2468`), Mia (13+), Kids (7+) |

Seeded in every local mode, on the Premium plan with viewing history, My List and ratings. The
account is shared, so its sign-in details, plan, card and profiles are protected
(`demo_account_protected`). Sign up to try those: payments are mocked, `4242 4242 4242 4242`
approves and `4000 0000 0000 0002` is declined ([docs/BACKEND.md](docs/BACKEND.md) §3).

## Verify a mode

```sh
make verify TARGET=dev          # or TARGET=k8s, TARGET=cf; BASE_URL=<origin> for anything else
```

`make verify` runs two suites against the running mode, one after the other, and prints one
summary. It exits non-zero if either suite has a failure or a flaky test. Reports go to
`e2e/test-results/verify/`.

| Suite | What it checks | Details |
| --- | --- | --- |
| Browser suite | Playwright: every spec in Chromium; sign-in, browse and playback in Firefox and WebKit | [e2e/README.md](e2e/README.md) |
| Conformance suite | 133 black-box HTTP checks of the contract and the documented behaviour, milestone 2's journeys included (`make smoke-list` prints the current catalogue; what a deployment must provide for none to skip is in the suite's README) | [tools/smoke/README.md](tools/smoke/README.md) |

The conformance suite ends by exhausting the sign-in budgets of the address it runs from, so
it runs second, after a 65 s pause ([why the order matters](e2e/README.md#verify-the-browser-suite-then-the-conformance-suite)).
The conformance suite takes about 3 minutes against the dev mode and longer under strict rate
limits; the browser suite's duration depends on the machine and is not recorded. Each suite
also runs alone: `make e2e TARGET=…` and `make smoke TARGET=…`. `make e2e-throttled TARGET=…`
is the Chromium suite with the CPU slowed 4x. `make check` runs lint, typecheck and the unit,
contract and integration tests (what CI runs); `make help` lists every target.

## Repository map

The rule that holds it together: `packages/contracts`, `packages/core` and `packages/http` use
Web-standard APIs only (no `node:` imports, no `process.env`; Biome enforces it), and everything
specific to a runtime lives in an adapter package or in one of the two entrypoints, `apps/api`
(Node) and `apps/edge` (Cloudflare Worker).

| Layer | Path | What it holds |
| --- | --- | --- |
| Contract and domain | `packages/contracts` | The route table (46 routes), zod schemas, error codes, typed API client, OpenAPI |
| | `packages/core` | Application services, ports, the ports' contract test suites, in-memory adapters |
| | `packages/db` | Kysely schema, migrations and repositories: one implementation for SQLite, PostgreSQL and D1 |
| | `packages/http` | `createApp()`: the Hono app serving the route table, auth, rate limits, media, OpenAPI |
| | `packages/catalog` | Seed data: titles, people, genres, avatars, the demo account |
| Adapters | `packages/adapters-node` | Filesystem blobs, scrypt, Valkey (cache, rate limits, stream gate, jobs), S3 |
| | `packages/adapters-cloudflare` | D1, KV, R2 behind the edge cache, Durable Objects, Queues |
| Entrypoints | `apps/api` | Node: `serve`, `worker`, `migrate`, `seed`, `wait` (dev and Kubernetes modes) |
| | `apps/edge` | The Worker (`fetch`, `queue`, `scheduled`, Durable Objects) and its dev, seed and deploy scripts |
| Front end | `apps/web` | The React single-page app |
| | `packages/ui` | Design system: tokens, components, icons |
| | `packages/player` | Video player (hls.js and native HLS) and the preview player |
| Deployment | `deploy/docker` | Dockerfiles and bake file for the API, web and media-tools images |
| | `deploy/helm/webflix` | The Helm chart |
| | `deploy/kind` | kind cluster, `up.sh` and the in-cluster verification scripts |
| Tooling and tests | `tools/media` | Artwork generation and HLS packaging (ffmpeg in Docker), upload, credits |
| | `tools/smoke` | The conformance suite |
| | `e2e` | Playwright suites and `make verify` |
| | `docs` | Design documents, runbooks and decision records (below) |
| | `.github/workflows` | CI: lint, typecheck, test |

Git-ignored local state: `.data/` (dev database and blobs), `.cache/media/` (media cache),
`.cache/kube/config` (the cluster's kubeconfig), `apps/edge/.wrangler/` and `apps/edge/.dev.vars`
(Cloudflare local state and its media-token key).

## Architecture

Every mode runs the same application services (`createServices`) and the same HTTP app
(`createApp`); only the composition root and the adapters behind the ports differ. The web app
and the API share one origin (`/api/v1`, `/media`, `/cdn`), so there is no CORS and the session
is an httpOnly cookie. Video is packaged offline into HLS and served through short-lived signed
URLs; nothing is transcoded at request time.

```
                 browser: apps/web (React SPA)
                   │  same origin: /api/v1  /media  /cdn
 ┌─────────────────▼─────────────────────────────────────────────────────────────┐
 │ packages/http  createApp(): route table, auth, CSRF, rate limits, media, docs │
 │ packages/core  application services and the ports below                       │
 │ packages/db    Kysely repositories and migrations, one implementation         │
 └─────────────────┬───────────────────────┬──────────────────────┬──────────────┘
                   │                       │                      │
Port               dev: apps/api           k8s: apps/api          cloudflare: apps/edge
                   one Node process        Helm chart on kind     one Worker
────────────────── ─────────────────────── ────────────────────── ──────────────────────────
Database           SQLite file             PostgreSQL             D1
SearchIndex        SQLite FTS5             PostgreSQL tsvector    D1 FTS5
KeyValueCache      memory                  Valkey                 Workers KV
RateLimiter        memory                  Valkey                 Durable Object per key
StreamGate         memory                  Valkey                 Durable Object per account
BlobStore          filesystem              S3 API (Garage)        R2 behind the edge cache
JobQueue           in process              Valkey Streams         Queues and Cron Trigger
PasswordHasher     scrypt                  scrypt                 PBKDF2 (WebCrypto)
```

Every adapter passes its port's shared contract suite in the runtime it ships to.
[docs/BLUEPRINT.md](docs/BLUEPRINT.md) §2 has the design and
[docs/DECISIONS.md](docs/DECISIONS.md) the reasons.

## Where to read next

| Document | Answers |
| --- | --- |
| [docs/BLUEPRINT.md](docs/BLUEPRINT.md) | What Webflix is meant to be: scope and status, architecture, API surface, UX standard, working rules |
| [docs/FOUNDATION.md](docs/FOUNDATION.md) | How to write code here: workspace, the contract and typed client, ports, conventions |
| [docs/BACKEND.md](docs/BACKEND.md) | How the API behaves and is configured: privileges, rate limits, every environment variable, operations |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why the backend works the way it does (decision records) |
| [docs/RECOMMENDATIONS.md](docs/RECOMMENDATIONS.md) | How browse pages are composed and personalised |
| [docs/CONTRACT_CHANGES.md](docs/CONTRACT_CHANGES.md) | What changed in `@webflix/contracts` after the foundation |
| [docs/KUBERNETES.md](docs/KUBERNETES.md) | The chart, the kind workflow, measured behaviour, production notes |
| [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) | The Worker's design, local workflow, deploy runbook, budgets and costs |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | The visual identity, tokens, components and web app platform |
| [docs/CREDITS.md](docs/CREDITS.md) | Every film, photograph and font, with its licence |

Package guides: [e2e](e2e/README.md), [tools/smoke](tools/smoke/README.md),
[tools/media](tools/media/README.md), [packages/player](packages/player/README.md).
[docs/README.md](docs/README.md) says which document is authoritative for what.

## Known limitations

- The Cloudflare production deploy has only been rehearsed as a dry run: resource creation,
  remote migrations and seeding, secrets and the Workers edge cache have not run against a real
  account ([docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) §8). Production needs Workers Paid, because
  a PBKDF2 sign-in costs more CPU than the free plan allows.
- The in-cluster PostgreSQL, Valkey and Garage are single instances; production should use
  managed services ([docs/KUBERNETES.md](docs/KUBERNETES.md) §8).
- There is no password reset, because there is no email delivery. Payments are mocked, and
  there is no DRM.
- Fictional titles list feature-length runtimes but play short clips: 75 to 210 s each with the
  fast profile, a few minutes of an open film with the full one.
- The fictional titles reuse a small pool of 13 open films; [docs/CREDITS.md](docs/CREDITS.md)
  says which film each one plays.
- Only Playwright's browser engines were exercised (Chromium, Firefox, WebKit), not real Safari
  or iOS and Android devices.
- If a PostgreSQL connection is lost between sending COMMIT and receiving its acknowledgement,
  the outcome is unknown: the request answers 503 saying the change may or may not have been
  saved ([docs/DECISIONS.md](docs/DECISIONS.md) D42).
- Password hashes made in the Node modes (scrypt) do not verify on Workers, so accounts do not
  move from a Node mode to Cloudflare as they are ([docs/CLOUDFLARE.md](docs/CLOUDFLARE.md) §6).
- A player that already holds a media playlist can fetch its segments until the token expires
  (6 h by default), even after its stream slot is revoked; accepted without DRM
  ([docs/DECISIONS.md](docs/DECISIONS.md) D1).
- Accounts cannot be deleted (there is no API for it).
- Not built, deferred: the admin Studio (upload and publish), a third deployment mode on a cloud
  emulator, and i18n.

## Licence and credits

The repository has no licence file. Every film, photograph and font Webflix shows is freely
licensed or original: Blender Studio's open films (CC BY), Wikimedia Commons and NASA
photographs (CC BY, CC BY-SA, CC0 or public domain) and OFL or Apache fonts.
[docs/CREDITS.md](docs/CREDITS.md) lists each one with its licence and attribution; it is
generated by `make content-credits`. The Kubernetes mode's object store is Garage, licensed
AGPL-3.0 and run unmodified from its official image; Webflix only talks to it over the S3 API.

## Safety of the local tooling

- The Kubernetes targets only create, change or delete kind clusters whose name starts with
  `webflix`, and call kind, kubectl and Helm with the repository's own kubeconfig,
  `.cache/kube/config`, and an explicit context. Nothing reads or writes `~/.kube/config`.
- `make cf-stop` and `make cf-reset` stop only a dev server proven to be this repository's;
  anything else listening on the port is left alone and the target fails.
- `make k8s-clean` removes only the `webflix-api`, `webflix-web` and `webflix-media-tools`
  images. Nothing prunes Docker's BuildKit cache, which other projects share.
- `make clean` removes build output and tool caches; it keeps `node_modules`, `.cache` and
  `.data`.
