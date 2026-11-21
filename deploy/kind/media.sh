#!/usr/bin/env bash
# Upload a packaged media profile (.cache/media/<profile>, built by `make content`) into the
# cluster's bucket through the media pipeline's own uploader (tools/media, BlobStore port).
# The uploader runs in a container, so this needs Docker but no Node on the host; it reaches
# the in-cluster S3 API through a temporary port-forward on 127.0.0.1:$UPLOAD_PORT.
#
#   deploy/kind/media.sh fast|full
#
# Idempotent: objects already stored with the same SHA-256 are skipped. The manifest goes last,
# to manifests/media.json, where the seed Job reads it.
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/lib.sh"

PROFILE="${1:?usage: media.sh fast|full}"
MEDIA_DIR="$ROOT/.cache/media"
[ -f "$MEDIA_DIR/$PROFILE/manifest.json" ] || fail "No packaged media at .cache/media/$PROFILE (run: make content PROFILE=$PROFILE)"

secret() { kc -n "$NAMESPACE" get secret "$RELEASE-objectstore" -o "jsonpath={.data.$1}" | base64 -d; }
ACCESS_KEY="$(secret access-key-id)" || fail "Object store credentials not found: is the release installed?"
SECRET_KEY="$(secret secret-access-key)"
BUCKET="$(kc -n "$NAMESPACE" get configmap "$RELEASE-config" -o 'jsonpath={.data.WEBFLIX_S3_BUCKET}')"
REGION="$(kc -n "$NAMESPACE" get configmap "$RELEASE-config" -o 'jsonpath={.data.WEBFLIX_S3_REGION}')"

info "building the uploader image (tools/media)"
docker buildx bake -f "$ROOT/deploy/docker/docker-bake.hcl" --load media-tools >/dev/null 2>&1 \
  || fail "Could not build the media-tools image (docker buildx bake media-tools)."

# Port-forward to the S3 API; stopped on exit whatever happens.
pf_log="$(mktemp -t webflix-pf.XXXXXX)"
if (exec 3<>"/dev/tcp/127.0.0.1/$UPLOAD_PORT") 2>/dev/null; then
  FAIL_HINT="Free it (lsof -nP -iTCP:$UPLOAD_PORT -sTCP:LISTEN) or set WEBFLIX_UPLOAD_PORT (4500-4549)." \
    fail "Port $UPLOAD_PORT is already in use."
fi
# kubectl itself in the background (not a shell function): $! must be its PID to stop it.
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$NAMESPACE" port-forward "svc/$RELEASE-objectstore" \
  "$UPLOAD_PORT:3900" --address 127.0.0.1 >"$pf_log" 2>&1 &
PF_PID=$!
stop_port_forward() {
  kill "$PF_PID" 2>/dev/null || true
  wait "$PF_PID" 2>/dev/null || true
  rm -f "$pf_log"
}
trap stop_port_forward EXIT
for _ in $(seq 1 50); do
  grep -q "Forwarding from" "$pf_log" 2>/dev/null && break
  kill -0 "$PF_PID" 2>/dev/null || { cat "$pf_log" >&2; fail "kubectl port-forward to the object store failed."; }
  sleep 0.2
done

# Docker Desktop reaches the host's loopback as host.docker.internal; Linux shares the host
# network instead.
if [ "$(uname -s)" = "Darwin" ]; then
  NET_ARGS=(--add-host host.docker.internal:host-gateway)
  ENDPOINT="http://host.docker.internal:$UPLOAD_PORT"
else
  NET_ARGS=(--network host)
  ENDPOINT="http://127.0.0.1:$UPLOAD_PORT"
fi

info "uploading .cache/media/$PROFILE to s3://$BUCKET (in-cluster Garage)"
docker run --rm "${NET_ARGS[@]}" \
  --user "$(id -u):$(id -g)" \
  --volume "$MEDIA_DIR:/src/.cache/media" \
  --env WEBFLIX_S3_ENDPOINT="$ENDPOINT" \
  --env WEBFLIX_S3_REGION="$REGION" \
  --env WEBFLIX_S3_BUCKET="$BUCKET" \
  --env WEBFLIX_S3_FORCE_PATH_STYLE=true \
  --env WEBFLIX_S3_ACCESS_KEY_ID="$ACCESS_KEY" \
  --env WEBFLIX_S3_SECRET_ACCESS_KEY="$SECRET_KEY" \
  webflix-media-tools:dev upload --profile "$PROFILE" --target s3: \
  || fail "Media upload failed (see above)."
