# Shared helpers for the kind workflow (sourced by up.sh, media.sh, ...). Bash 3.2 compatible
# (macOS ships it): no associative arrays, no ${var,,}, no mapfile.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIND_DIR="$ROOT/deploy/kind"
CHART="$ROOT/deploy/helm/webflix"

CLUSTER="${WEBFLIX_KIND_CLUSTER:-webflix}"
CONTEXT="kind-$CLUSTER"
# Webflix's own kubeconfig, in the repository's ignored cache: kind, kubectl and helm never read
# or write ~/.kube/config. Point other tools at it with: export KUBECONFIG=$(make -s k8s-kubeconfig)
KUBECONFIG_FILE="${WEBFLIX_KUBECONFIG:-$ROOT/.cache/kube/config}"
export KUBECONFIG="$KUBECONFIG_FILE"

# Only clusters named webflix* are ever created, touched or deployed to.
case "$CLUSTER" in
  webflix*) ;;
  *) printf 'Refusing: WEBFLIX_KIND_CLUSTER=%s is not a webflix* cluster.\n' "$CLUSTER" >&2; exit 1 ;;
esac
NAMESPACE="${WEBFLIX_NAMESPACE:-webflix}"
# The Helm release name. Not WEBFLIX_RELEASE: that is the product's own setting (the release
# stamped on server events, docs/BACKEND.md §4), and the make fragment's variables reach every
# recipe of the Makefile, dev mode and the Worker's included.
RELEASE="${WEBFLIX_HELM_RELEASE:-webflix}"
HOST_PORT=8080
BASE_URL="http://localhost:$HOST_PORT"
# Host ports for temporary port-forwards (4500-4549 is this workflow's range).
UPLOAD_PORT="${WEBFLIX_UPLOAD_PORT:-4510}"

# Platform add-ons, pinned.
ENVOY_GATEWAY_CHART="oci://docker.io/envoyproxy/gateway-helm"
ENVOY_GATEWAY_VERSION="v1.10.0"
METRICS_SERVER_REPO="https://kubernetes-sigs.github.io/metrics-server/"
METRICS_SERVER_CHART_VERSION="3.14.0"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_RESET=""
fi

STARTED_AT=$(date +%s)
STEP_STARTED_AT=$STARTED_AT

elapsed() { echo "$(( $(date +%s) - ${1:-$STARTED_AT} ))s"; }
step() {
  STEP_STARTED_AT=$(date +%s)
  printf '\n%s==>%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"
}
info() { printf '    %s\n' "$*"; }
ok() { printf '    %s✓%s %s %s(%s)%s\n' "$C_GREEN" "$C_RESET" "$*" "$C_DIM" "$(elapsed "$STEP_STARTED_AT")" "$C_RESET"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail() {
  printf '\n%s✗ %s%s\n' "$C_RED" "$*" "$C_RESET" >&2
  [ -n "${FAIL_HINT:-}" ] && printf '  %s\n' "$FAIL_HINT" >&2
  exit 1
}

# Both guards on every call: the repository kubeconfig and the explicit context.
kc() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" "$@"; }
hc() { helm --kubeconfig "$KUBECONFIG_FILE" --kube-context "$CONTEXT" "$@"; }

# Write the cluster's credentials into the repository kubeconfig (never the global one).
export_kubeconfig() {
  mkdir -p "$(dirname "$KUBECONFIG_FILE")"
  ( umask 077 && kind export kubeconfig --name "$CLUSTER" --kubeconfig "$KUBECONFIG_FILE" >/dev/null )
  chmod 600 "$KUBECONFIG_FILE"
}

# Refuse to go on unless the context resolves to this cluster's own API server: a mis-set
# environment must never deploy into another cluster.
assert_own_cluster() {
  local current server port
  current="$(kubectl --kubeconfig "$KUBECONFIG_FILE" config current-context 2>/dev/null || true)"
  [ "$current" = "$CONTEXT" ] \
    || fail "Refusing: the kubeconfig's current context is '$current', expected '$CONTEXT'."
  server="$(kubectl --kubeconfig "$KUBECONFIG_FILE" config view --minify --context "$CONTEXT" \
    -o 'jsonpath={.clusters[0].cluster.server}')"
  port="$(docker port "$CLUSTER-control-plane" 6443/tcp 2>/dev/null | head -n 1 | sed 's/.*://')"
  case "$server" in
    *":$port") ;;
    *) fail "Refusing: context $CONTEXT points at $server, not at $CLUSTER-control-plane (port ${port:-none})." ;;
  esac
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is not installed. $2"
}

