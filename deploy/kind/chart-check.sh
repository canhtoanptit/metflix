#!/usr/bin/env bash
# Chart checks, all in pinned containers or the host's Helm (make k8s-lint / make k8s-test):
#   lint   helm lint with every values set (defaults, kind, ci/*), then render each set and
#          validate it against the Kubernetes 1.37 and CRD (Gateway API, Envoy Gateway,
#          Prometheus Operator) JSON schemas with kubeconform
#   all    lint + the template unit tests (helm-unittest, deploy/helm/webflix/tests)
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/lib.sh"

MODE="${1:-all}"
HELM_UNITTEST_IMAGE="helmunittest/helm-unittest:4.3.0-1.2.1"
KUBECONFORM_IMAGE="ghcr.io/yannh/kubeconform:v0.8.0"
K8S_SCHEMA_VERSION="1.37.0"
CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
# Render as a cluster with these CRDs would (the chart adds optional resources for them).
API_VERSIONS=(
  --api-versions gateway.envoyproxy.io/v1alpha1/BackendTrafficPolicy
  --api-versions gateway.envoyproxy.io/v1alpha1/ClientTrafficPolicy
  --api-versions monitoring.coreos.com/v1/ServiceMonitor
)
VALUE_SETS=("" "$KIND_DIR/values.yaml" "$CHART/ci/external-values.yaml" "$CHART/ci/shared-gateway-values.yaml")

step "helm lint"
for values in "${VALUE_SETS[@]}"; do
  label="${values:-defaults}"
  args=()
  [ -n "$values" ] && args=(-f "$values")
  output="$(helm lint --strict "$CHART" --kube-version "$K8S_SCHEMA_VERSION" "${args[@]+"${args[@]}"}" 2>&1)" \
    || { echo "$output" >&2; fail "helm lint failed for ${label#"$ROOT/"}"; }
  info "clean: ${label#"$ROOT/"}"
done
ok "lint"

step "Schema validation (kubeconform, Kubernetes $K8S_SCHEMA_VERSION + CRD schemas)"
mkdir -p "${TMPDIR:-/tmp}/webflix-kubeconform-cache"
for values in "${VALUE_SETS[@]}"; do
  label="${values:-defaults}"
  args=()
  [ -n "$values" ] && args=(-f "$values")
  # A throwaway render without a cluster: allow generated credentials (the chart refuses them
  # under helm template / GitOps renders otherwise).
  helm template webflix "$CHART" -n webflix --kube-version "$K8S_SCHEMA_VERSION" \
    --set secrets.generateWithoutCluster=true \
    "${API_VERSIONS[@]}" "${args[@]+"${args[@]}"}" \
    | docker run --rm -i -v "${TMPDIR:-/tmp}/webflix-kubeconform-cache:/cache" "$KUBECONFORM_IMAGE" \
        -strict -summary -cache /cache -kubernetes-version "$K8S_SCHEMA_VERSION" \
        -schema-location default -schema-location "$CRD_SCHEMAS" - \
    || fail "rendered manifests are invalid for ${label#"$ROOT/"}"
done
ok "every rendered resource matches its schema"

if [ "$MODE" = "all" ]; then
  step "Template unit tests (helm-unittest)"
  docker run --rm -v "$CHART:/apps" "$HELM_UNITTEST_IMAGE" . \
    || fail "chart unit tests failed"
  ok "unit tests"
fi
