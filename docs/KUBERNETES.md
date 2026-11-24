# Webflix on Kubernetes

The `k8s` deployment mode: the Helm chart in `deploy/helm/webflix`, the container images in
`deploy/docker` (and the pipeline's own image, `services/recs/Dockerfile`), and a local kind
workflow in `deploy/kind` that runs it the way production would. Companion documents:
`docs/BACKEND.md` §4 and §5 (the API's side of this contract), `docs/BLUEPRINT.md` §4/§8 and
`docs/BLUEPRINT-M2.md` §9 (what differs by mode).

```sh
make k8s-up                       # one node, production configuration → http://localhost:8080
make k8s-up VARIANT=conformance   # the variant the whole conformance suite runs on (§9.2)
make smoke TARGET=k8s
make k8s-down
```

---

## 1. Architecture

```
 browser ──► localhost:8080 ──► kind node :30080 ──► Envoy (Gateway API, 2 replicas)
                                                         │  HTTPRoute
              /api/*  /media/*  /cdn/*  ─────────────────┼──────────────► webflix-api   (Deployment, HPA 2–5 on kind / 3–12 default)
              /dev-idp/*  /_pay/*  (404 in production) ───┤
              everything else  ──────────────────────────┘──────────────► webflix-web   (nginx, static SPA, HPA 2–3)
                                                                               │
   webflix-worker (job consumer + scheduler) ◄── Valkey Streams ──┐            │
        │ SMTP                                                    ▼            ▼
        ▼                 webflix-valkey (AOF)   webflix-postgresql   webflix-objectstore (Garage, S3 API)
   webflix-mailcatcher    cache · rate limits ·  accounts, catalog,   bucket webflix-media: artwork,
   (Mailpit, kind)        stream leases · jobs   billing, identity,   previews, HLS, manifests, the event
                                                 events, recs, audit  lake (events/), recs/, privacy/
   webflix-keycloak (staff issuer, HTTPS :8443) ◄── API (keys), jobs (service account token)
   CronJobs webflix-recs-*: lake round (erase, export-events, compact), analyse, train-and-score
   Jobs per revision: webflix-migrate-N ──► webflix-seed-N (reads manifests/media.json from the bucket)
```

| Component | Image | Notes |
| --- | --- | --- |
| API, worker, migrate, seed | `webflix-api` (Alpine 3.24 + Node 26.8.1 binary, one esbuild bundle) | one image, four commands (`serve`, `worker`, `migrate`, `seed`, plus `wait` for init containers) |
| Web | `webflix-web` (nginxinc/nginx-unprivileged 1.30) | pre-gzipped assets, SPA fallback, security headers |
| Pipeline jobs | `webflix-recs` (`services/recs/Dockerfile`, Python 3.13, `make recs-image`) | compact, erase, export-events, train-and-score, publish, analyse-experiments against the bucket's S3 API |
| Pipeline's Node steps, importers | `webflix-tools` (`deploy/docker/Dockerfile` target `tools`: Node 26.8.1, the repository's packages run from source) | the catalogue snapshot, the rule-engine baseline of train-and-score, `apps/api/src/recs.ts import` / `experiments-import` |
| PostgreSQL | `postgres:19.0-alpine3.24` (official, digest-pinned) | single primary, PVC, data checksums; Keycloak's database too |
| Valkey | `valkey/valkey:9.2.0-alpine3.24` (official) | AOF `everysec`, `noeviction`, password from a Secret |
| Object storage | `dxflrs/garage:v2.5.0` (official) | single node, bucket + key bootstrapped from a Secret; **no conditional writes** (§9.7) |
| Staff issuer | `quay.io/keycloak/keycloak:26.8.2` (digest-pinned), optional (`keycloak.enabled`, on in the kind values) | production mode (`start`), HTTPS, realm imported at start, data in PostgreSQL |
| Mail catcher | `axllent/mailpit:v1.34.0` (digest-pinned), optional (`mailcatcher.enabled`, kind only) | catches what the SMTP sender sends |
| Gateway | Envoy Gateway v1.10.0 (Gateway API v1.6.1 CRDs) | installed by `k8s-up` on kind; any conformant implementation in production |
| kind | `kindest/node:v1.37.0` (kind v0.33 digest) | 1 node by default; 1 control plane + 2 workers labelled `zone-a`/`zone-b` with `NODES=3` |

**Why these choices.**

- *Gateway:* ingress-nginx was retired in March 2026; the Gateway API is the supported
  successor. Envoy Gateway is the CNCF reference implementation, conformant, light on kind, and
  its policies cover what this app needs at the edge (retries that are safe for any method,
  upstream idle timeouts, `X-Request-Id` preservation). The chart itself only needs standard
  `Gateway`/`HTTPRoute`; the Envoy-specific policies render only when their CRDs exist.
- *Object store:* MinIO's community images stopped in late 2025 and the project was archived in
  February 2026. Garage (Deuxfleurs, Rust, since 2020) is actively released (v2.5.0, Oct 2026),
  tiny (26 MB image, ~20 MB RSS), and since v2.3 bootstraps a single node, its bucket and its
  access key declaratively from environment variables, so no setup Job is needed. RustFS reached
  1.0 only in September 2026 and was the runner-up. The adapter speaks plain S3, so any store
  (AWS S3, R2, Ceph RGW, RustFS) replaces it through `externalS3`.
- *Valkey client:* ioredis 6 (pure JS, maintained by Redis, works with Valkey), so the API
  bundles to one file with no native module.
- *Staff issuer:* Keycloak, the blueprint's choice (M2 §8.3), current release 26.8.2
  (keycloak.org/downloads, read 2026-11-22). Production mode (`start`), because `start-dev` and
  the `dev-file` database are documented as unsuitable for production
  (keycloak.org/server/db); its database is a role and database of its own in the in-chart
  PostgreSQL. The realm is imported with `--import-realm` from `/opt/keycloak/data/import`,
  which Keycloak skips once the realm exists (keycloak.org/server/importExport): later realm
  changes are made in Keycloak, or by deleting the realm. A full-URL `KC_HOSTNAME` with
  backchannel-dynamic left off fixes every URL of the realm, so a token's `iss` is the same
  whichever address reached Keycloak (keycloak.org/server/hostname); the management port 9000
  serves the health endpoints over HTTPS like the main listener
  (keycloak.org/server/management-interface).
- *Mail catcher:* Mailpit (SMTP 1025, UI and REST API 8025; mailpit.axllent.org). Its image
  declares no user, so the chart runs it as UID 10001 with its database on an `emptyDir`.
- *The pipeline's Node steps:* `train-and-score` compares against the real milestone 1 rule
  engine, which is TypeScript, and the Python image has no Node (services/recs/README.md,
  "The rule engine in a job"); the importers are the product's own TypeScript. One `tools`
  image (production dependencies of `@webflix/api` and the sources, run as in dev mode) serves
  both instead of a second bundle per script.

## 2. One command: `make k8s-up`

Needs Docker (with buildx), kind ≥ 0.31, Helm ≥ 4.0.1 (4.2 used here) and kubectl, against
Kubernetes ≥ 1.31 (the chart's `kubeVersion`). Nothing else on the host: images, the media
uploader and the chart checks all run in containers.

Why Helm 4.0.1: releases are applied server-side (`--server-side`, `--force-conflicts`, the
field ownership handling below) and waited on with `--wait=watcher`; Helm 3.18 and 3.19 have
none of these (`--wait` is a plain switch there). Helm 4.0.0 upgrades the release fine but
renders this chart offline (`helm template`, as the Cloudflare header generator does) against
Kubernetes 1.20, below `kubeVersion`; 4.0.1 fixed that. Checked with the release binaries in a
throwaway container: an upgrade of this release with 4.0.0, offline renders with 4.0.0 to 4.2.4.
`up.sh`, `release.sh` and `make doctor` check the version.

| Step | What happens | Re-run |
| --- | --- | --- |
| Preflight | tools present, Docker reachable, port 8080 free | — |
| Cluster | `kind create cluster` from `deploy/kind/cluster.yaml` (1 node) or `cluster-3.yaml` (`NODES=3`), port 8080 → NodePort 30080 | reused as it is; stopped nodes started; another `NODES` refused |
| Platform | Envoy Gateway (Helm, OCI), metrics-server, `EnvoyProxy` + `GatewayClass webflix` | skipped when the pinned versions are installed |
| Images | `docker buildx bake` (API + web, then `tools`), `make recs-image` (the pipeline), one build at a time, tagged by image ID, `kind load` | unchanged tree ⇒ same ID ⇒ nothing loaded, nothing rolls |
| Release | namespace with Pod Security `restricted`; field ownership check (below); `helm upgrade --install --wait=watcher --wait-for-jobs` | new revision: migrate + seed Jobs run (no-op when unchanged) |
| Media | if `.cache/media/<profile>/manifest.json` exists: upload through the media tool's `s3:` target (port-forward on 127.0.0.1:4510), then re-seed if the manifest changed | objects with the same SHA-256 are skipped |
| Verify | `/` and `/api/v1/plans` answer through the gateway | — |

Measured on a 12-core arm64 Mac (Docker VM 23 GB, 11 CPUs), warm Docker cache, from no cluster:
`make k8s-up VARIANT=conformance` on one node **268 s** (cluster 27 s, platform 43 s, images 34 s,
release 53 s, the 2.2 GB fast media profile uploaded and re-seeded 111 s); `make k8s-up NODES=3`
in the production configuration **307 s** (cluster 24 s, platform 42 s, images 45 s, release
73 s with Keycloak's first start, media 122 s). A re-run with nothing changed: ~40 s, no pod
restarts (a new Helm revision whose Jobs are no-ops; the pipeline's images are built with fixed
timestamps, so they keep their IDs too). `make k8s-redeploy` after a code change: ~40 s, only
changed components roll. A cold build without any Docker cache adds roughly 2 min (base
images, pnpm store, the pipeline's wheels).

Options: `NODES=1|3` (below), `VARIANT=production|conformance` (§9.2; default: the variant
deployed now, else production, so `k8s-redeploy` keeps it), `MEDIA_PROFILE=fast|full`,
`SKIP_MEDIA=1`, `SKIP_BUILD=1`, `RATE_LIMITS=relaxed` (see §6) and
`K8S_OWNERSHIP=take|strict|off` (below). Without packaged media every title plays the catalogue's external HLS fallback; run
`make content` then `make k8s-media` (or `k8s-up` again) and the next seed switches to packaged
media.

### One node, or three

The everyday cluster is one node (`deploy/kind/cluster.yaml`): kind removes the control-plane
taint when a cluster has a single node, so everything schedules there (kind's
`kubeadminit` action). Replicas, the gateway, the job worker, the CronJobs and both conformance
configurations run on it. Three nodes (`make k8s-down && make k8s-up NODES=3`) are for the
failure-injection targets that take a node away or need zones; on one node they refuse and say
how to get the bigger cluster:

```
$ make k8s-outage
✗ k8s-outage (a node cordoned while the store is away) needs the 3-node cluster; 'webflix' has 1 node.
  The node count is fixed when the cluster is created: make k8s-down && make k8s-up NODES=3 (…)
```

Gated: `k8s-outage`, `k8s-partition` (`deploy/kind/verify/partition.ts`) and `k8s-spread`
(API and web replicas over two zones). `k8s-chaos` (a pod deleted or killed) and `k8s-verify`
run on either. The node count is fixed when kind creates a cluster; `up.sh` refuses a
`NODES` that differs from the existing cluster's instead of half-reconfiguring it.

### Field ownership: the release is the source of truth

Helm 4 applies the release server-side, as field manager `helm`. A field changed out of band
(`kubectl set image`, `scale`, `edit`, `patch`) gets a second manager, and once the chart sets a
different value the API server refuses the whole upgrade (`conflict with "kubectl-set" …`): the
revision is `failed` and every later deploy fails the same way. Before upgrading, `up.sh`
server-side dry-runs every object of the new revision as `helm` and lists such fields:

- `K8S_OWNERSHIP=take` (default): it prints each one (`taking back deployment.apps/webflix-api
  .spec.template.spec.containers[name="api"].image from manager "kubectl-set"`) and upgrades with
  `--force-conflicts`; the hot-patch is overwritten by what the chart says, visibly.
- `K8S_OWNERSHIP=strict`: it prints them and stops before Helm runs; nothing changes.
- `K8S_OWNERSHIP=off`: plain `helm upgrade`. If that fails on a conflict, `up.sh` still names
  the object, the manager, the field and the commands that resolve it.

Scripts never change release objects around Helm: anything that needs another value for a while
(a replica count, a restart, an image) goes through `deploy/kind/release.sh reapply --set …` and
back with `release.sh rollback <revision>`, both of which refuse to overwrite out-of-band changes.
`make k8s-ownership` lists every field of the release that a manager other than Helm owns and
whether that is expected (controllers writing `status`, `kubectl rollout restart`'s annotation,
the media key rotation's Secret value); `make k8s-test-drift` hot-patches the API image and
checks all three modes.

### Isolation from other clusters

- Webflix uses **its own kubeconfig**, `.cache/kube/config` (git-ignored, mode 600). kind,
  kubectl and Helm are always called with it and with `--context kind-webflix`; **nothing in
  this repository reads or modifies `~/.kube/config`**.
- `up.sh` refuses to run unless that context resolves to the API server published by the
  `webflix-control-plane` container, and every script refuses cluster names not starting with
  `webflix`.
- To use kubectl or k9s on the cluster:

```sh
export KUBECONFIG=$(make -s k8s-kubeconfig)     # this shell only
kubectl get pods -n webflix
k9s -n webflix
```

### Targets

| Target | |
| --- | --- |
| `k8s-up` / `k8s-redeploy` / `k8s-media` | converge everything (`NODES=1\|3`, `VARIANT=production\|conformance`) / rebuild and roll what changed / upload media and re-seed |
| `k8s-down` | delete the cluster (node containers and their volumes) and its kubeconfig |
| `k8s-clean` | `k8s-down` plus the `webflix-api`, `webflix-web`, `webflix-tools`, `webflix-recs`, `webflix-media-tools` images |
| `k8s-pipeline-smoke` | the whole recommendation pipeline at smoke size as a Job against the bucket (`sim/` prefix), then the importers (§9.6) |
| `k8s-recs-demo` | a demo recommendation run for the demo account's profiles (Top Picks on screen before the pipeline has a fresh run), published into the bucket and imported by a one-off Job made from the import step; `REPLACE=1` over a fresh pipeline run (docs/RECOMMENDATIONS.md, "A demo run") |
| `k8s-status`, `k8s-logs C=api`, `k8s-restart C=api` | inspect, follow logs, zero-downtime restart |
| `k8s-ownership`, `k8s-test-drift` | fields of the release owned outside Helm; the hot-patch → redeploy scenario (need Node) |
| `k8s-psql`, `k8s-valkey-cli` | shells into the in-cluster data stores |
| `k8s-lint`, `k8s-test` | chart lint + schema validation; plus template unit tests |
| `k8s-test-web`, `k8s-test-pg-tls` | the web image's nginx rules in a container; the API image against a TLS-only PostgreSQL with a private CA |
| `k8s-verify`, `k8s-chaos TARGET=valkey\|postgresql MODE=delete\|crash` | end-to-end checks and failure injection (need Node) |
| `k8s-outage TARGET=… OUTAGE_SEC=45`, `k8s-partition MODE=heal\|lost`, `k8s-spread` | failure injection that takes a node away, and the spread over zones: **three-node cluster only** |
| `k8s-rotate-media-key STEP=add\|promote\|retire` | two-phase media token key rotation (§5) |
| `smoke TARGET=k8s` | the conformance suite (`tools/smoke`) |

`k8s-down` leaves: the Webflix images (so the next `k8s-up` is fast; `k8s-clean` removes them),
the BuildKit cache (`docker buildx prune` if you need the space; it is shared with other
projects, so it is never pruned automatically), and pulled base images (`kindest/node`,
`node`, `alpine`, `nginx-unprivileged`, `postgres`, `valkey/valkey`, `dxflrs/garage`,
`python`, `ghcr.io/astral-sh/uv`, `quay.io/keycloak/keycloak`, `axllent/mailpit`, and the
`helmunittest`/`kubeconform` tool images used by `k8s-test`).

## 3. How the deployment behaves

### Routing

One `HTTPRoute` (Gateway API v1): `/api`, `/media`, `/cdn`, `/dev-idp`, `/_pay` →
`webflix-api:80`, everything else → `webflix-web:80`. Request timeouts: API 60 s, media 300 s, web 30 s.

**The web app** serves hashed `/assets/*` as `immutable`, the shell (`/`, `/index.html` and
every client-side route requested as a page load) as `no-cache`, and other files for an hour. A
missing file is a `404` problem document with `Cache-Control: no-store`, never the HTML shell:
anything under `/assets/`, and any path whose last segment has an extension unless it is a page
load (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` from older clients); the Cloudflare
Worker applies the same rule. `deploy/docker/web/test.sh` (`make k8s-test-web`) checks all of
this against the image in a container.

**The staff console** (`apps/admin`) is served by the same web image under `/admin/`, with its
own index and policy: `/admin` redirects to `/admin/`; `/admin/assets/*` are `immutable` and a
missing one is a `404` problem (never HTML, also as a page load); any other `/admin/*` page load
gets the console's `index.html` (never the member app's), and `index.html` and `config.json` are
`no-store`. `/admin/config.json` (`{issuer, clientId, scope}`) is written by the chart, not taken
from the build: the issuer is the staff API's (`config.staff.issuer`, the in-chart Keycloak's
realm), else outside production the development issuer at `/dev-idp/staff`; production without
a staff issuer answers `503` with a problem saying so, as the Worker does. The console has its
own CSP, **the same as the Worker's** (`web.admin.contentSecurityPolicy` and the template
`webflix.console.csp`; `consoleContentSecurityPolicy` in `apps/edge/src/console-policy.ts`):
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self';
font-src 'self'; connect-src 'self' <issuer origin>; manifest-src 'self'; media-src 'none';
worker-src 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none';
form-action 'self'`, the issuer's origin added whenever the issuer is a URL (Keycloak:
`https://webflix-keycloak:8443`), none for the development issuer's path. `frame-src 'none'`
matters: without it frames fall back to `default-src 'self'`. A test in
`apps/edge/test/node/security-headers.test.ts` renders the chart with Helm (development, production
without an issuer, an issuer on another origin, the chart's Keycloak) and holds each to the
Worker's function, as the member app's policy already was. Besides it: `Referrer-Policy:
no-referrer`, `Permissions-Policy` with `payment=()`, `X-Frame-Options: DENY` (stricter than the
Worker, which keeps the member app's other headers under `/admin/*`). Both files are mounted from
the `<release>-web-admin` ConfigMap (kept apart from the web ConfigMap, whose `add_header` lines
the Cloudflare tooling parses), and its checksum rolls the web pods. The image builds the console
with `apps/edge/src/console-policy.ts` copied in (its Vite config imports it). Proved: on the
conformance variant the console signed `staff-admin` in through the development issuer in a
headless Chromium; and on the **production configuration** (2026-11-23) through the in-chart
Keycloak, with nothing changed on the host: the test browser alone was given
`--host-resolver-rules=MAP webflix-keycloak 127.0.0.1` (a `kubectl port-forward` of
`svc/webflix-keycloak` on 127.0.0.1:8443) and told to accept the chart's private CA inside its own
context (`ignoreHTTPSErrors`). The console sent the browser to
`https://webflix-keycloak:8443/realms/webflix/protocol/openid-connect/auth` with `client_id=webflix-admin`,
`code_challenge_method=S256` and `redirect_uri=http://localhost:8080/admin/auth/callback`; after
Keycloak's login form it exchanged the code at the token endpoint (200, cross-origin, allowed by
the client's web origin), and showed "Signed in as Staff Admin, with the role Admin"; Members
loaded; no console error, failed request or CSP violation. `make k8s-test-web` checks every
serving rule above in a container.

**The development stand-ins' prefixes.** `/dev-idp` and `/_pay` also go to the API, in every
environment: outside production it serves the development OpenID issuer there and, with the
fake provider, its payment form; in production it answers a 404 problem for both, as the
Worker does. Until 2026-11-23 the chart routed them only outside production, so in production
they fell to the web app, whose SPA fallback answered a 200 HTML page for `/_pay/api/cards`
(the conformance check `billing.provider-config` caught it).

**Ops endpoints are on their own listener.** `/healthz`, `/readyz`, `/dependencies` and
`/metrics` are served on port 4001 (`ops`), never on the public port 4000: the HTTPRoute only
targets port 80, the NetworkPolicy admits the gateway to port 4000 only, and the public listener
answers 404 for those paths however they are spelled (percent-encoded, dot segments,
`/api/%2e%2e/metrics`), so a gateway that routes on the raw prefix cannot expose them either.
nginx answers 404 for them too, never the app shell. Envoy Gateway policies (rendered only
when its CRDs exist):

- `BackendTrafficPolicy`: retries only `connect-failure`, `refused-stream` and
  `reset-before-request` (requests that never reached a pod, safe for POSTs); upstream
  connection idle timeout 60 s, below the backends' 65 s keep-alive (otherwise Envoy can write a
  request on a connection the backend is closing, a 503 during rollouts; observed, then fixed).
- `ClientTrafficPolicy`: `X-Request-Id: PreserveOrGenerate`, so one id flows from the browser
  through Envoy's access log to the API's log lines. Envoy Gateway's path normalization is left
  at its defaults: a path that cannot be normalized (an encoded NUL, `%00`) is refused by Envoy
  with an empty `400` (`path_normalization_failed` in its access log) before any backend sees
  it, and `%2F`/`%5C` are answered with a `307` to the unescaped path. The API itself answers
  `404` for such keys; nothing reaches a store either way.

**Client IP.** The API trusts `X-Forwarded-For` counted from the right
(`config.trustedProxyHops`, default 1 = Envoy, which appends the peer address). Anything a
client sends itself is ignored: 14 sign-in attempts through the gateway with
`X-Forwarded-For: 1.2.3.N`, N different each time, gave 10 × 401 then 429. Add one hop per load
balancer in front of the gateway.

### Access logs

Every log the chart produces is a container log on stdout (JSON lines), so what one holds is
decided where it is written:

- **Envoy** (the platform's `EnvoyProxy`, `deploy/kind/gateway.yaml`, not this chart): the path
  **without its query string** (`%PATH(NQ)%`), method, status, flags, sizes, duration, upstream,
  route and request id. Queries carry what members search for (`/api/v1/search?q=`), the
  addresses staff look up (`/api/admin/v1/members?q=`), export download tokens and OpenID codes
  and states; none of that is needed to operate a gateway. **No client address and no user
  agent**: the request id correlates a line with the API's own, and the API decides what it
  keeps (rate limits key on addresses in Valkey, with their expiry, and nothing logs them).
  Signed media URLs carry the playback token in the path, so `/media/*` lines carry
  `/media/[redacted]` instead (CEL `matches` select one of two JSON formats; measured earlier: a
  real 199-character token appeared in 0 gateway lines). On another gateway, do the same.
- **nginx** (web): `$uri` (the path without its query, after nginx's normalisation), status,
  sizes, duration, request id; no address, no user agent.
- **The API and workers**: the route pattern (`/media/:token/vod/…`), status, duration, request
  id; no address, no user agent, no query.
- **PostgreSQL**: statements slower than 1 s (`log_min_duration_statement`) **without their
  parameter values** (`log_parameter_max_length=0`, and `…_on_error=0` for failed statements):
  the statement text has only placeholders, so neither a slow member lookup nor a failed insert
  writes an address or a token to the log. `SHOW` in the cluster: `1s`, `0`, `0`.

Proved on the conformance variant (2026-11-23): a distinctive search word sent as
`/api/v1/search?q=<word>` and an address looked up by staff (`/api/admin/v1/members?q=<address>`)
appeared in **none** of the 24 containers' logs (16 408 lines: Envoy, web, API, workers,
PostgreSQL, Valkey, Garage, the pipeline's Jobs); the gateway's line for the search reads
`"path":"/api/v1/search"`, without a query, address or user agent.

**Retention.** These are container logs: the kubelet rotates them (10 MiB × 5 files per
container by default) and they go with the pod. A cluster's log pipeline (Loki, a cloud's
agent) keeps them as long as it is told: keep them no longer than operating needs (days, not
months), and never longer than the 13 months behaviour events are kept. Keycloak's own log
(production configuration): a staff sign-in through the console and the four sign-ins of `make
k8s-test-keycloak` left no line naming the user or an address (36 lines in those minutes,
startup and realm messages); failed attempts were not tried, and Keycloak's logging listener is
documented to report failed logins at `WARN` with the username and address, so treat its log as
a staff security log with the same retention. Mailpit, on kind only, holds whole messages, reset links
included, by design: never enable `mailcatcher` outside a test cluster.

### Shared state across replicas (Valkey)

Every adapter passes its `@webflix/core/testing` contract suite against a real Valkey
(`pnpm --filter @webflix/adapters-node test:services`), with a manual clock (so expiry cases
run) and with the server clock.

- **Atomic server-side.** The rate limiter (GCRA, same arithmetic as the in-memory one) and the
  stream gate (one hash per account) are Lua scripts: two replicas racing for the last stream
  slot cannot both win (tested with 24 concurrent acquires from 4 connections, limit 2).
- **One clock.** Scripts read Valkey's `TIME`, so leases and windows never depend on pod clock
  skew. Expiry stored in keys is garbage collection only; correctness comes from timestamps.
- **Job queue** = Valkey Streams with a consumer group: delayed jobs in a sorted set promoted
  when due; ack / retry / dead-letter is one Lua script (no loss or duplicate between ack and
  requeue); a delivery held by a dead consumer is reclaimed (`XAUTOCLAIM`, 60 s) as the next
  attempt, so a job that crashes workers is dead-lettered after 5 attempts instead of looping;
  long jobs refresh their claim. The API only publishes; the `worker` Deployment consumes and
  runs the scheduler (idempotent, so several workers are fine).
- **Failures.** The client reconnects forever with capped backoff. A command issued during a
  blip is queued for up to 2 s; once Valkey has been unreachable for over a second, commands
  for requests fail at once. Either way the request answers `503 service_unavailable` with
  `Retry-After` (never hangs), and so does a full Valkey (`noeviction` refuses writes with OOM).
  The catalogue cache fails open (browse keeps working from PostgreSQL). Valkey is not part of
  readiness (next section).
- **Durability.** AOF `everysec`: leases, rate-limit state and queued jobs survive a restart
  (≤ 1 s of writes at risk on a crash); `maxmemory-policy noeviction` because evicting a lease or
  a queued job would be silent corruption; size `valkey.maxMemory` with headroom and alert on it.

### Readiness and dependency health

`/readyz` answers one question: would removing *this pod* from the endpoints help? It is
process-local: **started** (since boot, this process has reached PostgreSQL with the schema
current and Valkey, and has opened its pool's warm minimum, `api.databasePoolMin`, so a pod that
cannot work yet takes no traffic and a ready one serves a burst from open connections; the
monitor refills the minimum after a loss), **not draining**, and an
**event loop** that is not wedged (p99 lag under 5 s). A shared dependency going down later does
not make pods unready: every replica would fail together, the endpoint set would empty and the
gateway would answer 503 for everything, including what works without that dependency. Instead,
requests that need it fail fast on their own.

The outage stays visible: every API and worker process probes PostgreSQL, Valkey and the bucket
every 5 s and exports `webflix_dependency_up{dependency}` and
`webflix_dependency_probe_seconds{dependency}` on `/metrics`, plus `/dependencies` on the ops
port (JSON detail, `503` when degraded). Alert on those, not on readiness.

Measured with `make k8s-outage TARGET=valkey|postgresql OUTAGE_SEC=45`: the store's pod is
deleted while its node is cordoned, so the replacement stays Pending for 45 s (its volume is
bound to that node), as when a pod is rescheduled and waits for its volume; probing every
500 ms; the script also fails if an API or worker process restarts. It touches no release
object (a node is not one):

| Dependency down 45 s | API pods Ready | Kept working | Failed | Recovery |
| --- | --- | --- | --- | --- |
| Valkey | all, throughout | web, plans, signed segments (206), artwork, browse | heartbeats: `503` + `Retry-After: 5` within 45 ms | automatic, first probe after Valkey was back |
| PostgreSQL | all, throughout | web, plans, signed segments, artwork | browse, heartbeats: `503` + `Retry-After: 5` within 5 s (the connect timeout) | automatic, first probe after PostgreSQL was back |

### Startup order and migrations

No Helm hooks: everything is a normal resource, so `helm upgrade --wait` sees the whole picture
and GitOps controllers can apply the rendered manifests (they also need every credential as an
`existingSecret`; see Security).

1. Data stores start (StatefulSets).
2. `webflix-migrate-<revision>` waits for PostgreSQL (`wait --skip-migrations`), migrates
   (Kysely's lock makes concurrent runs safe).
3. API and worker pods wait in an init container (`webflix-api wait`) until the schema is
   current and Valkey answers; during an upgrade the previous pods keep serving meanwhile, so
   migrations must be backward compatible (expand, then contract).
4. `webflix-seed-<revision>` waits for the schema and the bucket, seeds from
   `blob:manifests/media.json` (idempotent: skipped in milliseconds when nothing changed).

**Rollback contract.** Every release's schema changes must be backward compatible with the
release before (expand, then contract in a later release), because pods of both run against the
same schema during an upgrade and after a rollback. `helm rollback` re-runs the older release's
migrate Job against a database that already has the newer release's migrations; `migrate`
accepts exactly that case (every known migration applied, the unknown ones all newer) and logs
`db.schema_ahead` as a warning; an unknown migration in the middle of the history still fails.
Exercised on kind with a newer migration recorded in the database: rolling back to a revision
built before this fix failed (`corrupted migrations: previously executed migration
9999_added_by_newer_release is missing`, the release went `failed`); rolling back to a fixed
revision succeeded in 27 s with the warning.

### Rollouts and shutdown

`maxUnavailable: 0`; readiness on `/readyz`; on SIGTERM the API fails readiness, keeps serving
`api.shutdownDelaySec` (5 s) while the endpoint leaves Envoy, then drains (grace 40 s). nginx
gets a 5 s `preStop` sleep and its image stop signal (SIGQUIT, graceful). PDBs keep at most one
API/web pod out during node drains. Under a steady 16-client mix (shell, assets, public and
authenticated API, playlists, Range requests, heartbeats), API and web rolled out together
twice through the release (`make k8s-verify`: an upgrade that changes a pod annotation, then its
rollback): **0 failed** (132 316 requests at 1 500 req/s, p99 49 ms; an earlier run while other
workloads loaded the machine: 52 168 requests, p99 165 ms).

### Failure injection (measured, `make k8s-chaos`)

Probing every 250 ms through the gateway while 16 clients keep every API pod busy with
database- and Valkey-backed requests; the web app never failed in any case. The script fails if
any API or worker process restarts.

| Event | What users see | Recovery |
| --- | --- | --- |
| Valkey pod deleted | heartbeats (stream gate) answer 503 for ~7 s; browse, sign-in pages and media keep working | automatic; no restart; stream leases intact (a second screen still refused) |
| Valkey container SIGKILLed | heartbeats 503 for ~2.5 s | automatic; leases intact (AOF) |
| PostgreSQL pod deleted (4 runs) | database-backed requests answer `503` + `Retry-After` for 1 to 6 s (3 to 12 % of the background load); web and plans never fail | automatic; no API or worker restart |
| PostgreSQL container SIGKILLed | 503 + `Retry-After` for ~1 s (2 % of the background load) | automatic; no restart |
| Worker at 0 replicas (through the release) / force-killed | nothing visible; jobs wait in Valkey | drained by the next worker; no job lost |

Three bugs found this way are fixed in `packages/db`: an unhandled pool `error` event that
crashed every API pod when PostgreSQL restarted; connection attempts without a timeout that hung
requests for a minute while the database pod was replaced; and, on a graceful PostgreSQL
shutdown (pod deletion, node drain, a managed database's failover), `57P01 terminating
connection` reaching a client lent out between two statements, an unhandled `error` event that
ended the process (4 to 5 of 5 API pods restarted per run under load before the fix, none in
the 4 runs since).

### PostgreSQL gone without a goodbye

A pod deletion closes connections; a node failure or a network partition does not, and a
server that is gone cannot apply its own `statement_timeout`. Each process therefore bounds its
statements client-side too, by role (`docs/BACKEND.md` §6): the API 5 s on the server and 7 s
on the client, the worker 60 / 65 s, migrate and seed 10 min / 10 min 5 s; a statement that
times out client-side fails as unavailable (503 + `Retry-After`) and its connection is
destroyed. Measured with `node deploy/kind/verify/partition.ts heal|lost` (every packet to and
from the PostgreSQL pod's IP dropped on its node; 16 clients of load; requests through the
gateway and straight to one API pod):

| Scenario | Before (no client-side bound) | Now |
| --- | --- | --- |
| Partition for 60 s, then lifted | requests on pooled connections hung: `504` from the gateway at 60 s, 108 s straight to the pod | every request answered within 7.3 s, all `503` + `Retry-After`, no `504`; API connections released 9 s after the cut; recovered 0.1 s after the lift |
| Host lost, PostgreSQL replaced on a new IP after 9 s | 38 connections stuck until TCP gave up, the last 15 min 47 s after the cut; meanwhile 9 to 25 % of database requests answered `503` (the pod whose pool they filled answered nothing else) | longest wait 9.0 s (`503`); API connections released 9 s after the cut (the worker's one at its 65 s budget); recovered as soon as the replacement was Ready |

No API or worker restart in any run. `tcpKeepalive` (below) also notices a dead *idle*
connection after 40 s instead of ~11 minutes.

### Security

Pod Security `restricted` is enforced on the namespace. Every first-party container runs as a
non-root UID with a read-only root filesystem, no privilege escalation, all capabilities
dropped, `RuntimeDefault` seccomp, and no service-account token. NetworkPolicies: the gateway
namespace reaches the API's public port (`:4000`) and web (`:8080`) only; the monitoring
namespace reaches the ops port (`:4001`) and Garage's admin port; only API, worker and the Jobs
reach PostgreSQL, Valkey and the S3 API (the `helm test` pod reaches the API and web, not the
data stores); web and the data stores have no egress at all; app egress is limited to DNS and
the in-chart stores (add rules for external services). DNS egress allows port 53 to any
destination by default, which works with kube-dns pods and with NodeLocal DNSCache (a link-local
address on the node); narrow it with `networkPolicy.dns.to`.

**A missing environment fails closed.** `WEBFLIX_ENV` decides whether the development
stand-ins (the issuer at `/dev-idp`, the fake provider's `/_pay`, the diagnostics routes) are
mounted. The API and tools images set `WEBFLIX_ENV=production` themselves (`deploy/docker/Dockerfile`),
so a container started without the chart's ConfigMap (a stray `docker run`, a Job written by
hand, a ConfigMap that failed to mount) is production, never development; the chart always sets
it from `config.environment`, and everything that wants development says so (the conformance
variant's values, `deploy/kind/verify/pg-tls.sh`). The choice is the image default rather than a
refusal to start, because production is the only safe reading of "nobody said" and the chart
never leaves it unset.

Credentials are never in values or ConfigMaps: the chart generates them on first install
(`lookup`, kept across upgrades and on uninstall with `helm.sh/resource-policy: keep`, because
the data stores initialise from them) or uses `existingSecret`s. Nothing secret is committed.
`lookup` needs a live cluster: rendered by `helm template` (Argo CD, Flux post-renderers) it sees
nothing and generated passwords would change on every sync, so the chart **fails** in that case
unless every credential comes from an `existingSecret` (`secrets.existingSecret`,
`postgresql.auth.existingSecret`, `valkey.auth.existingSecret`, `objectStore.auth.existingSecret`,
or external services). Under GitOps those are mandatory; `secrets.generateWithoutCluster=true`
exists only for throwaway renders such as CI schema checks. Pod templates carry a checksum of the
secrets they read, so a `helm upgrade` after a rotation rolls the pods.

## 4. Values reference

`values.yaml` holds production-leaning defaults; `deploy/kind/values.yaml` shrinks resources,
adds CPU limits, picks the kind GatewayClass and turns on Keycloak, the mail catcher and the
pipeline; `deploy/kind/values-conformance.yaml` is the conformance variant (§9.2).
`values.schema.json` rejects typos and malformed values (e.g. `api.replica`,
`rateLimits.auth: lots`, `config.billing.paymentProvider: paypal`).

| Key | Default | |
| --- | --- | --- |
| `config.publicOrigin` | derived from `httpRoute.hostnames[0]` + TLS, else `http://localhost:8080` | https makes cookies `Secure`/`__Host-` and adds HSTS |
| `config.environment` | `production` | refuses the development media key |
| `config.rateLimits` | `{}` = the strict defaults | map of policy name → `"limit/windowSec"`; any policy, current or future (`email-lookup` or `emailLookup` → `WEBFLIX_RATE_LIMIT_EMAIL_LOOKUP`) |
| `config.trustedProxyHops` | `1` | proxies appending to `X-Forwarded-For` |
| `secrets.existingSecret` | generated | Secret with `WEBFLIX_MEDIA_TOKEN_KEYS` (`id:secret[,…]`, first signs, all verify; rotate in two phases, §5) |
| `secrets.generateWithoutCluster` | `false` | allow generated credentials under `helm template` (throwaway renders only) |
| `tls.extraCaCerts.{secretName,configMapName,key}` | none | private CAs for PostgreSQL / Valkey TLS / an S3 endpoint (`NODE_EXTRA_CA_CERTS`) |
| `api.autoscaling.{min,max}Replicas` | 3 / 12 | CPU 70 % |
| `api.databasePoolMax` | 10 | per pod; keep (max API + workers + 2) × pool < `postgresql.maxConnections` (200) |
| `api.databasePoolMin` | 4 | connections each API pod keeps open however idle, opened before it reports ready (K17) |
| `config.databaseTimeouts.{request,background,maintenance}.{statementMs,queryMs}` | the roles' budgets: 5000 / 7000 (API), 60000 / 65000 (worker), 600000 / 605000 (Jobs) | server-side statement timeout / client-side bound (ms, 0 = none); `queryMs` must exceed `statementMs`, else the chart refuses to render |
| `config.databaseKeepAliveMs` | `null` = 10000 | TCP keepalive's first probe on database connections (0 = off) |
| `tcpKeepalive.{intervalSec,probes}` | 10 / 3 | `net.ipv4.tcp_keepalive_intvl` / `_probes` in the API, worker and Job pods (namespaced safe sysctls, allowed by Pod Security `restricted` since 1.29; checked on kind 1.37); `null` sets none |
| `api.shutdownDelaySec` / `terminationGracePeriodSeconds` | 5 / 40 | grace ≥ delay + 30 |
| `worker.replicas` / `worker.concurrency` | 2 / 4 | consumers share the queue |
| `web.contentSecurityPolicy` | same-origin, `https:` for media/XHR (external HLS fallback) | mounted over the image's default |
| `web.admin.{clientId,scope,contentSecurityPolicy}` | `webflix-admin`, `openid profile email`, the console's own policy | the staff console at `/admin/` (§3, Routing): its `config.json` and CSP; the staff issuer's origin is added to `connect-src` by the chart |
| `seed.demo` / `seed.manifest` | `false` / `blob:manifests/media.json` | the documented demo account; the kind values turn it on |
| `gateway.enabled` / `gateway.className` | `true` / `eg` | or `false` + `httpRoute.parentRefs` for a shared Gateway |
| `gateway.tls.{enabled,secretName,certManager.issuer,redirectHttp}` | off | HTTPS listener, cert-manager annotation, 301 from HTTP |
| `httpRoute.hostnames`, `httpRoute.timeouts.{api,media,web}` | `[]`, 60s/300s/30s | |
| `postgresql.enabled`, `valkey.enabled`, `objectStore.enabled` | `true` | `false` switches to `external*` |
| `*.persistence.{size,storageClass}` | 10Gi / 2Gi / 20Gi | |
| `valkey.maxMemory` / `valkey.resources.limits.memory` | `512mb` / `1152Mi` | keep the limit ≥ 2 × maxMemory + 128 Mi: an AOF rewrite forks, and copy-on-write can duplicate every page written meanwhile |
| `networkPolicy.enabled`, `.gateway.namespaceSelector`, `.egress.{restrict,extraRules}`, `.dns.to` | on, `envoy-gateway-system`, restricted, any destination on :53 | |
| `metrics.serviceMonitor.enabled` | `false` | Prometheus Operator; `prometheus.io/*` annotations otherwise |
| `image.registry`, `api.image.digest`, `web.image.digest` | | pin by digest in production |
| `config.identity.{oidcProviders,google,apple,keycloak}` | unset: the application's defaults | consumer issuers (`WEBFLIX_OIDC_*`); client secrets and Apple's key through `secrets.envFrom` |
| `config.email.{sender,from,smtp,http}` | `smtp` to the catcher with `mailcatcher.enabled`, else the application's (`memory`) | `WEBFLIX_EMAIL_*`, `WEBFLIX_SMTP_*` (host, port and `tls: none` derived for the catcher); the SMTP password and HTTP key through `secrets.envFrom`. `outbox` with `config.environment: production` (also through `config.extraEnv`) is refused at render: the API refuses to start with it (it stores every message, reset links included, and delivers nothing) |
| `config.billing.{paymentProvider,graceSec,fake.*}` | unset: `none` in production (checkout answers `503 payments_not_configured`), `fake` elsewhere | `stripe` also adds Stripe.js's origins to the web app's CSP (§9.10); Stripe's keys through `secrets.envFrom` |
| `config.events.{sink,consentMode,exportEvents,deletionCoolingOffSec,retentionDays,aggregatesRetentionDays,exportLinkTtlSec,exportTypicalSec,release}` | `sink` and `exportEvents`: `lake` and `batch` when the lake is looked after (`pipeline.enabled` with its erase, exportEvents and retain jobs, or `pipeline.external`), else `memory` and `inline`; the app's for the rest; `release` = the API image's tag | `WEBFLIX_EVENT_SINK`, `WEBFLIX_CONSENT_MODE`, `WEBFLIX_EXPORT_EVENTS`, …, `WEBFLIX_EXPORT_TYPICAL_SEC` (what the privacy page tells a member an export takes), `WEBFLIX_RELEASE` (server events' `app.version`). `lake` or `batch` with nothing to look after them is refused at render (§9.6). The two retention periods reach the pipeline's `retain` through the same ConfigMap |
| `config.recommendations.{store,defaultPolicy,exploreShare}` | `database`, the app's (`defaultPolicy`: `rules` with `config.environment: production`, so the default kind release serves the rule engine to members no experiment assigns; the conformance variant, `development`, serves `learned`) | `WEBFLIX_RECOMMENDATION_STORE`, `WEBFLIX_RECS_*`. To serve learned pages in production (the default kind release included): `--set config.recommendations.defaultPolicy=learned` (or `deploy/kind/release.sh reapply --set …`); members then get the published run's pages, the rule engine where no run covers them |
| `config.staff.{verifier,issuer,algorithms}` | `oidc` + the in-chart realm with `keycloak.enabled`, else the app's (`memory` in production: closed) | `WEBFLIX_STAFF_*`; the issuer must be https in production |
| `secrets.appExistingSecret` | generated | `WEBFLIX_PSEUDONYM_KEY` (never replaced: kept on uninstall), and outside production `WEBFLIX_DEV_IDP_SECRET` and `WEBFLIX_PAYMENTS_FAKE_WEBHOOK_SECRET`, shared by every replica |
| `secrets.envFrom` | `[]` | names of Secrets whose keys become environment variables (provider credentials) |
| `keycloak.{enabled,hostname,realm,tls.secretName,database.*,demoStaff}` | off; `https://<fullname>-keycloak:8443`; `webflix`; a generated CA and certificate; the in-chart PostgreSQL; off | §9.4 |
| `mailcatcher.enabled` | off | Mailpit (§9.5); local clusters only |
| `pipeline.enabled`, `.image`, `.tools.image`, `.store`, `.staffApi.{url,tokenUrl,clientId,existingSecret}` | off; `webflix-recs`, `webflix-tools`; `s3://<bucket>`; the API's Service, Keycloak's or (outside production) the development issuer's token endpoint, `webflix-jobs` | §9.6; a production pipeline that cannot get a staff token refuses to render |
| `pipeline.lake.{serialize,schedule,compactEveryMinutes,eraseEveryHours}` | `auto` (serialised with the in-chart Garage), `*/5 * * * *`, 60, 24 | the lake round (§9.7) |
| `pipeline.jobs.{compact,erase,exportEvents,retain,analyse,trainAndScore}.{enabled,schedule,graceMinutes}` | hourly at :20, daily, every 5 min (grace 15), daily at 03:50, daily, daily | the separate CronJobs with a store that honours conditional writes; with the lake round only `enabled` and the graces apply (retain runs once a day in the round) |
| `pipeline.external` | `false` | `true` declares that your own scheduler runs erase, export-events and retain against the lake: the chart then allows `config.events.sink: lake` without its pipeline |
| `pipeline.extraEnv` | `{}` | e.g. `WEBFLIX_RECS_GATE_CUTOFFS` (the publish gate's weekly backtests, default 3) |

### External managed services

```yaml
postgresql: { enabled: false }
externalDatabase:
  url: postgres://webflix@db.example.internal:5432/webflix?sslmode=require   # no password
  existingSecret: webflix-db            # key `password` → PGPASSWORD
  # clientCertSecret: webflix-db-client # mutual TLS; add &sslcert=/etc/webflix/tls/database/tls.crt&sslkey=/etc/webflix/tls/database/tls.key
tls:
  extraCaCerts:
    secretName: rds-ca-bundle           # e.g. Amazon's global-bundle.pem under key ca.crt
valkey: { enabled: false }
externalValkey:
  url: rediss://cache.example.internal:6380/0   # standalone / primary endpoint, TLS
  existingSecret: webflix-cache         # key `password` → WEBFLIX_VALKEY_PASSWORD
objectStore: { enabled: false }
externalS3:
  region: eu-west-1
  bucket: acme-webflix-media            # must exist
  # existingSecret with access-key-id / secret-access-key, or none to use the pod identity:
serviceAccount:
  annotations: { eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/webflix-media }
networkPolicy:
  egress:
    extraRules:
      - to: [{ ipBlock: { cidr: 10.20.0.0/16 } }]
        ports: [{ port: 5432, protocol: TCP }, { port: 6380, protocol: TCP }]
      - to: [{ ipBlock: { cidr: 0.0.0.0/0 } }]
        ports: [{ port: 443, protocol: TCP }]
```

**TLS to managed services.** node-postgres treats `sslmode=require` as `verify-full`: the
server certificate must chain to a trusted CA and match the host name. Managed databases (RDS,
Cloud SQL, Azure) use private CAs that are not in Node's trust store, so without
`tls.extraCaCerts` the connection fails with "unable to verify the first certificate". The
bundle is mounted into the API, worker, Jobs and init containers and passed as
`NODE_EXTRA_CA_CERTS`, which every TLS client in the process honours, so the same setting
covers `rediss://` Valkey and an https S3 endpoint with a private CA. `make k8s-test-pg-tls`
proves it against a TLS-only PostgreSQL 19 whose certificate comes from a throwaway private CA:
without the bundle the API image fails with that error (or "self-signed certificate in
certificate chain" when the server sends its CA too), plaintext is refused by the server, and
with the bundle `wait` succeeds and `migrate` runs over TLS. Client certificates (mTLS) go in
`externalDatabase.clientCertSecret` and are referenced from the URL (`sslcert=`/`sslkey=` under
`/etc/webflix/tls/database`); the same check logs in as a certificate-only role with them and is
refused without. Do not use
`sslmode=no-verify` or `uselibpqcompat=true&sslmode=require` to get around it.

`deploy/helm/webflix/ci/external-values.yaml` is a complete example (TLS, cert-manager,
ServiceMonitor) and is rendered and schema-validated by `make k8s-lint`. Upload media to the
external bucket with the media tool: `WEBFLIX_S3_*=… node tools/media/src/cli.ts upload
--profile full --target s3:`; any `helm upgrade` then re-seeds with it.

Valkey must be a standalone/primary endpoint (keys are hash-tagged, but the client does not
speak Cluster mode) with persistence enabled and `noeviction`. A Garage or other self-hosted
store needs `externalS3.endpoint` and `forcePathStyle: true`.

## 5. Operations

- **Scale:** the API and web autoscale; the worker through the release (`worker.replicas`;
  on kind `deploy/kind/release.sh reapply --set worker.replicas=N`). A `kubectl scale` of a
  release object leaves `.spec.replicas` owned outside the release (see Field ownership, §2).
  The data stores are single instances by design (see §8).
- **Roll out:** `helm upgrade` (or `make k8s-redeploy`); `make k8s-restart C=api` restarts
  without a change. A failed upgrade leaves the previous ReplicaSet serving (`maxUnavailable:
  0`). `helm rollback webflix <rev> --wait --wait-for-jobs` works across a release that added
  migrations, as long as migrations follow the rollback contract (§3).
- **Rotate the media token key** without breaking playback: every pod signs with the first key
  and verifies with all of them, so a new key must be known everywhere before anyone signs with
  it. `make k8s-rotate-media-key STEP=add` (append, verify-only, roll), then `STEP=promote`
  (move it first, roll), then after the token lifetime (`config.mediaTokenTtlSec`, 6 h)
  `STEP=retire`. Each step edits the Secret's value (under its own field manager,
  `webflix-rotate-media-key`) and upgrades the release with its current values: the Secrets'
  checksum in the pod templates rolls the API and the worker. With `secrets.existingSecret`,
  make the same three edits to that Secret and `helm upgrade` after each. Measured under playback load: putting the new key first in one step failed
  21 of 1 082 requests (`media_token_invalid` on playlists and segments during the rollout); the
  two-phase rotation failed none of 2 028 across both rollouts. The same keys sign the
  `webflix_device` cookie (a browser that signed in to an account before is exempt from the
  per-email sign-in limit): after `retire`, every browser whose cookie the retired key signed
  (in practice, nearly all of them) counts as unknown once, until its next successful sign-in.
  Members only notice it if someone is guessing at their account at that moment.
- **Dependency health:** `webflix_dependency_up{dependency}` on the ops port's `/metrics`;
  `kubectl port-forward deploy/webflix-api 4501:4001` then `curl localhost:4501/dependencies`.
- **Logs:** JSON lines everywhere; `make k8s-logs C=api|worker|web|seed`. Correlate with
  `requestId` (the same id is in Envoy's access log and the response's `X-Request-Id`). Queue
  depth: `webflix_jobs{state=stream|delayed|pending|dead}` on the worker's `/metrics`.
- **Dead letters:** `make k8s-valkey-cli` then `XRANGE webflix:{jobs}:dead - +`.
- **Backups:** `pg_dump` from `make k8s-psql`; Valkey's AOF and Garage's data are on their PVCs
  (`Retain` on delete). The media bucket can always be re-uploaded from `.cache/media`.
- **A restore brings erased members back.** A database backup is a copy of members as they
  were: an account erased after the backup was taken comes back whole with a restore (address,
  password hash, profiles, billing records, the audit entries that named it), and nothing in the
  restored database says it was ever erased. Two cases repair themselves: a deletion requested
  before the backup and completed after it is still pending in the restored database, and the
  scheduler erases it again on its next tick (erasure is idempotent); and the lake is in the
  bucket, not in the database backup, so its rewritten hours stay erased, while the pipeline's
  erasure plan (`recs-work/erasure/plan.json`) keeps removing late events of the last 30 days'
  pseudonymous keys. A deletion **requested after the backup** leaves nothing that survives the
  restore (the worker's `privacy.account_erased` log line carries the request id, deliberately
  not the account). So after restoring, before opening traffic, an operator must list the
  deletions completed between the backup's time and the restore from records kept outside the
  database (the support or legal log of requests, the payment provider's deleted customers,
  retained logs), make each again through the product's deletion path, and let the next lake
  round erase them. Keep backups only as long as that list can be rebuilt (a short rolling
  window, encrypted, access-restricted), prefer point-in-time recovery to the latest moment, and
  treat a restore to an older point as a privacy incident to be worked through. The app Secret
  (`WEBFLIX_PSEUDONYM_KEY`) is not in the database backup and must be backed up on its own: with
  a new key every subject key changes and the lake's erasures could no longer find anyone.

| Symptom | Look at |
| --- | --- |
| `k8s-up` stops at "Release" | it prints the failing pods' events and logs; `make k8s-status` |
| "The release was refused: it would overwrite fields changed outside it" (or Helm's `UPGRADE FAILED: conflict occurred while applying object … conflict with "<manager>"`) | someone changed a release object with kubectl; the message names the object, manager and field. `make k8s-redeploy` takes such fields back for the release (and lists them), unless `K8S_OWNERSHIP=strict`; or undo the change; `make k8s-ownership` shows everything owned outside Helm |
| API pods stuck in `Init:0/1` | `make k8s-logs C=api` shows `wait.waiting` with what is missing (schema, Valkey, bucket) |
| 503 from the gateway on /api | `kubectl get endpoints webflix-api`; a pod's `/readyz` (port 4001) says `starting`, `draining` or `unresponsive`; `/dependencies` shows which store is down |
| 503 + `Retry-After` from the API | a shared dependency is down: `/dependencies`, `webflix_dependency_up` |
| Titles play the external fallback | no `manifests/media.json` in the bucket: `make content`, then `make k8s-media` |
| 429 everywhere while testing locally | everyone shares one IP under strict limits: `make k8s-up RATE_LIMITS=relaxed` |
| Port 8080 or 4510 busy | `lsof -nP -iTCP:<port> -sTCP:LISTEN` |

## 6. Verification

| What | Command | Result |
| --- | --- | --- |
| Adapter contract suites vs real Valkey 9.2 and Garage 2.5 | `pnpm --filter @webflix/adapters-node test:services` | 132 passed (4 time-based cases skipped in server-clock variants; covered by the manual-clock variants), including Valkey full (OOM → 503) and fail-fast while down |
| S3 adapter against a stalled store | `pnpm --filter @webflix/adapters-node test` | never-answering store: every operation fails within its deadline as `service_unavailable`; a body stalled mid-transfer fails after the idle timeout; a slow reader is not mistaken for a stall |
| Two API "replicas" in one process | `pnpm --filter @webflix/api test:services` | stream limit, revocation, rate limits, blob manifests, readiness vs dependency health, the ops listener |
| Migrations after a rollback | `pnpm --filter @webflix/db test` (SQLite), `test:postgres` (PostgreSQL) | newer unknown migrations accepted with a warning; an unknown one in the middle, or a known one missing, refused |
| Milestone 2 on PostgreSQL | `pnpm --filter @webflix/db test:postgres` | 383 of 383 (2026-11-23, migrations to 0026): every area's repository contract (the admin log's erasure with `strpos` included), the recommendation store, migrations from empty and from a populated milestone 1 schema, schema equivalence (§9.8) |
| Chart | `make k8s-test` | `helm lint --strict` on 5 value sets (with the conformance variant); kubeconform (Kubernetes 1.37 + CRD schemas): 214 resources valid; 119 template tests (milestone 2: settings, the app Secret, the Stripe CSP and `Permissions-Policy`, the stand-ins' routes, the lake round and its retain step, train-and-score's steps, the jobs' token source, Keycloak's realm and mode, the mail catcher, the console's config and CSP, the lake refused when nothing looks after it, the outbox refused in production, NOTES, train-and-score's own budget, the importer's exit 3) and, in `apps/edge`, the console's policy rendered by Helm equal to the Worker's |
| In the cluster | `helm test webflix -n webflix` | ops `/readyz` 200 on `:4001` and 404 on the public port; plans, web shell, a missing asset 404 |
| Web image | `make k8s-test-web` | hashed asset `immutable`; missing `.js`/`.css`/`.png` 404 `no-store` problem, never HTML (also as a page load); deep links get the shell; the console under `/admin/`: its own index (also for deep links) and CSP, `no-store` index and `config.json`, immutable bundle, a missing `/admin/assets/*` a 404 (26 checks) |
| TLS to PostgreSQL | `make k8s-test-pg-tls` | private CA refused without `tls.extraCaCerts`, accepted with it; plaintext refused; client certificate login |
| Conformance, production configuration | `make smoke TARGET=k8s SMOKE_ARGS="--timeout 300000"` | 133 checks: 93 passed, 0 failed, 40 skipped (every milestone 1 check that can run passes; the milestone 2 skips and their reasons: §9.2). `media.invalid-key-paths` passes with Envoy refusing `%00` itself (400, §3 Routing) |
| Conformance and browsers, the variant | `make k8s-up VARIANT=conformance`, `make k8s-recs-demo`, `make smoke TARGET=k8s`, `make e2e TARGET=k8s` | 2026-11-23: 152 checks, 148 passed, 0 failed, 4 skipped; browsers 260 passed, 0 failed, 8 skipped on Chromium and Firefox with the console project (WebKit not run: screen locked). Every skip's reason and the earlier runs: §9.2 |
| Staff sign-in, email | `make k8s-test-keycloak`, `make k8s-test-smtp` (production configuration) | §9.4, §9.5 |
| Pipeline at smoke size | `make k8s-pipeline-smoke` | every step a workload against the bucket, the run imported (§9.6) |
| Lake lease on the bucket | §9.7's probe | Garage ignores `If-None-Match` and `If-Match`: 16 of 16 racers win |
| Journeys, jobs, rollout | `make k8s-verify` | every request attributed to its pod via `X-Request-Id` |
| Member accounts in the verify scripts | `deploy/kind/verify/lib.ts` `newAccount` | since the card fields left the API (2026-11-23) a member comes about only through a checkout at the payment provider: `newAccount` signs up `{email, password}`, checks out at the fake provider (`/_pay/api/confirm`, a labelled test card of its own) and selects a profile. On a production configuration (provider `none` or Stripe) no member can be made: the scripts that need one (`journey`, `jobs`, `rollout`, `chaos`, `outage`, `partition`, `rotation`) print `SKIP …` with that reason at their first `newAccount` and exit 0. The same holds for the conformance suite: on a run without the fake provider, 54 checks skip for want of a member account (besides the 23 that drive the fake provider), so the production-configuration figures above predate the change |
| Failure injection | `make k8s-chaos`, `make k8s-outage` | §3 tables |
| Key rotation under load | `node deploy/kind/verify/rotation.ts [naive]` | §5 |
| Hot-patched release object | `make k8s-test-drift` | `kubectl set image` on the API, then `up.sh` in each `K8S_OWNERSHIP` mode: strict stops before Helm (revision unchanged) naming `kubectl-set` and the field; off fails in Helm with the same explanation; take logs the field it takes back and deploys; the next strict deploy finds nothing |
| Field ownership | `make k8s-ownership` | only controllers' `status` entries besides Helm's |
| PostgreSQL partition / host loss | `node deploy/kind/verify/partition.ts heal\|lost` | §3: every request answered within 9 s (503 + `Retry-After`), no 504, recovery within a second of the database being back |

Rate limits on kind are the strict production values; because every local client shares one
address, `RATE_LIMITS=relaxed` switches to the documented relaxed profile (docs/BACKEND.md §3)
for e2e runs. Both are recognised by the smoke suite.

## 7. Footprint

Every Webflix container (init containers included) has CPU and memory requests and memory
limits; the kind values add CPU limits so the cluster can never take over the machine, and the
platform add-ons that ship without limits (metrics-server, Envoy's shutdown-manager) get them.
Kind's own system pods are left as kind ships them.

Idle steady state after the autoscalers settle (2 API and 2 web replicas), measured with
`docker stats` on the node containers and `kubectl top`, 2026-11-22:

| Cluster | Node containers | Memory | CPU |
| --- | --- | --- | --- |
| one node, production configuration (Keycloak, Mailpit, 1 worker) | `webflix-control-plane` | 3.3 GiB | 22 % of a core |
| three nodes, the same configuration | `webflix-control-plane` / `webflix-worker` / `webflix-worker2` | 1.5 / 1.3 / 1.0 GiB = 3.8 GiB | 15 + 9 + 6 % = 30 % of a core |
| one node, conformance variant (2 workers, no Keycloak or Mailpit) | `webflix-control-plane` | 2.5 GiB | 20 to 25 % of a core, about 90 % for the few seconds of each minute's lake round |

One node saves about 0.5 GiB and a third of the idle CPU (two kubelets, two kube-proxies and
two CNI agents fewer), and the API server's own memory (about 0.9 GiB on the control plane)
is the single largest item either way. The Webflix pods themselves use about 0.9 GiB together
in the production configuration: Keycloak about 470 to 500 MiB (the JVM: by far the largest),
PostgreSQL 90, Garage 60 to 75, API 55 each, worker 55, web 23 each, Mailpit 15, Valkey 12. A
pipeline Job adds 150 to 450 MiB while it runs (train-and-score's second phase at smoke size:
435 MiB). `make k8s-down` gives all of it back.

## 8. For a real production cluster

- **Data stores:** use managed PostgreSQL (or CloudNativePG with replicas and PITR), a managed
  Valkey/Redis with a replica and AOF (ElastiCache, Memorystore), and the cloud's object store
  with a CDN in front of `/cdn` (immutable) — the in-chart StatefulSets are single instances.
- **Media delivery:** put a CDN in front of `/media` segments (token in the path makes them
  cacheable per session) or move them to signed CDN URLs; serve the SPA from the CDN too and keep
  the previous release's `/assets` available during rollouts (a tab opened before a deploy may
  request chunks the new pods no longer have).
- **Secrets:** External Secrets / Sealed Secrets for every `existingSecret` (mandatory under
  GitOps); rotate media token keys in two phases (§5); Valkey ACL users instead of the default
  user's password.
- **Delivery:** push images to a registry, pin by digest, sign them (cosign) and generate SBOMs
  (bake supports `--sbom`/`--provenance` once tags are not content-derived); run
  `helm upgrade --rollback-on-failure` from CI or a GitOps controller.
- **Observability:** Prometheus Operator (`metrics.serviceMonitor.enabled`), Valkey and
  PostgreSQL exporters, alerts on `webflix_jobs{state="dead"}`, `webflix_dependency_up == 0`,
  container restarts, readiness flaps, Valkey memory.
- **Scheduling:** set `topologySpreadConstraints` to `DoNotSchedule` across real zones, add a
  PriorityClass, and consider KEDA on queue depth for the worker.
- **Object store:** the pipeline's lake lease needs conditional writes (`If-None-Match: *`),
  which AWS S3 and R2 honour and Garage ignores (§9.7). With such a store set
  `pipeline.lake.serialize: false` (the default with `objectStore.enabled: false`) to get the
  separate CronJobs back.
- **Staff issuer:** a Keycloak with its own clustering (two or more instances, Infinispan) and an
  external database, on a public https hostname the browsers and the API both reach; the
  in-chart one is a single instance. Create the jobs' client secret yourself
  (`pipeline.staffApi.existingSecret`) instead of the realm import's generated one.

## 9. Milestone 2 on Kubernetes

Milestone 2 runs on Kubernetes in two configurations of the same chart, both on the one-node
kind cluster with two API replicas behind Envoy, PostgreSQL 19, Valkey streams and Garage:

- **production** (`make k8s-up`): `config.environment: production`, the in-chart Keycloak as
  the staff issuer, email through SMTP to the mail catcher, the lake in the bucket, the
  pipeline's CronJobs with Keycloak's service account. No payment provider: production refuses
  the fake one, the in-process one and Stripe's test keys, so it runs `none` (checkout answers
  `503 payments_not_configured`, every replica alike).
- **conformance** (`make k8s-up VARIANT=conformance`): the development stand-ins the
  conformance suite drives, short timers and the privacy jobs every minute (§9.2).

### 9.1 What runs where

| Area | Production configuration | Conformance variant |
| --- | --- | --- |
| Consumer sign-in | Google and Apple once their clients are configured (`config.identity`); none offered meanwhile (`identity.providers_not_offered`) | the development issuer at `/dev-idp/{google,apple}` (routed by the gateway), sealed with the app Secret's `WEBFLIX_DEV_IDP_SECRET`, single use through the claims table |
| Staff issuer | Keycloak 26.8.2, realm `webflix` (§9.4) | the development issuer's staff realm (`/dev-idp/staff`) |
| Staff console | `/admin/` from the web image; `config.json` names Keycloak's realm and the public client `webflix-admin` (§3, Routing) | the same, naming the development issuer; signed in as `staff-admin` in a headless Chromium |
| Email | SMTP to Mailpit (§9.5) | the database outbox, read back by `GET /diagnostics/mailbox` from any replica |
| Payments | none (`none`: `GET /billing/config` answers `{"provider":"none"}`, checkouts `503 payments_not_configured`) | the fake provider, state in PostgreSQL (compare-and-set per customer), its form at `/_pay` (routed) |
| Webhooks, emails, event batches, exports, erasures, imports | jobs on the Valkey stream, consumed by the worker (1 replica; 2 in the variant) | the same |
| Scheduler | the worker, every 60 s on kind (`config.schedulerIntervalSec`) | every 10 s |
| Event lake | gzip NDJSON under `events/` in the bucket | the same |
| Pipeline | CronJobs: the lake round every 5 min (erase, export-events, compact, and `retain` once a day), analyse and train-and-score daily (§9.6) | the lake round every minute, export grace 1 min |
| Recommendations, experiments | PostgreSQL; members no experiment assigns get the rule engine (production's default policy) until `config.recommendations.defaultPolicy: learned` | PostgreSQL; `learned` by default (development) |
| Security headers | the CSP without Stripe; with `config.billing.paymentProvider: stripe`, Stripe.js's origins (§9.10) | the same (no Stripe) |

### 9.2 The conformance variant

`deploy/kind/values-conformance.yaml` over `deploy/kind/values.yaml`: `environment:
development` (mounts `/dev-idp`, `/_pay` and the diagnostics routes in the API, to which the
HTTPRoute sends `/dev-idp` and `/_pay` in every configuration: production answers 404 there),
the fake payment provider, the outbox email
sender, the deletion cooling-off at 10 s and the scheduler at 10 s, two workers, the relaxed
rate-limit profile (as on the local Worker), Keycloak and the mail catcher off, and the lake
round every minute with a 1 minute export grace and the
development issuer's `webflix-jobs` client (token from `http://webflix-api/dev-idp/staff/token`
inside the cluster: the issuer stamps tokens with the public origin's issuer, so a token fetched
through the Service verifies). What the conformance README requires to be shared across
replicas holds here with two API replicas and two workers: the issuer's secret comes from one
Secret and its single-use codes from PostgreSQL, the fake provider's state is in PostgreSQL, the
mailbox is the database outbox, rate limits and stream slots are in Valkey.

**After the fixes** (2026-11-23, the same one-node cluster and database, new images with the
owners' fixes of K1 to K9, migration 0017 applied on PostgreSQL; the suite is now 134 checks; the
HPA ran the API at 5 replicas through every run):

| Run | Configuration | Checks | Passed | Failed | Skipped | Time |
| --- | --- | --- | --- | --- | --- | --- |
| A | conformance (relaxed) | 134 | 130 | 0 | 4 | 317 s |
| B | conformance, again, same database | 134 | 129 | 1 | 4 | 286 s |
| C | conformance with the strict limits (`make k8s-redeploy RATE_LIMITS=strict`) | 134 | 131 | 1 | 2 | 1 066 s |
| D | production | 134 | 93 | 1 | 40 | 649 s |
| D′ | production, after routing `/_pay` and `/dev-idp` to the API in every environment | 134 | 94 | 0 | 40 | 652 s |
| E | conformance, again | 134 | 129 | 1 | 4 | 305 s |
| F1 | conformance, after billing's fix of K12 (new API image) | 134 | 130 | 0 | 4 | 294 s |
| F2 | conformance, again, same database | 134 | 130 | 0 | 4 | 317 s |
| F3 | conformance, again, same database (the cluster left running) | 134 | 130 | 0 | 4 | 283 s |
| F4 | conformance with the strict limits, same database | 134 | 132 | 0 | 2 | 1 062 s |

Run D's failure was the chart's: `billing.provider-config` (new) asserts that without a
provider `/_pay` is not served, and production routed `/_pay` to the web app, whose SPA
fallback answered a 200 page; the HTTPRoute now sends `/dev-idp` and `/_pay` to the API in every
environment (§3, Routing), which answers 404 there in production, and run D′ passes with every
skip reason true (billing: "the deployment has no payment provider (GET /billing/config
answers provider none …)"; the staff checks: the development issuer "answered 404
application/problem+json", Keycloak being the issuer).

**After billing's fix of K12** (runs F1 to F4) nothing fails: `billing.dunning` passes in all
four, and so does every other check that can run (the skips are the four expected ones under
relaxed limits, two under strict). Beside the suite's verdict, the logs of the same windows: no
`http.unhandled_error`, no API `http.request` with a 5xx status and no `level: error` line in the
API's or the workers' logs, and no 5xx in Envoy's access log of the same windows (2 869,
1 920, 2 965 and 3 638 lines; in F4 the autoscaler took the API from 5 to 2 replicas mid-run,
so the API's own logs cover only the surviving pods there, and the gateway's log, which every
request crosses, is the one that counts).

Before that fix, on the conformance variant every check passed except one, in three of four
runs:
`billing.dunning` got a `500
internal_error` from `GET /billing/payment-method/setup/:id` (finding K12, §9.11): the poll's
completion of the card change ran into the same completion running elsewhere (the worker
processing the setup's event, or another replica's poll), the fake provider answered "a request
with this key is in flight", and nothing turned that into "still processing". All 776 provider
events of these runs were processed (at most two attempts each), none dead-lettered. The skips
are the right ones: probes not routed, every title packaged, and under relaxed limits the two
checks that need the strict profile, which pass in run C. A strict run is practical now: the
suite renews its tokens and no longer counts rate-limit waits against a check's timeout.

**The Kubernetes pass** (2026-11-23, commit 496524e plus the Cloudflare engineer's console policy
and spec fixes and the outbox fix, all in the images; a fresh one-node cluster with the variant,
the rollouts done and 90 s more, then `make k8s-recs-demo`):

| Run | What | Result |
| --- | --- | --- |
| H1 | `make smoke TARGET=k8s` | 152 checks: 147 passed, 1 failed, 4 skipped (281 s) |
| H2 | the same, after the suite's consent check was fixed (below) | **152 checks: 148 passed, 0 failed, 4 skipped** (299 s) |
| B1 | `make e2e TARGET=k8s`, Chromium and Firefox, 4 workers (WebKit not run: the screen was locked) | 258 passed, 2 failed, 8 skipped (6.3 min) |
| B2 | the same, after two specs were fixed (below) | **260 passed, 0 failed, 8 skipped** (6.7 min): Chromium 212 passed and 6 skipped, Firefox 12 and 2, the console project (`admin`, against the cluster's `/admin/`) 35 and 0, setup 1 |

All three failures had one cause: behind several API replicas, a change made through one of them
reaches the others within the 30 s age bound of their copies (docs/RECOMMENDATIONS.md), and the
checks read it at once.

- `personalisation.consent` (H1): rules 0 s after the member turned personalisation off, then
  5 s later the demo run's page again, from a replica whose copy of the withdrawals predated the
  answer. Documented: "the withdrawing process applies it at once and every other within 30 s".
  The check now holds the rule engine's page from 30 s after the answer on and notes what it saw
  before (the next run: "within 30 s of the withdrawal a copy older than it still answered
  demo:…, as documented").
- `browse-personal-rows.spec.ts`, the curated collection and the unavailable title (B1): the
  published collection was missing from the first page (another replica), and the home page
  still carried a title already 404 on the instance that answered first. The specs now wait
  until the change is what every instance answers (25 answers in a row, or held since the 30 s
  bound passed), after publishing, withdrawing and making unavailable, and after putting it back.
- `privacy-account.spec.ts` "download your data" skipped in B1 (still processing after 60 s): a
  batch export here takes up to the lake round's minute plus its 1-minute grace. The spec now
  waits the deployment's own stated time (`exportTypicalSec`, 180 s here) and half again; it
  then passed in 1.6 min, the emailed link included.

The skips, each for this configuration's reason: in the suite, `ops.health` (probes are on the
ops port, not routed), `media.external-fallback` (every title is packaged),
`consistency.rate-limit-monotonic` and `ratelimit.strict-defaults` (relaxed limits; they pass
under the strict ones, run C and F4). In the browser suite: the scheduled-deletion billing spec
(the variant's cooling-off is 10 s, so the deletion falls before the trial ends; it needs the
default 14 days), the no-provider spec (the variant runs the fake provider), the exploration
ranks spec (`WEBFLIX_RECS_EXPLORE_SHARE` is 0), the rate-limit timer spec (relaxed limits),
Firefox's native-HLS spec (Firefox has none) and the Global Privacy Control spec (Chromium has
no switch for it; on Firefox it needs `WEBFLIX_CONSENT_MODE=opt-out`, the variant is opt-in).
With the 10 s cooling-off the erasure spec ("when the cooling-off period ends, the account is
gone") runs and passes. No 5xx: none in the API's and the workers' logs of either suite run
(0 of 3 339 requests in H2) and none in the gateway's access log over the browser suites and the
pipeline runs (0 of 26 451 lines); the outbox's duplicate-id 500 did not occur.

**The web step, a first look** (2026-11-23, provisional: other owners' fixes were still landing,
so the suite in the working tree ran ahead of the images at times; one node, the variant, five
API replicas under load):

| Run | Images | Checks | Passed | Failed | Skipped | Time |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | built at the start of the round | 143 | 126 | 13 | 4 | 240 s |
| G2 | rebuilt from the working tree mid-round (migrations to 0026, the pipeline's retain and erasure list) | 152 | 147 | 1 | 4 | 321 s |

Nothing in either run failed because of Kubernetes. G1's thirteen: eleven contract mismatches
(the suite's contracts had new fields, `email` on privacy requests, `kind`, `targetLabel` and
`facts` on audit entries, and a route, `POST /privacy/exports/{id}/download`, that the images did
not have yet), `staff.roles`' 500 on `GET /system/health` (the image's own response validation:
its contract had the new `privacy` block while its operations did not fill it yet, a snapshot
taken mid-change; the current tree fills it, and G2 passes), and `experiments.assignment` (the
suite's probe race, finding K13). G2's one: `privacy.export-operator` expected `failed` after a
failed export round while the server answered `processing`, which is what the suite's source
expects now (it was being changed during the run). G2's logs: no `http.unhandled_error`, no
`level: error`, no 5xx in the API's and the workers' logs of the window. The full runs wait for
the security fixes.

The earlier results, before the fixes:

**Results** (2026-11-22, the one-node cluster, `make smoke TARGET=k8s SMOKE_ARGS="--timeout
300000"`; runs 1 to 5 on one database, 6 and 7 on a new cluster's; the HPA took the API from 2
to 5 replicas under the relaxed runs' load, so most ran against five API replicas):

| Run | Configuration | Checks | Passed | Failed | Skipped | Time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | production (strict limits) | 133 | 93 | 0 | 40 | 638 s |
| 2 | conformance, strict limits | 133 | 116 | 15 | 2 | 986 s |
| 3 | conformance (relaxed, `--workers 1`) | 133 | 116 | 12 | 5 | 518 s |
| 4 | conformance, again, same database | 133 | 118 | 11 | 4 | 244 s |
| 5 | conformance, `--only billing,staff.refund`, the fake's webhook delivery switched to `outage` (diagnostic) | 14 | 14 | 0 | 0 | 7 s |
| 6 | conformance, a new cluster from nothing (the one left running), after `make k8s-pipeline-smoke` | 133 | 117 | 12 | 4 | 296 s |
| 7 | conformance, again, same database | 133 | 115 | 14 | 4 | 303 s |

**Not every check passes on the variant, and the cause is in the product, not the deployment.**
What fails in runs 3, 4, 6 and 7, every time (the billing count varies with timing: 11 to 13
checks, every one a checkout left `processing`):

- **The billing journeys (10 to 12 of 13) and `staff.refund`:** a trial checkout stays `processing`
  for ever while its membership is `trialing` (checkout `01a20398-c586-…`, membership version 63
  after 59 polls). The fake provider delivers the subscription's events as the confirmation
  creates it; a worker in another pod processes them within milliseconds and writes the
  projection, `none` → `trialing`, and updates the checkouts of that subscription, but the
  confirmation request has not saved the subscription's id on the checkout yet (logged 14:11:13.446
  in the worker, 14:11:13.449 in the API). Every poll after that reads the provider, finds the
  projection unchanged and never looks at the checkout again. Run 5 isolates it: with webhooks
  off, the same journeys reconcile through the polls and all 14 pass, on PostgreSQL, behind five
  API replicas and two workers. In dev the in-process queue, and on the local Worker the queue's
  2 s batching, always let the confirmation finish first, which is why the suite never saw it
  (§9.11).
- **`experiments.assignment`:** right after the suite starts an experiment, one request saw the
  profile's variant and a later one (another replica) saw none: each process keeps the
  definitions for 30 s (`createRepositoryExperiments`), so for up to 30 s replicas disagree on
  whether an experiment runs. With one process (dev, the local Worker) the starting process
  invalidates its own copy and the check passes (§9.11).

Run 2 also failed for reasons of this deployment's own, both fixed: the lake round hung in a
forked worker (§9.6), so its export never completed (a round started before the fix, holding
the CronJob through `Forbid`, also made run 3's `privacy.export` skip for want of a round); and
under strict limits a run takes 16 minutes, past the
5-minute life of the staff tokens the suite fetches once per run, so its last staff calls were
refused as `expired` (a suite defect, §9.11: hence the relaxed profile in the variant, as the
local Worker runs). The skips are the right ones: `ops.health` (probes are on the ops port, not
routed), `media.external-fallback` (every title is packaged), and under relaxed limits
`consistency.rate-limit-monotonic` (a 1 s `Retry-After` cannot tell a refill from another
instance admitting) and `ratelimit.strict-defaults` (relaxed profile); the strict profile's
checks pass in run 1. Everything else passes on the variant: federated sign-in through the
development issuer across replicas (sign-up, Apple's form post, linking, reauthentication, the
fault catalogue), emailed links through the outbox, data export completed by the deployment's
job (65 s after the request, two rounds: one deferral under the 1 minute grace, then the
events), erasure 11 s after the cooling-off, the operator routes with the `webflix-jobs` token,
the curated row, the imported recommendation run.

**On the production configuration** (run 1) every milestone 1 check that can run passes, and
the milestone 2 checks skip, each with its reason: the federated journeys because no Google or
Apple client is configured; the mailbox journeys because the mailbox is a non-production
surface (mail goes to Mailpit, §9.5); the staff and experiment checks because the staff API
trusts Keycloak, whose tokens the suite cannot mint (§9.4 proves that path); the deletion
erasure because the cooling-off is 14 days; the events read-back and popularity diagnostics
because they are not served in production; `privacy.export` because without a staff token the
suite cannot tell batch mode from an export that never ends (the lake round completed it later).
**One reason is wrong**: the billing journeys skip saying "GET /billing/config names the fake
provider but its form is not served": with no provider configured, production answers
`{"provider":"fake","formUrl":"/_pay/form"}` (§9.11).

### 9.3 Settings and secrets

Every milestone 2 variable of docs/BACKEND.md §4 is reachable: the ones the chart reasons about
are typed values (`config.identity`, `config.email`, `config.billing`, `config.events`,
`config.recommendations`, `config.staff`; §4), the rest go through `config.extraEnv`, and only
what is set reaches the ConfigMap, so the application's defaults for the environment apply to
the rest. Credentials never go in values:

- **The app Secret** (`<release>-app`, generated once with `lookup`, kept on uninstall like the
  data stores' credentials): `WEBFLIX_PSEUDONYM_KEY`, which production requires once events are
  stored and which must never change (every subject key in the lake and every served profile
  list derives from it), and outside production `WEBFLIX_DEV_IDP_SECRET` and
  `WEBFLIX_PAYMENTS_FAKE_WEBHOOK_SECRET`, one value for every replica. Under GitOps,
  `secrets.appExistingSecret` (the chart refuses to render generated credentials without a
  cluster, as before).
- **Provider credentials** (Stripe, Google, Apple, Keycloak as a consumer issuer, SMTP, the HTTP
  email provider and its webhook): `secrets.envFrom`, a list of Secrets whose keys become
  environment variables of the API, worker and Jobs. The pods' checksum annotation covers them,
  so a rotation followed by `helm upgrade` rolls the pods.
- **`WEBFLIX_RELEASE`** (the `app.version` of server events) is the API image's tag, or
  `config.events.release`. The kind make fragment used to export `WEBFLIX_RELEASE=webflix`
  (its Helm release name) into every recipe of the Makefile, which reached the product's own
  setting in dev mode (server events stamped `webflix`) and anything else started by make; it
  is now `WEBFLIX_HELM_RELEASE`, read by `deploy/kind/lib.sh` and `deploy/kind/verify/lib.ts`.

### 9.4 Staff sign-in through Keycloak

`keycloak.enabled` (on in the kind values) runs one Keycloak in production mode: `start
--import-realm`, HTTPS on 8443 with a certificate from a CA the chart generates once
(`genCA`/`genSignedCert`, kept across upgrades; `keycloak.tls.secretName` for your own), the
health endpoints on the management port over HTTPS, its data in a role and database of its own
in the in-chart PostgreSQL (an init container creates them, or brings the role's password in
line, at every start), the bootstrap administrator's password in a Secret. The realm (a Secret,
since it holds the jobs client's secret and the demo staff's password):

| Realm part | Value |
| --- | --- |
| `webflix-admin` | public client, code flow only, PKCE `S256`, redirect `{publicOrigin}/admin/auth/callback`, post-logout redirect `{publicOrigin}/admin/`, web origin `{publicOrigin}`, refresh tokens on, an audience mapper adding `webflix-admin-api` to access tokens |
| roles | the client roles `support`, `billing`, `content`, `experiments`, `admin` of `webflix-admin` (tokens carry them as `resource_access["webflix-admin"].roles`) |
| `webflix-jobs` | confidential client, service account only, the same audience mapper; its service account user holds `admin` and `experiments` |
| demo staff (`keycloak.demoStaff`, kind) | `staff-support`, `staff-billing`, `staff-content`, `staff-experiments`, `staff-admin`, `staff-none`; one password in the `webflix-keycloak` Secret (`staff-password`) |

The API trusts the CA (`NODE_EXTRA_CA_CERTS`, the chart's CA bundle mount) and validates staff
tokens against the realm (`WEBFLIX_STAFF_ISSUER=https://webflix-keycloak:8443/realms/webflix`,
set by the chart; https is required in production). The pipeline's jobs get their token from the
realm's token endpoint with the `webflix-jobs` secret (Python trusts the CA through
`SSL_CERT_FILE`). The issuer's host is the Service's name, reachable from every pod; a browser
on the host reaches it through `kubectl port-forward svc/webflix-keycloak 8443` once the name
resolves to 127.0.0.1 and the CA in `webflix-keycloak-tls` is trusted. Neither needs the host
changed: a Chromium started with `--host-resolver-rules="MAP webflix-keycloak 127.0.0.1"` and a
context that accepts the certificate does both for itself (how the console's sign-in was proved,
§3); a hosts entry and the CA in the system's store do it for every browser. A real deployment
sets `keycloak.hostname` to its public https URL.

Proved on the production configuration (2026-11-22; `make k8s-test-keycloak` runs the same,
`deploy/kind/verify/staff-keycloak.sh`), through the gateway with real tokens:

| Token | How | `GET /me` | support route (`/members`) | billing route (`/plans`) | admin route (`/system/health`) |
| --- | --- | --- | --- | --- | --- |
| `webflix-jobs` service account | client credentials | 200, roles `admin`, `experiments` | — | — | 200 (also `GET /system/privacy/exports`) |
| `staff-support` | code flow with PKCE through Keycloak's login page | 200, `support` | 200 | 403 `staff_role_required` (`billing`) | 403 (`admin`) |
| `staff-billing` | the same | 200, `billing` | 403 (`support`) | 200 | 403 |
| `staff-none` | the same | 200, no role | 403 | 403 | 403 |
| `staff-admin`'s **ID token** | the same | 401 `unauthenticated` | | | |

The tokens carried `iss` `https://webflix-keycloak:8443/realms/webflix` (the discovery
document's issuer, whatever port-forward reached it), `aud` `webflix-admin-api`, `typ` `Bearer`,
`azp` the client, and the roles; a wrong client secret got `401` from Keycloak. The lake round's
calls to the staff API (erasures, exports, results) used the service account's token from a
pipeline pod, over HTTPS to Keycloak with the chart's CA.

### 9.5 Email through SMTP

With `mailcatcher.enabled` the chart defaults the sender to `smtp` with host
`<release>-mailcatcher`, port 1025, `tls: none` (Mailpit accepts any login; credentials need
TLS in the application, so none are set). Proved on the production configuration: a member's
sign-up and password reset were sent by the worker's email jobs (`identity.email_sent`,
templates `verify-email` and `reset-password`) over SMTP, and Mailpit holds them
(`Received: from webflix.local (unknown [10.244.0.32]) by webflix-mailcatcher-… (Mailpit) with
SMTP`, `From: "Webflix" <no-reply@webflix.dev>`, `Subject: Reset your Webflix password`, the
link `http://localhost:8080/reset-password#token=…`). During the production run of the
conformance suite every sign-up's verification email went the same way (30 messages). `make k8s-test-smtp` repeats it (`deploy/kind/verify/smtp.sh`). Read
them with `kubectl port-forward svc/webflix-mailcatcher 8025` (UI at `http://localhost:8025`,
REST API `GET /api/v1/messages`).

### 9.6 The pipeline as workloads

`pipeline.enabled` (on in the kind values) runs the `webflix-recs` image against the bucket
through its S3 API (`--store s3://webflix-media`, the API's `WEBFLIX_S3_*` from the ConfigMap
and the object store's Secret), as non-root with a read-only root filesystem and an `emptyDir`
at `/work`, under NetworkPolicy `pipeline` (the bucket, the API's port for the staff API and the
development issuer, Keycloak; PostgreSQL and Valkey only for the importer). The CronJobs:

| CronJob | Schedule (kind) | Pod |
| --- | --- | --- |
| `webflix-recs-lake-round` | `*/5 * * * *` (every minute in the variant) | `lake_round.py`: `erase --keys api --confirm api` when keys are pending or daily, the export round, `compact` hourly, `retain` daily (§9.7 for why one CronJob) |
| `webflix-recs-analyse` | daily 04:30 | `analyse-experiments --definitions api`; the worker imports the results on its next tick (`experiments.import-results`) |
| `webflix-recs-train-and-score` | daily 04:00 | init containers in order on one `/work`: the catalogue snapshot (tools image, `export-catalog.ts`) copied into the bucket, `train-and-score --phase prepare`, the rule engine (tools image, `rule-engine-rankings.ts`), `--phase finish`, `publish` (exit 3, the gate refusing, is not a failure: the served run stays; a young lake is exit 0, `nothing-to-train` then `nothing-to-publish`); prepare and finish read the erasure list from the staff API with the service account (`--erasures api`, the default with `WEBFLIX_ADMIN_API_URL`) and exit 6, failing the Job, when it cannot be read or 500 or more erasures wait; then the importer (`node apps/api/src/recs.ts import`, a no-op when that run is served; "No recs/current.json", nothing ever published, is treated as success: below) |

**Worker processes.** On the first conformance run an erase in the lake round hung for seven
minutes with every process asleep on a futex: the pipeline's process pools forked (Python 3.13's
default on Linux) after polars' and boto3's threads had started, and sized themselves from the
node's 11 CPUs, not the container's limit (finding K5); the chart then ran every job with
`--workers 1`. Fixed in the pipeline: pools are spawned, sized from the CPUs the container may
use (its cgroup quota) minus one, and a stalled pool exits 9 instead of hanging. The chart no
longer passes `--workers` unless `pipeline.workers` is set; with the kind values' 1 CPU limit
that is one worker, and the smoke Job below ran with `WORKERS=4` to put spawned pools through
compaction, erasure and the dataset build on Linux.

**The export round** is now the pipeline's own call: `webflix-recs export-events --grace-minutes
N` reads the pending requests from the staff API (`GET /system/privacy/exports`), the pending
erasures, and posts its results (`POST /system/privacy/exports/results`), the default when
`WEBFLIX_ADMIN_API_URL` is set (finding K8; the chart's own wrapper script is gone). With
nothing pending it is one token and one list call. Every job is safe to rerun;
`concurrencyPolicy: Forbid`, one retry (`backoffLimit: 1`), stopped after an hour. On a fresh
install the first round can run before any API pod is ready and fail (`Connection refused` on
the token endpoint, exit 6); the next minute's round succeeds, and the failed Job stays in the
history (`failedJobsHistoryLimit: 2`) until two newer ones fail.

**The importer on a fresh install.** `node apps/api/src/recs.ts import` exits 1 with "No
recs/current.json: nothing published" until a first run is published, which on a new
deployment takes days (a young lake: `nothing-to-train`) and at smoke size never happens (the
gate refuses). The chart treats exactly that answer as success (the step logs "nothing published
yet: nothing to import" and exits 0), so the daily Job does not fail for an ordinary state;
every other failure of the importer still fails the Job.

**The importer's exit 3** means the run was imported but the shared cache could not be told about
it after three retries; every replica serves the new run within the model's 30 s age bound
anyway. The chart's import step counts it as success: a failed Job asks an operator to act and,
through the CronJob's retry, runs the whole pod again, and neither helps when the only effect is
a page that changes up to 30 s later. What happened is said where an operator looks: the step's
log and its **termination message** ("imported, but the shared cache could not be told after
retries (exit 3): every replica serves the new run within 30 s"), which `kubectl describe pod`
and the pod's status show; on success the message is the importer's own last line (imported,
unchanged), on "nothing published yet" that sentence, and a publish the gate refused says so too.
Every pipeline container has `terminationMessagePolicy: FallbackToLogsOnError`, so a step that
fails shows its last log lines there. `make k8s-recs-demo` treats the demo command's exit 3 the
same way.

**What train-and-score needs.** Each gate backtest builds its own dataset as of its cutoff, so
the job reads the lake four times. Measured by the pipeline on an 18-core laptop with 4 workers
(docs/RECOMMENDATIONS-ML.md, "Run time and memory"): smoke size about 90 s, under 0.4 GB; medium
(18k profiles, 3.7 M events) 286 s, peak 1.9 GB; full (136k profiles, 28.7 M events) 16.6 min,
peak 10.3 GB. The CronJob therefore has its own budget, `pipeline.jobs.trainAndScore`, for every
step of its pod: by default requests 1 CPU and 3 GiB, limits 4 CPUs (three worker processes) and
4 GiB, a 2-hour deadline (`activeDeadlineSeconds`; the other pipeline jobs keep one hour) and a 4
GiB `/work`. That fits a member base up to the medium size. **A deployment with real data should
budget by its size**: near the full size give it memory 12Gi as request and limit (a request below
the peak lets the node evict it midway, and a 17-minute job evicted at minute 15 is lost), cpu 4,
and keep the 2-hour deadline for slower nodes; above that the pipeline's next step (streaming
the tables per profile shard) comes first. The kind values give it 1 CPU and 2.5 GiB, enough for
a young lake and the smoke size (and medium, slowly).

**Nothing collects into a lake nobody looks after.** A lake that nothing erases keeps deleted
members' events for ever, and one that nothing expires keeps everything past its retention.
The chart therefore picks coherent defaults and refuses the incoherent explicit choices:
`config.events.sink` and `config.events.exportEvents` default to `lake` and `batch` only when
the lake is looked after, by the chart's pipeline with its erase, exportEvents and retain jobs
on, or by a runner of the operator's own declared with `pipeline.external: true`; otherwise to
`memory` (nothing stored) and `inline` (the export job reads the events itself). An explicit
`lake` or `batch` without either fails the render, naming the three ways out. NOTES.txt says
which it is: "collected into the lake (…); erased, exported and expired by age (retain, daily)
by the pipeline's CronJobs", "… by your external runner (pipeline.external: make sure it runs all
three)", or "not stored (memory: no pipeline to erase or expire a lake); data exports inline".

**Retention in the lake round.** `webflix-recs retain` deletes activity older than
`WEBFLIX_EVENTS_RETENTION_DAYS` (raw hours, compacted Parquet and manifests, quarantine, dataset
rows, unpublished artefact versions) and totals older than `WEBFLIX_AGGREGATES_RETENTION_DAYS`.
They are the product's own settings: `config.events.retentionDays` and
`aggregatesRetentionDays` reach the API and the pipeline's pods through the one ConfigMap, and
unset both sides default to 396 and 1 126 days. The lake round runs it last, once a day
(`pipeline.jobs.retain`, on by default; its own CronJob when the lake is not serialised), with
`WEBFLIX_RECS_LAKE_SERIALIZED=true` like the other lake steps. Its exit codes: 0, 2 (a bad
setting), 10 (the store ignores conditional writes and nothing declared the scheduler the lock),
75 (lake busy), 1; anything but 0 fails the round's Job, and the round tries again five minutes
later because only a successful run is remembered. Proved on Garage (2026-11-23): the round's
first run after the upgrade ran `retain` with the product's periods (396 / 1 126, the same the
API's privacy terms state; `"lakeLease": "scheduler"`, 0.65 s, nothing old enough on a young
lake). On the simulated lake (`sim/`, 21 days, 1 998 objects) with 14 and 10 days: a dry run
listed 162 hours, 162 Parquet files, 308 raw objects, 5 dataset tables (19 272 rows) and deleted
nothing; the real run deleted exactly that (2.9 s; 1 367 objects left, the oldest hour
`dt=2026-11-09/hh=00`, the plan in `recs-work/retention/last-run.json` first); a rerun found
nothing to delete.

**A second line of defence in the bucket.** Garage implements S3 lifecycle configuration for
`Expiration` by days with a prefix filter and `AbortIncompleteMultipartUpload`: in the cluster
`PutBucketLifecycleConfiguration` with both (396 days on a probe prefix, 1 day for abandoned
uploads) was accepted and read back as stored, and deleted again afterwards. It also accepted a
rule with `Transitions`, which it does not implement, with the same `200`, so acceptance proves
nothing about enforcement; expiry itself runs in Garage's background worker and was not observed
within the run. Lifecycle ages objects by their write time, not by the hour they hold (compaction
rewrites objects) and deletes manifests without regard to the hour's other files, so it is a
backstop only: a rule on `events/` with a margin past the retention (for instance 30 days more)
catches a `retain` that stopped running, and `AbortIncompleteMultipartUpload` is harmless. The
chart does not install one; apply it with the bucket's owner's tools, and alert on the age of
`recs-work/retention/last-run.json` instead of relying on it.

**Erasures in train-and-score.** Nobody erased or newly restricted may be in a dataset: prepare
reads the staff API's erasure list before building the dataset and finish reads it again before
scoring, both with the jobs' service account (the CronJob's prepare and finish containers carry
`WEBFLIX_ADMIN_API_URL`, `WEBFLIX_STAFF_TOKEN_URL`, `WEBFLIX_STAFF_CLIENT_ID` and the secret, like
every pipeline container). Proved with the release's own train-and-score pod moved to the
simulated lake (store `sim/`, `--as-of` the simulated end; 56 s): prepare called `GET
/api/admin/v1/system/privacy/erasures` (200) at its start and left 3 keys out
(`excludedAtStart`), the Node step ranked 235 profiles, finish called it again before scoring
(`excludedAtScoring: 3`, status `scored`), and publish was refused by the gate (exit 3, expected
at this size). On the product's young lake the CronJob's run read the list too (7 keys out) and
ended `nothing-to-train`. With a wrong client secret prepare exits 6 ("POST …/token: HTTP 401")
and the pod fails: the Job fails, as it should, until erase has run or the staff API answers.

**The publish gate** needs backtests at rolling weekly cutoffs that all beat the rule engine
(`WEBFLIX_RECS_GATE_CUTOFFS`, default 3; set it through `pipeline.extraEnv`). The rule engine's
input now has one section per cutoff and its outputs go under `/work/train/<backtest run>/`, so
prepare, the Node step and finish keep sharing the pod's `/work`; their command lines did not
change. A lake younger than about 14 days ends `nothing-to-train` (exit 0); three cutoffs need
about 28 days. A rerun of a cutoff already scored now goes through (finding K14, fixed):
the release's own train-and-score pod run twice for one cutoff of the simulated lake
(2026-11-22T05:00Z) scored it the first time (3 keys left out at the start and again before
scoring; publish refused by the gate at this size) and the second time answered `already-scored`
in prepare and finish, the Node step passed, publish said the gate's answer again and the import
step ran (`unchanged`), Job `Complete` both times.

**The demo run** (`make k8s-recs-demo`, `deploy/kind/recs-demo.sh`) labels its pages
`demo:<run>`: after the rebuild the demo profile Alex's home answered `policy {"id":
"demo:20261123-010138-de00de00"}` with Top Picks for Alex, the same on three requests (the run
replaced the smoke pipeline's imported run, hence `REPLACE=1`).

**At smoke size, every step as a Kubernetes workload** (`make k8s-pipeline-smoke`): a Job with
the CronJobs' images runs the whole pipeline on a simulated lake (300 accounts, 21 days ending
at the last full hour) under the bucket's `sim/` prefix, so the product's own lake is never
touched, then the product's importers. Measured on the one-node cluster (61 s end to end with
the pipeline's default 9 forked worker processes, the first time; 123 s with `--workers 1`;
117 s with `WORKERS=4` after the fix of K5, the pools spawned, plus an erasure of one simulated
account: 48 raw objects and 49 Parquet files rewritten and verified in 42 s):

| Step | Image | Result |
| --- | --- | --- |
| catalogue snapshot → bucket | tools, recs | 119 titles, `catalog/current.json` written after the snapshot |
| simulate | recs | 3.5 s, 157 MB |
| compact | recs | 8.4 s, 136 MB |
| train-and-score `--phase prepare` | recs | 17.4 s, 385 MB (dataset, backtest run, the engine's input) |
| rule engine | tools | 251 profiles ranked by `@webflix/core`'s `Personalization` |
| train-and-score `--phase finish` | recs | 14.2 s, 435 MB (evaluation, production run, scoring) |
| publish | recs | refused by the gate (exit 3), as `make recs PRESET=smoke` documents at this size |
| analyse-experiments | recs | 4.0 s, 209 MB, two simulated experiments |
| importers | tools | the scored run imported with `--run` (`activeModel` `20261122-130000-f645dd95`, expiring 3 days after its cutoff), experiment results imported with the simulator's keys skipped as unknown |

On the product's own lake (production configuration, a few hundred events from one conformance
run): the lake round ran erase (1.3 s, nothing pending), the export round (one export deferred
by the 15-minute grace, completed by a later round) and compact (0.4 s, the hour still open);
analyse found no experiment. **train-and-score failed** on it: the dataset was empty (every
event was received after the knowledge cutoff, the end of the last closed hour), and the
first phase crashed with a polars `SchemaError` (join keys `str` against `null` in
`history.py`) instead of reporting that there is nothing to train; reported to the pipeline's
owner (§9.11). A fresh production deployment therefore sees this daily Job fail until its lake
has a closed hour of consented events.

### 9.7 The lake lease on Garage: not a lock

`compact`, `erase` and `export-events` each take the lake lease, `recs-work/locks/lake.json`,
created with `PutObject` and `If-None-Match: *`; a store that answers `NotImplemented` gets the
pipeline's check-then-write fallback (services/recs/README.md, "The lake lease"). **Garage
v2.5.0 does neither: it accepts the header and ignores it.** Measured in the cluster with the
pipeline's own `S3Storage` (a pod with the recs image and the API's credentials):

| Probe | AWS S3 / R2 would answer | Garage v2.5.0 |
| --- | --- | --- |
| `PutObject` with `If-None-Match: *` on a new key | 200 | 200 |
| the same on the existing key | `412 PreconditionFailed` | **200, the object overwritten** |
| `PutObject` with `If-Match: "<wrong etag>"` | 412 | **200, overwritten** |
| 16 threads racing `put_if_absent` on one fresh key | 1 winner | **16 winners** (the last writer's body stays) |
| `lease.acquire(compact)` then `lease.acquire(erase)` | the second raises `LakeBusy` | **both granted** |

That matches Garage's documentation and tracker: the S3 compatibility page lists `PutObject`
with no conditional support, no release up to v2.5.0 (2026-10-24) adds it, issue #1326 ("If-None-Match
'*' overwrites any existing object") was closed as a duplicate of #1052, still open, where a
maintainer wrote that conditional writes are "not possible with our weak-consistency replication
model" (garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/,
git.deuxfleurs.fr/Deuxfleurs/garage, read 2026-11-22).

**What happens if nothing else serialises them.** The pipeline believes it holds the lake: an
erasure and a compaction of the same hour can interleave (one flips the hour's manifest to a
Parquet file the other is about to replace or delete; with `--delete-sources`, raw objects the
other has not folded in can be deleted), and an export can read an hour while an erasure
rewrites it. The pipeline's own design names exactly these races as why the lease exists. Nothing
fails loudly: the second job simply runs.

**What the chart does.** With the in-chart Garage (`pipeline.lake.serialize: auto`) the three
jobs never run as separate CronJobs: one CronJob, the lake round, runs erase, export-events and
compact one after another in one pod (`files/pipeline/lake_round.py`), and its
`concurrencyPolicy: Forbid` is the mutual exclusion the lease cannot give. Each step runs only
when it has work (pending erasure keys or the daily watch-period pass; pending exports; an
hourly compaction), so a round with nothing to do costs two staff API calls and a state read.
Readers (train-and-score, analyse, the product's export reader) never take the lease, by the
pipeline's design. With a store that honours conditional writes (AWS S3, R2)
`pipeline.lake.serialize: false` gives back the separate CronJobs, each taking the lease.

**What the pipeline does now** (finding K6, fixed): before its first acquisition a job probes the
store with two create-only writes on a scratch key; on Garage the second is not refused, so
`compact`, `erase` and `export-events` exit 10 ("…accepted a create-only write onto an existing
key and overwrote it…") unless the pod declares the scheduler the lock,
`WEBFLIX_RECS_LAKE_SERIALIZED=true`, which the lake round sets (and the smoke Job, the only
writer of `sim/`). Their summaries then say `"lakeLease": "scheduler"` instead of `"held"`.
A separate CronJob on Garage, or anything started by hand without the variable, now fails loudly
instead of running unprotected.

### 9.8 Milestone 2 on PostgreSQL

Before this work every milestone 2 repository suite and migration had run on SQLite and D1 only.
`pnpm --filter @webflix/db test:postgres` (PostgreSQL 19 in the `webflix-be-pg-test` container)
first failed 6 of 350 tests; none was a dialect problem in the product's SQL, all were the
upgrade test's own handling of PostgreSQL schemas:

- *The milestone 1 → 2 upgrade test dropped its schema to start from milestone 1.* Kysely's
  migrator introspects every schema of the server by name (`has_schema_privilege`,
  `pg_get_serial_sequence`), so the five test files migrating in parallel failed with `schema
  "t_…" does not exist`, and the test itself then ran `CREATE SCHEMA current_schema()` after the
  drop, when `current_schema()` had already fallen back to `public` (`schema "public" already
  exists`). Fixed in `packages/db/test`: the harness can create a schema left empty
  (`createPostgresHarness({ migrate: false })`), and the test starts from it instead of dropping
  anything.
- *The test's own migrator for the milestone 1 list did not pin Kysely's bookkeeping tables to
  its schema*, so it found another test file's `kysely_migration_lock` and skipped creating its
  own (`relation "kysely_migration_lock" does not exist`). `migrateToLatest` already pins them
  (`migrationTableSchema`); the test now does the same.

After both: **350 of 350 pass on PostgreSQL** (and on SQLite and D1 as before), including every
area's repository contract (identity, billing, events, personalisation, experiments, admin), the
recommendation store, the migrations from empty and from a populated milestone 1 schema, and
the schema-equivalence test. The fake payment provider's SQL store, whose contract suite had run
only on SQLite and D1, passed its 18 contract tests on PostgreSQL too (a temporary test file,
not kept: its package belongs to billing). In the cluster, the migrations ran from empty on the
in-chart PostgreSQL (revision 1) and again as no-ops on every later revision.

**The web step's migrations on a database with data** (2026-11-23). A cluster brought up with
the previous images (schema at 0017), given data by a subset of the conformance suite, then
upgraded: the migrate Job applied `0018_admin_audit_request`, `0019_billing_next_invoice`,
`0020_events_deletion_membership`, `0021_billing_client_secrets` and
`0022_identity_access_proven` with the data kept (22 accounts, 10 memberships, 16 invoices, 16
audit entries, 4 privacy requests before and after). After a conformance run had filled it
further (112 accounts), a dump of that database restored into a scratch PostgreSQL 19 took
`0023_admin_audit_privacy` to `0026_billing_amount_reasons` from the working tree, and then the
rebuilt images' migrate Job applied the same four in the cluster: 0023's data rewrite masked the
3 `member.searched` entries (`j***`) and cleared the 3 `privacy.erasures_confirmed` key lists,
nothing else changed. `test:postgres` at 0026: 383 of 383, including the admin log's erasure
whose `contains` is `strpos(lower(column), value) > 0` on PostgreSQL (the cases "erases a member
from the log" and "deletes the dead letters that mention an erased member" ran on PostgreSQL).

### 9.9 Several replicas: what must be shared

Every check of the conformance variant ran against two API replicas and two workers (§9.2).
What dev's in-process stand-ins did within one process, and what holds across pods here:

| Stand-in | Across pods | How |
| --- | --- | --- |
| The development issuer's codes and sessions | holds | sealed with one secret (the app Secret), single use through the identity claims table in PostgreSQL |
| The mailbox | holds | the outbox sender writes to PostgreSQL; `GET /diagnostics/mailbox` reads it from any replica |
| Rate limits, stream slots, the job queue | holds | Valkey (Lua scripts, consumer group), as in milestone 1 |
| The fake provider's state | holds | PostgreSQL (`payments_fake_*`) |
| The fake provider's per-customer exclusion | holds, since the fix of K2 | was an in-process `Map` of promises with unconditional upserts; now a compare-and-set per customer in PostgreSQL (the operation retries on a conflict): every provider event of the runs after the fix processed, at most twice |
| The production default payment provider | holds, since the fix of K3 | was `memory`, in process (one replica returned a checkout's client secret, the other `null`); production now has `none`, which every replica answers the same way (`{"provider":"none"}`, `503 payments_not_configured`) |
| Experiment definitions | holds, since the fix of K4 | each process kept them 30 s, so replicas disagreed for up to 30 s after a start; a status change now takes effect at an instant 60 s ahead, the same on every replica |

### 9.10 Security headers with Stripe

The web app's CSP gains Stripe.js's sources only when `config.billing.paymentProvider` is
`stripe` (`webflix.web.csp` in `templates/_areas.tpl`): `script-src` and `connect-src` extended,
`frame-src` started from `default-src` and extended, exactly the sources and order of the
Worker's generator (`STRIPE_CSP_SOURCES`, `addCspSources` in
`apps/edge/scripts/lib/security-headers.ts`); compared byte for byte with that function's output.
The expression stays on `.Values.web.contentSecurityPolicy`, which the Worker's generator reads
from this template, so `apps/edge`'s header test still passes. **`Permissions-Policy:
payment=()` did block card wallets:** it disables the Payment Request API in every frame
whatever the frame's `allow` attribute (MDN, Permissions-Policy, read 2026-11-22), and Stripe's
Express Checkout and Payment Element run Apple Pay and Google Pay inside Stripe.js's frames
(docs.stripe.com/elements/express-checkout-element: `allow="payment"`). The header is now
`payment=(self "https://js.stripe.com" "https://*.js.stripe.com")` in the chart and the image's
default: delegable to Stripe.js's frames only, and inert unless the CSP lets those frames load,
which it does only with Stripe. It stays a literal so the Worker serves the same header (Stripe's
docs say nothing about this header; browsers that do not accept a wildcard origin ignore that
entry). Not verified in a browser with real wallets (no device; the blueprint says so too).

### 9.11 Findings in other areas (reported, not patched here)

**Status after the owners' fixes** (2026-11-23, deployed to this cluster and checked from
outside; the table below it is the finding as first reported):

| # | Fixed | What Kubernetes showed afterwards |
| --- | --- | --- |
| K1 | yes: every sync updates its subscription's checkouts; the confirmation looks again after its save | no checkout left `processing`; the 13 billing checks and `staff.refund` pass, behind five API replicas and two workers, except K12 below |
| K2 | yes: compare-and-set per customer in the fake's SQL store | first run on PostgreSQL: the fake's contract, the two-instance interleavings and the shared-store tests, 33 of 33, on PostgreSQL 19 (temporary copies of the SQLite tests, not kept); in the cluster all 776 provider events processed, at most two attempts each, none dead-lettered |
| K3 | yes: production defaults to `none` | `GET /billing/config` answers `{"provider":"none"}`; the production run's billing skips name the real reason and `billing.provider-config` passes (run D, §9.2); the chart's default and schema follow (`none`) |
| K4 | yes: status changes take effect at `statusChangeAt` (60 s ahead on Kubernetes; migration 0017 applied on PostgreSQL with data) | `experiments.assignment` passes in every run: "the start took effect at statusChangeAt (30 probe rounds before it: none assigned)" with five replicas |
| K5 | yes: spawned pools sized from the cgroup quota; a stalled pool exits 9 | the chart stopped forcing `--workers 1` (`pipeline.workers` unset); `make k8s-pipeline-smoke WORKERS=4`: compaction of 497 hours and an erasure (48 raw objects and 49 Parquet files rewritten, verified) on four spawned workers, no stall |
| K6 | yes: the lease probes the store and refuses on Garage (exit 10) unless the scheduler is declared the lock | `compact` started by hand on the bucket exits 10 ("…accepted a create-only write (If-None-Match: \*) onto an existing key and overwrote it…"); the lake round sets `WEBFLIX_RECS_LAKE_SERIALIZED=true` and its summaries say `"lakeLease": "scheduler"` |
| K7 | yes: a young lake is `nothing-to-train`, then `nothing-to-publish`, exit 0 | train-and-score on the product's lake completes in 12 s with the reason ("no play before … the ranker's 7-day window"); the importer's "No recs/current.json" is treated as success by the chart (§9.6) |
| K8 | yes: `export-events` reads and posts through the staff API | the chart's wrapper is gone; a member's export deferred under the grace, then completed and recorded by the next round; an erasure confirmed by the round after the cooling-off |
| K9 | yes: tokens renewed, rate-limit waits not counted | the strict run (C, 1 066 s) passed its staff and experiment checks |
| K10, K11 | corrected here (docs and the comment) | — |
| K12 (found in this round) | yes: a card-change poll that meets the completion running elsewhere answers `processing` (the next poll `succeeded`); every request-facing billing method answers the current state or a 503 on a busy provider or a lost race, never an unhandled 500; Stripe's 409 for a key in use maps to the same retryable answer | `billing.dunning` passes in four of four runs (F1 to F4 in §9.2, three relaxed and one strict, five API replicas and two workers); zero `http.unhandled_error`, zero 5xx in the API's and the gateway's logs over those runs. No chart change was needed |

| # | Owner | Where | Seen | The design calls for |
| --- | --- | --- | --- | --- |
| K1 | billing | `POST /billing/checkout/:id/confirm`, `GET /billing/checkout/:id`; `syncSubscription`/`afterWrite` (`packages/core/src/areas/billing/sync.ts`) | a trial checkout stays `processing` for ever beside a `trialing` membership whenever the worker processes the provider's events before the confirmation request saved the subscription's id on the checkout (10 billing checks and `staff.refund` fail on every conformance run; all pass with webhook delivery off) | "Polling a checkout that waits on the provider reads the provider: the membership activates when the provider says so, with or without a webhook"; "a checkout is complete once the membership it started is entitled". Evaluate `checkoutStatusFor` for the checkout being polled (and at the end of the confirmation) whether or not the projection changed |
| K2 | billing (payments-fake) | `FakePaymentProvider.withLock`, `createSqlFakeStore().write` | per-customer exclusion is an in-process `Map`; writes are unconditional upserts (the stored `version` is never compared), so two pods mutating one customer can lose an update | the fake's state "in the database … so it works on every dialect": a compare-and-set on `version` (retry the operation on conflict), as the projection already does |
| K3 | billing | `GET /billing/config`, `MemoryPaymentProvider.id`, `POST /billing/checkout` in production with no provider (the default `memory`) | answers `{"provider":"fake","formUrl":"/_pay/form"}`, a form production never serves; starts checkouts that can never complete, held per process (one replica returned the setup's client secret, the other `null`) | "a production deployment that names no provider can never complete a checkout": say so (no provider in the config, a refused checkout), not advertise the fake |
| K4 | experiments | `createRepositoryExperiments` (30 s process memo), `GET /session` assignments | for up to 30 s after a start, replicas disagree on whether the experiment runs: a profile's variant on one request, none on the next (`experiments.assignment` fails behind several replicas) | deterministic assignment per unit; across replicas a change must reach every process before members see it flip (a version key in the shared cache checked per read, or the suite waiting out the TTL if 30 s is accepted) |
| K5 | recommendation pipeline | `parallel.py` (`ProcessPoolExecutor`), `--workers` default | the pools fork (Python 3.13's default on Linux) after polars' and boto3's threads exist; an erase hung with every process on a futex; the default count is the node's CPUs (11) not the container's limit | `mp_context` `spawn` or `forkserver` for the pools, and a default from the CPUs the process may use (`os.sched_getaffinity`, the cgroup quota) |
| K6 | recommendation pipeline | `lease.py`, `S3Storage.put_if_absent` | on Garage `If-None-Match: *` is ignored: every concurrent writer "wins", the lease is granted twice, silently (§9.7) | the lease is the only thing keeping compaction, erasure and exports apart: detect a store that ignores the condition (a create-only write twice on a scratch key at start) and refuse unless the scheduler serialises the jobs |
| K7 | recommendation pipeline | `train-and-score --phase prepare` on an empty dataset | polars `SchemaError` (join keys `str` against `null`, `history.py`) and exit 1, on every fresh production lake until it has a closed hour of consented events | report nothing to train (exit 0, a summary saying so) |
| K8 | recommendation pipeline | `export-events --requests` takes a file only | the deployment needs a wrapper (`files/pipeline/export_round.py`, and `apps/edge/scripts/lib/pipeline-jobs.ts` on the Worker) for what `erase --keys api --confirm api` does natively; the README still says the operator route "does not exist yet" | `--requests api` / posting results, as `erase` does |
| K9 | conformance suite | `tools/smoke/src/env.ts` `staffToken` (memoised per run) | the development issuer's access tokens live 300 s; a run longer than that (strict limits on Kubernetes: 16 min) is refused `expired` on its last staff calls | fetch a new token when the old one is near its `exp` |
| K10 | Cloudflare | `apps/edge/scripts/deploy.ts` (comment), docs/CLOUDFLARE.md §10.2 and §10.5 | they describe the make fragment exporting `WEBFLIX_RELEASE` and the chart's `payment=()`; both changed here (§9.3, §9.10) | update the text; the Worker's `_headers` follow the chart's literal header by themselves |
| K11 | events (docs) | docs/BACKEND.md §3, "Download your data" | "until something runs the job (no deployment schedules it yet), a batch export stays processing" | Kubernetes schedules it now (the lake round) |
| K12 | billing | `GET /billing/payment-method/setup/:id` → `getPaymentMethodSetup` → `completeSetup` → `providerCall` (`packages/core/src/areas/billing/service.ts`) | `500 internal_error` in `billing.dunning` in two of three runs after the fixes: the poll completes the card change while the same completion runs elsewhere (the worker on the setup's event, or another replica's poll); the fake answers `PaymentProviderError` `unavailable` "a request with this key is in flight" (`default-card-<setup>`), and it reaches the HTTP layer unhandled (log `http.unhandled_error`, request `smk-a64ed4-1550`) | "card changes record success last and polls retry": a poll that meets the completion in flight elsewhere answers the setup's current state (still processing), and the next poll sees it finished; a provider's `unavailable` should never be a 500 |

**Found in the web step's round** (2026-11-23; reported, not patched here). Since then, seen on
the cluster: **K13 fixed** in the suite (`experiments.assignment` passes, "each experiment probed
until 2000 ms before its own instant: none assigned"); **K14 fixed** in the pipeline (the rerun
above); **K15 addressed**: the importer retries the invalidation three times and exits 3 when the
cache was still not told, which the chart's import step reports and counts as success (§9.6);
K16 stands.

| # | Owner | Where | Seen | The design calls for |
| --- | --- | --- | --- | --- |
| K13 | conformance suite | `tools/smoke/src/checks/experiments.ts` `awaitLive` | probes both experiments' assignments until the later of their two `statusChangeAt` instants, and right up to it: in G1 the profile probe left the suite 14 ms before the device experiment went live and reached the API (log 00:09:51.977Z) after the profile experiment had (its start answered at 00:08:51.956Z, 60 s ahead): "the profile's assignment before the start takes effect differs", `treatment`. The product did what it said. Only Kubernetes and Cloudflare run with a propagation delay, so only they can hit it | probe each experiment until its own instant, and stop a margin (the suite's `LIVE_MARGIN_MS`) before it |
| K14 | recommendation pipeline | `train-and-score` in its split form (prepare, the Node rule engine, finish), `AlreadyScored` | a cutoff already scored leaves neither the engine input nor the state file: the Node step fails (`ENOENT /work/train/engine-input.ndjson`, exit 1) and, past it, finish fails (`FileNotFoundError /work/train/train-and-score.json`). Any second run of a day's cutoff hits it: the CronJob's retry after its import failed (`backoffLimit: 1`), or a run started by hand, so a failed import is not retried until the next day's cutoff. Shown with the release's own pod on the simulated lake | prepare answers an already scored cutoff the way it answers nothing to train: an empty engine input and a state saying `already-scored`, so the Node step and finish pass and publish and import run again |
| K15 | personalisation (low) | the importer's cache invalidation (`RecommendationServing.invalidate`) in a one-shot process | the demo Job's first Valkey connection timed out (a new pod's first second, while the network policy is programmed; `connect ETIMEDOUT`), `cache.invalidate_failed` was logged as a warning and not retried; the import itself succeeded. Bounded: every replica rereads the model within `MODEL_MAX_AGE_MS` (30 s) | retry the invalidation briefly, or wait for Valkey before importing, as the API and worker pods do in their init container |
| K16 | events / privacy (design) | restore of a database backup (§5) | an account whose deletion was requested after the backup comes back whole, and nothing that survives the restore names it (`privacy.account_erased` logs the request id, deliberately not the account) | keep a record of completed erasures that survives a restore without identifying anyone by itself (for instance subject keys alongside the pipeline's erasure plan in the bucket) and replay it after a restore |

**K17: a burst of PIN checks answered 503 "The database cannot be reached"** (2026-11-22 and
2026-11-23; found by the conformance check `consistency.rate-limit-exact`; fixed in `apps/api` and
the PostgreSQL pool, 2026-11-23).

*Seen.* On 22 Nov, on API pods under three minutes old, the check got six 503s (`pg-pool`
"Connection terminated due to connection timeout"); put down to a rollout still settling, it
did not recur on two settled runs. On 23 Nov, on the two settled, idle API pods (the autoscaler's
minimum, 1 CPU each), the coordinator's run got `64×200, 14×429, 2×503`: both 503s were `PUT
/api/v1/session/profile`, 5 013 and 5 014 ms, a wait for a new database connection that ran into
its 5 s connect timeout, then the retryable answer. Nothing else failed (37 030 request lines).

*Reproduced on the cluster, old image* (`webflix-api:029ae82dd27d`, two idle pods held at two,
the check alone, each run after 20 s idle so the pool had closed its idle connections): 1 of 20
runs failed (`62×200, 15×429, 3×503`, the three requests 6 092 to 6 095 ms, "Connection terminated
due to connection timeout"). PostgreSQL showed the failing pod's connections opening one by one
over three seconds (1, 2, 5, 7, 10) where a passing run opened all ten within 0.8 s. In 19 of the
20 bursts the API's own health monitor marked the bucket down (`dependency.down blobs timed out
after 2000 ms`): its probe also opens a connection. The pods were CPU-throttled (1 CPU; 467 and 427
throttled periods over ten bursts), but the limit was not the CPU.

*The cause: libuv's threadpool.* scrypt runs on Node's threadpool, four threads by default, which
the process also needs for every DNS lookup (`dns.lookup` of `webflix-postgresql`) and for the
WebCrypto calls of PostgreSQL's SCRAM sign-in (node-postgres derives the SCRAM key with
`crypto.subtle` PBKDF2). The 64 admitted PIN checks handed 64 scrypt hashes to it at once; a
connection opened meanwhile queued its lookup and its key derivation behind all of them. Measured
inside an API pod (same image, same 1 CPU limit), 60 PIN hashes at once:

| During the burst | Idle | 60 hashes at once | 60 hashes, two at a time |
| --- | --- | --- | --- |
| `dns.lookup` of the database (threadpool) | 7 ms | **8 838 ms** | 18 ms |
| SCRAM's PBKDF2, 4 096 iterations (WebCrypto, threadpool) | 3 ms | **8 803 ms** | 2 ms |
| `dns.resolve4` (c-ares, no threadpool) | 3 ms | 3 ms | 2 ms |
| TCP connect to the database by address | 2 ms | 2 ms | 1 ms |
| all 60 hashed after | | 9.1 s | 7.9 s |

The TCP connect and a resolver outside the threadpool were unaffected, so the wait was the
threadpool's queue, not the CPU. Whether a run fails depends on whether a new connection is
opened before or after the hashes are queued: 1 run in 20 here, twice in the coordinator's
runs on the cluster.

*The fix.* (1) Hashing waits its turn in the process: `apps/api/src/hashing.ts` lets at most
`WEBFLIX_HASH_CONCURRENCY` hashes (default the threadpool's size minus two, so 2; a value that
would take the whole threadpool is refused) run at once, first come first served; the threadpool
keeps threads for lookups, file reads, compression and the sign-in. (2) A warm pool: the API keeps
`api.databasePoolMin` (4) connections open however idle (pg-pool's `min`), opens them before it
reports ready (`db.pool_warmed`) and refills them after a loss (`db.pool_refilled`). New gauges:
`webflix_db_pool_connections{state}` and `webflix_password_hashes{state}`. The 5 s connect
timeout is unchanged and the variant has no more replicas.

*After* (`webflix-api:5a8bd7e85fa3`, the same two idle pods, the same driver): **20 of 20 bursts
answered only 200 and 429**, no 5xx, no `dependency.down` (19 before). The check's own numbers:
59 to 63 of 80 admitted before and after (relaxed limits, plus refill); the burst took 4.6 to
6.7 s before (median 6.2), 4.1 to 5.8 s after (median 5.3); a PIN request's latency over the 20
bursts p50 1.76 s, p95 5.53 s, max 6.65 s before, p50 1.41 s, p95 4.79 s, max 5.72 s after.
PostgreSQL showed four connections open per API pod before each burst, ten during it, four after.
Database-backed requests that hash nothing (`GET /auth/email-status`, every 100 ms) answered in
p50 6 ms, p95 16 ms, max 126 ms during a burst (6, 8, 32 idle). Then the full suite on the
variant: 152 checks, 148 passed, 0 failed, 4 skipped, no 5xx in the API's logs or the gateway's.

*What a burst costs now, and the remaining limit.* A scrypt PIN or password check costs about
130 ms of CPU (60 in 7.9 s on one CPU, two at a time), so an API pod with one CPU verifies about
seven per second; a burst of 30 waits about 4 s for its last answer, 60 about 8 s, and nothing
else in the pod waits for it. The limit is CPU for hashing: a wave of sign-ins larger than the
pods' CPUs can hash in the gateway's 60 s (some 400 per CPU) would time out at the gateway, while
the autoscaler (CPU at 70 %) adds pods within a minute. The rate limits bound what one account or
address can ask for; the queue itself has no bound or deadline yet, so a request whose client
has gone still gets its hash computed.

### 9.12 Verified by running, and only reasoned about

Run on this machine: everything in the tables above marked measured or proved (the two
configurations deployed from an empty cluster, the conformance runs, the PostgreSQL suites, the
Keycloak and SMTP proofs, the lake lease probe, every pipeline step as a pod, the lake round on
the product's lake, the three-node cluster's spread and footprint, and `make k8s-outage
TARGET=valkey OUTAGE_SEC=20` on it with this chart: every API pod Ready throughout, web, plans,
segments, artwork and browse kept working, heartbeats 503 with `Retry-After` within 148 ms, no
restart, recovered by itself).

In the web step's round (2026-11-23, one node, the conformance variant): the console through the
gateway (curl and a headless Chromium sign-in, before and after the rebuild), `make k8s-test-web`
(26 checks), the access-log proof (§3), PostgreSQL's logging settings read back, the migrations
on data (§9.8) and `test:postgres`, `make k8s-recs-demo` (a `learned:` page for Alex on the first
images, `demo:` after the rebuild), `make k8s-verify` (journey, jobs, rollout: 137 222 requests,
0 failed, p99 48 ms), `make k8s-chaos` for Valkey and PostgreSQL, `make k8s-test-drift`, `make
k8s-ownership`, `deploy/kind/verify/pg-tls.sh` on the API image (with `WEBFLIX_ENV=development`
set by the script; the images themselves default to `production`, read back with `printenv`), `make
k8s-pipeline-smoke` twice (311 and 315 s; erase of one simulated account now 163 s), the lake
round's `retain` on the product's lake and on the simulated one (dry, real, again), the
train-and-score pod reading the erasure list twice and failing closed (exit 6), the bucket's
lifecycle probe, the two first-look conformance runs (§9.2). Not run in that round:
`make k8s-outage`, `k8s-partition` and `k8s-spread` (they need three nodes), `rotation.ts`, and
`make k8s-test-keycloak` and `k8s-test-smtp` (the production configuration, not the variant).

In the Kubernetes pass (2026-11-23): the production configuration from nothing (Keycloak,
Mailpit), the console signed in through Keycloak in a headless Chromium (§3), `make
k8s-test-keycloak` and `make k8s-test-smtp`; then the variant from nothing, the conformance suite
and the browser suite on Chromium and Firefox with the console project (§9.2), the lake round's
`retain` on the new image, `make k8s-pipeline-smoke` (311 s), train-and-score twice for one
cutoff and once on the product's lake (§9.6), `make k8s-test-web`. Not run in it: WebKit (the
screen was locked), the three-node scripts (`k8s-outage`, `k8s-partition`, `k8s-spread`), the
journey/jobs/rollout and chaos scripts (run in the web step's round on the previous images),
`rotation.ts`.

Reasoned, not run:

- **Keycloak's log on failed staff logins** (not tried), and whether a log pipeline keeps
  container logs longer than the kubelet does (§3, Access logs).
- **Garage's lifecycle expiry** being enforced (accepted and stored, not observed deleting).
- **Stripe as the provider on Kubernetes.** The chart renders Stripe's CSP and takes the keys
  through `secrets.envFrom`; no Stripe sandbox was created for this work, production refuses
  test keys, and the browser's enforcement of the CSP and `Permissions-Policy`, and wallets,
  need a browser and devices.
- **Keycloak beyond one instance**, and the realm import over an existing realm (skipped by
  design; not exercised).
- **What the lake round prevents.** The race it closes (two jobs rewriting one hour) was not
  provoked; the lease probe shows the lock is absent, the pipeline's own design names the races.
- **The fake provider's lost update across pods (K2).** Read in the code, never hit in a run;
  its fix was run on PostgreSQL through the fake's own two-instance tests, not provoked in the
  cluster.
- **The pipeline at the full preset** (forbidden on this machine) and a train-and-score that
  publishes (the gate refuses at smoke size, as documented).