# Helm 4.0.1 or later. Releases are applied server-side (--server-side, --force-conflicts) and
# waited on with --wait=watcher, none of which Helm 3 has (checked on 3.18.6 and 3.19.0);
# 4.0.0 upgrades fine but renders this chart offline (`helm template`) against Kubernetes 1.20,
# below its kubeVersion, which 4.0.1 fixed (checked on every 4.0.x).
HELM_MIN_VERSION=4.0.1
helm_version() { helm version --template '{{.Version}}' 2>/dev/null | sed -e 's/^v//' -e 's/[+-].*//'; }
version_at_least() { # <version> <minimum>, dotted numbers
  local IFS=. i
  local have=() need=()
  read -r -a have <<<"$1"
  read -r -a need <<<"$2"
  for i in 0 1 2; do
    case "${have[$i]:-0}" in *[!0-9]* | "") return 1 ;; esac
    [ "${have[$i]:-0}" -gt "${need[$i]:-0}" ] && return 0
    [ "${have[$i]:-0}" -lt "${need[$i]:-0}" ] && return 1
  done
  return 0
}
require_helm() {
  local version
  version="$(helm_version)"
  version_at_least "$version" "$HELM_MIN_VERSION" \
    || fail "Helm >= $HELM_MIN_VERSION is required, found ${version:-none}: releases are applied server-side (--force-conflicts) and waited on with --wait=watcher, which Helm 3 lacks. Install: https://helm.sh/docs/intro/install/"
}
# One line for make doctor.
helm_doctor() {
  local version
  version="$(helm_version)"
  if [ -z "$version" ]; then echo "helm: not installed (Kubernetes mode needs >= $HELM_MIN_VERSION)"
  elif version_at_least "$version" "$HELM_MIN_VERSION"; then echo "helm v$version (>= $HELM_MIN_VERSION: ok)"
  else echo "helm v$version: too old, Kubernetes mode needs >= $HELM_MIN_VERSION"; fi
}

cluster_exists() { kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; }

# Node count: one node for everyday work (cluster.yaml), three for the failure-injection
# targets (cluster-3.yaml). Fixed when the cluster is created.
cluster_config() { # <nodes>
  case "$1" in
    1) echo "$KIND_DIR/cluster.yaml" ;;
    3) echo "$KIND_DIR/cluster-3.yaml" ;;
    *) fail "NODES=$1: the kind cluster has 1 node (default) or 3 (failure injection)" ;;
  esac
}
cluster_nodes() { kind get nodes --name "$CLUSTER" 2>/dev/null | grep -c . || true; }

# For targets that take a node away or need zones: refuse, and say how, on a smaller cluster.
require_nodes() { # <minimum> <what>
  local have
  cluster_exists || fail "No kind cluster named $CLUSTER: make k8s-up NODES=$1 first."
  have="$(cluster_nodes)"
  if [ "$have" -lt "$1" ]; then
    FAIL_HINT="The node count is fixed when the cluster is created: make k8s-down && make k8s-up NODES=$1 (then make k8s-down && make k8s-up for the one-node cluster again)." \
      fail "$2 needs the $1-node cluster; '$CLUSTER' has $have node$([ "$have" = 1 ] || echo s)."
  fi
}

