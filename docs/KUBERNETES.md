# Webflix on Kubernetes

The `k8s` deployment mode: the Helm chart in `deploy/helm/webflix`, the container images in
`deploy/docker`, and a local kind workflow in `deploy/kind` that runs it the way production
would. Companion documents: `docs/BACKEND.md` §5 (the API's side of this contract) and
`docs/BLUEPRINT.md` §4/§8.

```sh
make k8s-up          # from nothing to http://localhost:8080 (re-runnable)
make smoke TARGET=k8s
make k8s-down
```

---

## 1. Architecture

```
 browser ──► localhost:8080 ──► kind node :30080 ──► Envoy (Gateway API, 2 replicas)
                                                         │  HTTPRoute
              /api/*  /media/*  /cdn/*  ─────────────────┼──────────────► webflix-api   (Deployment, HPA 2–5 on kind / 3–12 default)
              everything else  ──────────────────────────┘──────────────► webflix-web   (nginx, static SPA, HPA 2–3)
                                                                               │
   webflix-worker (job consumer + scheduler) ◄── Valkey Streams ──┐            │
                                                                  ▼            ▼
                        webflix-valkey (AOF)   webflix-postgresql   webflix-objectstore (Garage, S3 API)
                        cache · rate limits ·  accounts, catalog,   bucket webflix-media: artwork,
                        stream leases · jobs   sessions, stats      previews, HLS, manifests
   Jobs per revision: webflix-migrate-N ──► webflix-seed-N (reads manifests/media.json from the bucket)
```

| Component | Image | Notes |
| --- | --- | --- |
| API, worker, migrate, seed | `webflix-api` (Alpine 3.24 + Node 26.8.1 binary, one esbuild bundle) | one image, four commands (`serve`, `worker`, `migrate`, `seed`, plus `wait` for init containers) |
| Web | `webflix-web` (nginxinc/nginx-unprivileged 1.30) | pre-gzipped assets, SPA fallback, security headers |
| PostgreSQL | `postgres:19.0-alpine3.24` (official, digest-pinned) | single primary, PVC, data checksums |
| Valkey | `valkey/valkey:9.2.0-alpine3.24` (official) | AOF `everysec`, `noeviction`, password from a Secret |
| Object storage | `dxflrs/garage:v2.5.0` (official) | single node, bucket + key bootstrapped from a Secret |
| Gateway | Envoy Gateway v1.10.0 (Gateway API v1.6.1 CRDs) | installed by `k8s-up` on kind; any conformant implementation in production |
| kind | `kindest/node:v1.37.0` (kind v0.33 digest) | 1 control plane + 2 workers labelled `zone-a`/`zone-b` |

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
| Cluster | `kind create cluster` from `deploy/kind/cluster.yaml` (3 nodes, port 8080 → NodePort 30080) | reused; stopped nodes started |
| Platform | Envoy Gateway (Helm, OCI), metrics-server, `EnvoyProxy` + `GatewayClass webflix` | skipped when the pinned versions are installed |
| Images | `docker buildx bake` (API + web), tagged by image ID, `kind load` | unchanged tree ⇒ same ID ⇒ nothing loaded, nothing rolls |
| Release | namespace with Pod Security `restricted`; field ownership check (below); `helm upgrade --install --wait=watcher --wait-for-jobs` | new revision: migrate + seed Jobs run (no-op when unchanged) |
| Media | if `.cache/media/<profile>/manifest.json` exists: upload through the media tool's `s3:` target (port-forward on 127.0.0.1:4510), then re-seed if the manifest changed | objects with the same SHA-256 are skipped |
| Verify | `/` and `/api/v1/plans` answer through the gateway | — |

Measured on a 12-core arm64 Mac: cold `make k8s-down && make k8s-up` (warm Docker cache)
**177 s**, of which the cluster takes 26 s, the platform 44 s, images 11 s, the release 36 s and
the 1.6 GB / 10 710-object media upload plus re-seed 60 s. A re-run with nothing changed:
**28 s**, no pod restarts (a new Helm revision whose Jobs are no-ops). `make k8s-redeploy`
after a code change: ~40 s, only changed components roll. A cold build without any Docker cache
adds roughly 2 min (base images, pnpm store).

Options: `MEDIA_PROFILE=fast|full`, `SKIP_MEDIA=1`, `SKIP_BUILD=1`, `RATE_LIMITS=relaxed`
(see §6) and `K8S_OWNERSHIP=take|strict|off` (below). Without packaged media every title plays the catalogue's external HLS fallback; run
`make content` then `make k8s-media` (or `k8s-up` again) and the next seed switches to packaged
media.

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
| `k8s-up` / `k8s-redeploy` / `k8s-media` | converge everything / rebuild and roll what changed / upload media and re-seed |
| `k8s-down` | delete the cluster (node containers and their volumes) and its kubeconfig |
| `k8s-clean` | `k8s-down` plus the `webflix-api`, `webflix-web`, `webflix-media-tools` images |
| `k8s-status`, `k8s-logs C=api`, `k8s-restart C=api` | inspect, follow logs, zero-downtime restart |
| `k8s-ownership`, `k8s-test-drift` | fields of the release owned outside Helm; the hot-patch → redeploy scenario (need Node) |
| `k8s-psql`, `k8s-valkey-cli` | shells into the in-cluster data stores |
| `k8s-lint`, `k8s-test` | chart lint + schema validation; plus template unit tests |
| `k8s-test-web`, `k8s-test-pg-tls` | the web image's nginx rules in a container; the API image against a TLS-only PostgreSQL with a private CA |
| `k8s-verify`, `k8s-chaos TARGET=valkey\|postgresql MODE=delete\|crash`, `k8s-outage TARGET=… OUTAGE_SEC=45` | end-to-end checks and failure injection (need Node) |
| `k8s-rotate-media-key STEP=add\|promote\|retire` | two-phase media token key rotation (§5) |
| `smoke TARGET=k8s` | the conformance suite (`tools/smoke`) |

`k8s-down` leaves: the Webflix images (so the next `k8s-up` is fast; `k8s-clean` removes them),
the BuildKit cache (`docker buildx prune` if you need the space; it is shared with other
projects, so it is never pruned automatically), and pulled base images (`kindest/node`,
`node`, `alpine`, `nginx-unprivileged`, `postgres`, `valkey/valkey`, `dxflrs/garage`, and the
`helmunittest`/`kubeconform` tool images used by `k8s-test`).

## 3. How the deployment behaves

### Routing

One `HTTPRoute` (Gateway API v1): `/api`, `/media`, `/cdn` → `webflix-api:80`, everything else →
`webflix-web:80`. Request timeouts: API 60 s, media 300 s, web 30 s.

**The web app** serves hashed `/assets/*` as `immutable`, the shell (`/`, `/index.html` and
every client-side route requested as a page load) as `no-cache`, and other files for an hour. A
missing file is a `404` problem document with `Cache-Control: no-store`, never the HTML shell:
anything under `/assets/`, and any path whose last segment has an extension unless it is a page
load (`Sec-Fetch-Mode: navigate`, or `Accept: text/html` from older clients); the Cloudflare
Worker applies the same rule. `deploy/docker/web/test.sh` (`make k8s-test-web`) checks all of
this against the image in a container.

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

**Access logs and media tokens.** Signed media URLs carry the playback token in the path. The
API logs the route pattern (`/media/:token/vod/…`). Envoy's access log is configured by the
platform's `EnvoyProxy`, not by this chart: the kind one (`deploy/kind/gateway.yaml`) logs
`/media/*` requests with the path replaced by `/media/[redacted]` (CEL `matches` select one of
two JSON formats; the request id still correlates them). Measured: a real 199-character token
appeared in 0 gateway log lines. On another gateway, do the same or drop the path for `/media`.

**Client IP.** The API trusts `X-Forwarded-For` counted from the right
(`config.trustedProxyHops`, default 1 = Envoy, which appends the peer address). Anything a
client sends itself is ignored: 14 sign-in attempts through the gateway with
`X-Forwarded-For: 1.2.3.N`, N different each time, gave 10 × 401 then 429. Add one hop per load
balancer in front of the gateway.

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
current and Valkey, so a pod that cannot work yet takes no traffic), **not draining**, and an
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

