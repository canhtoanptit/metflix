#!/usr/bin/env bash
# make k8s-up: from a machine with Docker, kind, Helm and kubectl to Webflix on
# http://localhost:8080, running as in production: several API replicas behind Envoy Gateway,
# Valkey, PostgreSQL, Garage (S3), the job worker, migrations and seed as Jobs.
#
# Safe to re-run: every step converges (existing cluster reused, unchanged images keep their
# tag so nothing rolls, Helm upgrades in place, media uploads skip what is already stored).
#
#   SKIP_BUILD=1     reuse the images already loaded (fast config-only redeploy)
#   MEDIA_PROFILE=   fast|full: packaged media to upload (default: whichever exists)
#   SKIP_MEDIA=1     do not upload media (titles play the external HLS fallback)
#   RATE_LIMITS=relaxed  the documented relaxed limits instead of the production ones
#   K8S_OWNERSHIP=   take (default): fields of release objects changed outside the release
#                    (kubectl set/scale/edit/patch) are listed and given back to the release;
#                    strict: list them and stop; off: plain helm upgrade
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/lib.sh"

printf '%sWebflix on kind%s  cluster=%s namespace=%s release=%s\n' "$C_BOLD" "$C_RESET" "$CLUSTER" "$NAMESPACE" "$RELEASE"

# --- 1. preflight ----------------------------------------------------------------------------
step "Preflight"
require_tool docker "Install Docker Desktop (or Docker Engine) and start it."
require_tool kind "Install kind >= 0.31: https://kind.sigs.k8s.io/docs/user/quick-start/#installation"
require_tool helm "Install Helm >= 3.18 (4.x recommended): https://helm.sh/docs/intro/install/"
require_tool kubectl "Install kubectl: https://kubernetes.io/docs/tasks/tools/"
docker info >/dev/null 2>&1 || fail "The Docker daemon is not reachable. Start Docker and retry."
docker buildx version >/dev/null 2>&1 || fail "docker buildx is missing (bundled with Docker Desktop / docker-buildx-plugin)."
if ! cluster_exists; then
  # Port 8080 must be free for the cluster's port mapping.
  if (exec 3<>"/dev/tcp/127.0.0.1/$HOST_PORT") 2>/dev/null; then
    FAIL_HINT="Stop whatever listens on $HOST_PORT (lsof -nP -iTCP:$HOST_PORT -sTCP:LISTEN), then retry." \
      fail "Port $HOST_PORT is already in use on this machine."
  fi
fi
ok "docker $(docker version --format '{{.Server.Version}}'), $(kind version | cut -d' ' -f1-2), helm $(helm version --short | cut -d+ -f1), kubectl $(kubectl version --client -o yaml | awk '/gitVersion/ {print $2; exit}')"

# --- 2. cluster --------------------------------------------------------------------------------
step "Cluster '$CLUSTER'"
if cluster_exists; then
  # After a Docker restart the node containers may be stopped.
  for node in $(kind get nodes --name "$CLUSTER"); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$node" 2>/dev/null)" != "true" ]; then
      info "starting stopped node $node"
      docker start "$node" >/dev/null
    fi
  done
  export_kubeconfig
  assert_own_cluster
  kc wait --for=condition=Ready nodes --all --timeout=180s >/dev/null \
    || fail "The cluster exists but its nodes are not Ready. Try: make k8s-down && make k8s-up"
  ok "reusing the existing cluster"
else
  mkdir -p "$(dirname "$KUBECONFIG_FILE")"
  # --kubeconfig: kind writes credentials (and its current-context) only to the repo's file.
  ( umask 077 && kind create cluster --config "$KIND_DIR/cluster.yaml" --name "$CLUSTER" \
      --kubeconfig "$KUBECONFIG_FILE" --wait 180s ) \
    || fail "kind could not create the cluster (see above)."
  chmod 600 "$KUBECONFIG_FILE"
  assert_own_cluster
  ok "created (1 control plane, 2 workers, Kubernetes $(kc version -o yaml | awk '/serverVersion/ {f=1} f && /gitVersion/ {print $2; exit}'))"
fi
info "kubeconfig: ${KUBECONFIG_FILE#"$ROOT/"} (~/.kube/config is never touched)"

# --- 3. platform add-ons ----------------------------------------------------------------------
step "Platform: Envoy Gateway $ENVOY_GATEWAY_VERSION, metrics-server"
installed_chart() { hc -n "$1" list --filter "^$2\$" --deployed -o yaml 2>/dev/null | awk '/chart:/ {print $2}'; }
if [ "$(installed_chart envoy-gateway-system eg)" != "gateway-helm-$ENVOY_GATEWAY_VERSION" ]; then
  info "installing Envoy Gateway (Gateway API CRDs included)"
  hc upgrade --install eg "$ENVOY_GATEWAY_CHART" --version "$ENVOY_GATEWAY_VERSION" \
    -n envoy-gateway-system --create-namespace --wait --timeout 10m >/dev/null \
    || fail "Envoy Gateway did not install. Check: KUBECONFIG=${KUBECONFIG_FILE#"$ROOT/"} kubectl -n envoy-gateway-system get pods"