# Diagnostics for a failed rollout: what is not ready, and why.
diagnose() {
  printf '\n%sPods not ready in namespace %s:%s\n' "$C_BOLD" "$NAMESPACE" "$C_RESET" >&2
  kc -n "$NAMESPACE" get pods -o wide 2>/dev/null | awk 'NR==1 || $2 !~ /^([0-9]+)\/\1$/ || $3 != "Running"' >&2 || true
  for pod in $(kc -n "$NAMESPACE" get pods --no-headers 2>/dev/null | awk '$3 != "Running" && $3 != "Completed" {print $1}'); do
    printf '\n%s--- %s: recent events%s\n' "$C_BOLD" "$pod" "$C_RESET" >&2
    kc -n "$NAMESPACE" get events --field-selector "involvedObject.name=$pod" \
      --sort-by=.lastTimestamp 2>/dev/null | tail -n 5 >&2 || true
    printf '%s--- %s: last log lines%s\n' "$C_BOLD" "$pod" "$C_RESET" >&2
    kc -n "$NAMESPACE" logs "$pod" --all-containers --tail=15 2>/dev/null >&2 || true
  done
  printf '\nMore: make k8s-status · make k8s-logs C=<component> · KUBECONFIG=%s kubectl -n %s describe pod <name>\n' \
    "${KUBECONFIG_FILE#"$ROOT/"}" "$NAMESPACE" >&2
}

# Content-derived tag: an image rebuilt from an unchanged tree keeps its ID (bake pins
# timestamps and drops provenance), hence its tag, hence no rollout.
image_tag() {
  docker image inspect "$1" --format '{{.Id}}' | sed -e 's/^sha256://' | cut -c1-12
}

# The media checksum the current release last seeded with (empty without a release).
seeded_media_checksum() {
  hc -n "$NAMESPACE" get values "$RELEASE" -o json 2>/dev/null \
    | grep -o '"mediaChecksum":"[0-9a-f]*"' | cut -d'"' -f4 || true
}

# The deployed variant (deploy/kind/values-conformance.yaml sets the development environment).
deployed_variant() {
  if hc -n "$NAMESPACE" get values "$RELEASE" -o json 2>/dev/null | grep -q '"environment":"development"'; then
    echo conformance
  else
    echo production
  fi
}

# The packaged media profile to upload: MEDIA_PROFILE, else fast, else full (when built).
media_profile() {
  if [ -n "${MEDIA_PROFILE:-}" ]; then
    [ -f "$ROOT/.cache/media/$MEDIA_PROFILE/manifest.json" ] && echo "$MEDIA_PROFILE"
    return 0
  fi
  for profile in fast full; do
    if [ -f "$ROOT/.cache/media/$profile/manifest.json" ]; then echo "$profile"; return 0; fi
  done
  return 0
}

# --- Field ownership --------------------------------------------------------------------------
# Helm 4 applies a release server-side, as field manager "helm". A field changed out of band
# (kubectl set image / scale / edit / patch) gets a second manager; once the chart sets a
# different value, the API server refuses the apply ("conflict with \"kubectl-set\" ...") and
# the release is left `failed`. Lists such fields before an upgrade, one per line:
#   <kind>/<name> <manager> <field>
# Arguments: the values flags of the upgrade (-f, --set, ...).
HELM_FIELD_MANAGER=helm
ownership_conflicts() {
  local dir
  dir="$(mktemp -d -t webflix-ownership.XXXXXX)"
  if hc template "$RELEASE" "$CHART" -n "$NAMESPACE" --is-upgrade --dry-run=server --skip-tests \
    "$@" >"$dir/manifest.yaml" 2>"$dir/error"; then
    manifest_conflicts "$dir/manifest.yaml"
  else
    warn "field ownership not checked: $(head -n 1 "$dir/error")"
  fi
  rm -rf "$dir"
}