`values.yaml` holds production-leaning defaults; `deploy/kind/values.yaml` only shrinks
resources, adds CPU limits and picks the kind GatewayClass. `values.schema.json` rejects typos
and malformed values (e.g. `api.replica`, `rateLimits.auth: lots`).

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
| `config.databaseTimeouts.{request,background,maintenance}.{statementMs,queryMs}` | the roles' budgets: 5000 / 7000 (API), 60000 / 65000 (worker), 600000 / 605000 (Jobs) | server-side statement timeout / client-side bound (ms, 0 = none); `queryMs` must exceed `statementMs`, else the chart refuses to render |
| `config.databaseKeepAliveMs` | `null` = 10000 | TCP keepalive's first probe on database connections (0 = off) |
| `tcpKeepalive.{intervalSec,probes}` | 10 / 3 | `net.ipv4.tcp_keepalive_intvl` / `_probes` in the API, worker and Job pods (namespaced safe sysctls, allowed by Pod Security `restricted` since 1.29; checked on kind 1.37); `null` sets none |
| `api.shutdownDelaySec` / `terminationGracePeriodSeconds` | 5 / 40 | grace ≥ delay + 30 |
| `worker.replicas` / `worker.concurrency` | 2 / 4 | consumers share the queue |
| `web.contentSecurityPolicy` | same-origin, `https:` for media/XHR (external HLS fallback) | mounted over the image's default |
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
| Chart | `make k8s-test` | `helm lint --strict` on 4 value sets; kubeconform (Kubernetes 1.37 + CRD schemas): 145 resources valid; 75 template tests |
| In the cluster | `helm test webflix -n webflix` | ops `/readyz` 200 on `:4001` and 404 on the public port; plans, web shell, a missing asset 404 |
| Web image | `make k8s-test-web` | hashed asset `immutable`; missing `.js`/`.css`/`.png` 404 `no-store` problem, never HTML (also as a page load); deep links get the shell |
| TLS to PostgreSQL | `make k8s-test-pg-tls` | private CA refused without `tls.extraCaCerts`, accepted with it; plaintext refused; client certificate login |
| Conformance | `make smoke TARGET=k8s SMOKE_ARGS="--timeout 300000"` | 93 checks: 89 passed, 0 failed, 4 skipped (strict limits). `media.invalid-key-paths` passes with Envoy refusing `%00` itself (400, §3 Routing). Skips: `ops.health` (probes are not routed), `media.external-fallback` (every title is packaged), two `pipeline.*` (diagnostics are off in production) |
| Journeys, jobs, rollout | `make k8s-verify` | every request attributed to its pod via `X-Request-Id` |
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
`docker stats` on the node containers:

| Node container | CPU | Memory |
| --- | --- | --- |
| `webflix-control-plane` (API server, etcd, Envoy Gateway controller) | 9 % of a core | 1.3 GiB |
| `webflix-worker` | 9 % | 650 MiB |
| `webflix-worker2` | 3 % | 540 MiB |

The Webflix pods themselves use ~335 MiB together (API 57 MiB each, Garage 57, PostgreSQL 56,
worker 45, web 25 each, Valkey 13). Requests at minimum replicas: ~0.5 CPU, ~0.9 GiB.
`make k8s-down` gives all of it back.

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