fi
if [ "$(installed_chart kube-system metrics-server)" != "metrics-server-$METRICS_SERVER_CHART_VERSION" ] \
  || ! hc -n kube-system get values metrics-server 2>/dev/null | grep -q "memory: 128Mi"; then
  info "installing metrics-server (HPA)"
  hc upgrade --install metrics-server metrics-server --repo "$METRICS_SERVER_REPO" \
    --version "$METRICS_SERVER_CHART_VERSION" -n kube-system \
    --set 'args={--kubelet-insecure-tls}' \
    --set resources.requests.cpu=20m --set resources.requests.memory=64Mi \
    --set resources.limits.cpu=200m --set resources.limits.memory=128Mi \
    --wait --timeout 5m >/dev/null \
    || fail "metrics-server did not install."
fi
kc apply -f "$KIND_DIR/gateway.yaml" >/dev/null
kc wait --for=condition=Accepted gatewayclass/webflix --timeout=120s >/dev/null \
  || fail "GatewayClass 'webflix' was not accepted by Envoy Gateway."
ok "Envoy Gateway, GatewayClass 'webflix' (NodePort 30080 → localhost:$HOST_PORT), metrics-server"

# --- 4. images ----------------------------------------------------------------------------------
step "Images"
if [ -n "${SKIP_BUILD:-}" ] && docker image inspect webflix-api:dev webflix-web:dev >/dev/null 2>&1; then
  info "SKIP_BUILD set: reusing webflix-api:dev and webflix-web:dev"
else
  info "building webflix-api and webflix-web (BuildKit; cached layers make re-runs fast)"
  build_log="$(mktemp -t webflix-build.XXXXXX)"
  if ! docker buildx bake -f "$ROOT/deploy/docker/docker-bake.hcl" --load api web >"$build_log" 2>&1; then
    tail -n 40 "$build_log" >&2
    FAIL_HINT="Full log: $build_log. A broken web build is usually an in-progress edit in apps/web or packages/ui: retry later." \
      fail "Image build failed."
  fi
  rm -f "$build_log"
fi
API_TAG="$(image_tag webflix-api:dev)"
WEB_TAG="$(image_tag webflix-web:dev)"
docker tag webflix-api:dev "webflix-api:$API_TAG"
docker tag webflix-web:dev "webflix-web:$WEB_TAG"
# kind skips images a node already has.
kind load docker-image --name "$CLUSTER" "webflix-api:$API_TAG" "webflix-web:$WEB_TAG" >/dev/null \
  || fail "kind could not load the images into the nodes."
ok "webflix-api:$API_TAG ($(docker image inspect webflix-api:dev --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1e6}')), webflix-web:$WEB_TAG"

# --- 5. release ---------------------------------------------------------------------------------
# Restricted Pod Security: every pod of the chart must run unprivileged.
kc get namespace "$NAMESPACE" >/dev/null 2>&1 || kc create namespace "$NAMESPACE" >/dev/null
kc label namespace "$NAMESPACE" --overwrite >/dev/null \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted

deploy_release() { # $1: media checksum this revision seeds with
  local log pid last summary conflicts
  log="$(mktemp -t webflix-helm.XXXXXX)"
  local values=(-f "$KIND_DIR/values.yaml")
  [ "${RATE_LIMITS:-strict}" = "relaxed" ] && values+=(-f "$KIND_DIR/values-relaxed-limits.yaml")
  values+=(--set "api.image.tag=$API_TAG" --set "web.image.tag=$WEB_TAG" --set-string "seed.mediaChecksum=$1")
  local force=()
  if [ "${K8S_OWNERSHIP:-take}" != "off" ] && hc -n "$NAMESPACE" status "$RELEASE" >/dev/null 2>&1; then
    conflicts="$(ownership_conflicts "${values[@]}")"
    if [ -n "$conflicts" ]; then
      if [ "${K8S_OWNERSHIP:-take}" = "strict" ]; then
        FAIL_HINT="$(ownership_hint "$conflicts")" \
          fail "K8S_OWNERSHIP=strict: the release would overwrite changes made outside it; nothing was deployed."
      fi
      # The chart is the source of truth for a release this tooling manages: an operator's
      # hot-patch must not wedge every later deploy. Taking a field back is still worth a look.
      while IFS= read -r line; do
        warn "taking back $(printf '%s' "$line" | awk '{ print $1 " " substr($0, index($0, $3)) " from manager \"" $2 "\"" }') (changed outside the release)"
      done <<<"$conflicts"
      force=(--force-conflicts)
    fi
  fi
  hc upgrade --install "$RELEASE" "$CHART" -n "$NAMESPACE" "${values[@]}" "${force[@]+"${force[@]}"}" \
    --wait=watcher --wait-for-jobs --timeout 15m >"$log" 2>&1 &
  pid=$!
  last=""
  while kill -0 "$pid" 2>/dev/null; do
    sleep 4
    summary="$(kc -n "$NAMESPACE" get pods --no-headers 2>/dev/null | awk '
      { total++; split($2, r, "/"); if ($3 == "Completed" || ($3 == "Running" && r[1] == r[2])) ready++; else waiting = waiting " " $1 "(" $3 ")" }
      END { if (total) printf "%d/%d pods ready%s", ready, total, (waiting ? ";" waiting : "") }' | cut -c1-160)"
    if [ -n "$summary" ] && [ "$summary" != "$last" ]; then info "$summary"; last="$summary"; fi
  done
  if ! wait "$pid"; then
    tail -n 20 "$log" >&2
    if grep -q 'conflict occurred while applying object' "$log"; then
      # "conflict occurred while applying object NS/NAME GV, Kind=KIND: ... conflict with "M" using GV: FIELD"
      conflicts="$(grep -o 'applying object [^ ]* [^,]*, Kind=[A-Za-z]*: .*' "$log" | awk '
        { split($3, id, "/"); kind = $5; sub(/^Kind=/, "", kind); sub(/:$/, "", kind)
          if (match($0, /conflict with "[^"]+"/)) {
            manager = substr($0, RSTART + 15, RLENGTH - 16); rest = substr($0, RSTART + RLENGTH)
            sub(/^( using [^:]+)?:[ ]*/, "", rest); print tolower(kind) "/" id[2], manager, rest } }' | sort -u)"
      FAIL_HINT="$(ownership_hint "${conflicts:-see the Helm output above}")
  Helm output: $log" fail "The release was refused: it would overwrite fields changed outside it."
    fi
    diagnose
    FAIL_HINT="Helm output: $log" fail "The release did not become ready."
  fi
  rm -f "$log"
}

PROFILE="$(media_profile)"
SEEDED="$(seeded_media_checksum)"
step "Release '$RELEASE' (helm upgrade --install, migrate + seed Jobs)"
deploy_release "$SEEDED"
ok "revision $(hc -n "$NAMESPACE" history "$RELEASE" --max 1 -o yaml | awk '/revision:/ {print $2}') deployed (rate limits: ${RATE_LIMITS:-strict})"

# --- 6. media -------------------------------------------------------------------------------------
step "Media"
if [ -n "${SKIP_MEDIA:-}" ]; then
  info "SKIP_MEDIA set: media step skipped (the bucket keeps whatever was uploaded before)"
elif [ -z "$PROFILE" ]; then
  info "no packaged media in .cache/media (make content builds it): titles play the external HLS fallback"
  info "run 'make k8s-media' (or k8s-up again) once it exists"
else
  "$KIND_DIR/media.sh" "$PROFILE"
  CHECKSUM="$(sha256_file "$ROOT/.cache/media/$PROFILE/manifest.json")"
  if [ "$CHECKSUM" != "$SEEDED" ]; then
    info "manifest changed since the last seed: seeding again"
    deploy_release "$CHECKSUM"
  fi
  ok "packaged media ($PROFILE) in the bucket and seeded"
fi

# --- 7. verify ------------------------------------------------------------------------------------
step "Smoke check through the gateway"
deadline=$(( $(date +%s) + 120 ))
until curl -fsS -o /dev/null "$BASE_URL/" && curl -fsS -o /dev/null "$BASE_URL/api/v1/plans"; do
  [ "$(date +%s)" -gt "$deadline" ] && { diagnose; fail "$BASE_URL does not answer through the gateway."; }
  sleep 2
done
api_pods="$(kc -n "$NAMESPACE" get deployment "$RELEASE-api" -o 'jsonpath={.status.readyReplicas}' 2>/dev/null || true)"
ok "$BASE_URL serves the app and the API ($api_pods API replicas)"

printf '\n%sWebflix is up%s in %s: %s%s%s\n' "$C_GREEN$C_BOLD" "$C_RESET" "$(elapsed)" "$C_BOLD" "$BASE_URL" "$C_RESET"
cat <<EOF
  Demo account   demo@webflix.dev / webflix-demo
  API docs       $BASE_URL/api/docs
  Status         make k8s-status        Logs   make k8s-logs C=api|worker|web|seed
  Redeploy       make k8s-redeploy      Tear down   make k8s-down
EOF