# The same for a rendered manifest (a file): a server-side dry run of every object as Helm.
manifest_conflicts() {
  local dir doc out object
  dir="$(mktemp -d -t webflix-ownership.XXXXXX)"
  awk -v dir="$dir" '/^---/ { n++; next } { print > (dir "/doc-" n ".yaml") }' "$1"
  for doc in "$dir"/doc-*.yaml; do
    grep -q '^kind:' "$doc" || continue
    # Jobs are new objects every revision (their name carries it): nothing to conflict with.
    grep -q '^kind: Job$' "$doc" && continue
    out="$(kc -n "$NAMESPACE" apply --server-side --dry-run=server \
      --field-manager="$HELM_FIELD_MANAGER" -f "$doc" 2>&1 >/dev/null)" && continue
    printf '%s\n' "$out" | grep -q 'conflict' || continue
    object="$(kc -n "$NAMESPACE" create --dry-run=client -o name -f "$doc" 2>/dev/null || echo "$doc")"
    # "conflict with "M" using V: FIELD", or "conflicts with "M" using V:" then "- FIELD" lines.
    printf '%s\n' "$out" | awk -v object="$object" '
      match($0, /conflicts? with "[^"]+"/) {
        manager = substr($0, RSTART, RLENGTH); sub(/^conflicts? with "/, "", manager); sub(/"$/, "", manager)
        rest = substr($0, RSTART + RLENGTH); sub(/^( using [^:]+)?:[ ]*/, "", rest)
        if (rest != "") print object, manager, rest
        next
      }
      /^- / && manager != "" { print object, manager, substr($0, 3) }'
  done
  rm -rf "$dir"
}

deployed_revision() { hc -n "$NAMESPACE" status "$RELEASE" -o yaml | awk '/^version:/ {print $2}'; }

# Change the release through Helm, never around it (scripts that need a different setting,
# image or replica count for a while): `reapply` = the release's current values plus the given
# flags; `rollback <revision>`. Both refuse (with the fields and managers) rather than overwrite
# changes made outside the release, and wait for the rollout and the Jobs.
release_change() {
  require_helm
  local action="$1" values manifest conflicts
  shift
  manifest="$(mktemp -t webflix-manifest.XXXXXX)"
  values="$(mktemp -t webflix-values.XXXXXX)"
  case "$action" in
    reapply)
      hc -n "$NAMESPACE" get values "$RELEASE" -o yaml >"$values"
      conflicts="$(ownership_conflicts -f "$values" "$@")"
      ;;
    rollback)
      hc -n "$NAMESPACE" get manifest "$RELEASE" --revision "$1" >"$manifest"
      conflicts="$(manifest_conflicts "$manifest")"
      ;;
    *) fail "release_change: reapply|rollback" ;;
  esac
  if [ -n "$conflicts" ]; then
    rm -f "$manifest" "$values"
    FAIL_HINT="$(ownership_hint "$conflicts")" fail "Not changing the release: it would overwrite changes made outside it."
  fi
  if [ "$action" = reapply ]; then
    hc upgrade "$RELEASE" "$CHART" -n "$NAMESPACE" -f "$values" "$@" \
      --wait=watcher --wait-for-jobs --timeout 10m >/dev/null
  else
    hc rollback "$RELEASE" "$1" -n "$NAMESPACE" --wait=watcher --wait-for-jobs --timeout 10m >/dev/null
  fi
  rm -f "$manifest" "$values"
}

# What to do about such fields (K8S_OWNERSHIP): take (default) gives them back to the release
# and names each one; strict stops before upgrading; off runs Helm as is.
ownership_hint() {
  printf '%s\n' \
    "Fields changed outside the release (manager, field):" \
    "$(printf '%s\n' "$1" | awk '{ printf "    %s  %s  %s\n", $1, $2, substr($0, index($0, $3)) }')" \
    "  Resolve: make k8s-redeploy (gives these fields back to the release and lists them)," \
    "  or undo the out-of-band change, or: helm upgrade ... --force-conflicts." \
    "  Everything the release does not own alone: node deploy/kind/verify/ownership.ts"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}
