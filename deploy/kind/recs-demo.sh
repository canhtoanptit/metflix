#!/usr/bin/env bash
# A demo recommendation run on the cluster (make k8s-recs-demo; docs/RECOMMENDATIONS.md, "A demo
# run"): lists for the demo account's profiles, so learned serving (Top Picks, the learned
# billboard) is on screen before the pipeline has a fresh run of its own. Not a trained model:
# the rule engine's scores for each demo profile's seeded library and content-similarity
# neighbours, labelled as such (run id *-de00de00, manifest code.demo: true).
#
# It runs `node apps/api/src/recs.ts demo` as a one-off Job made from the import step of the
# train-and-score CronJob: the tools image, the API's environment (database, bucket, and the app
# Secret's pseudonym key, so the lists are filed under the keys the API looks up), the same
# labels (network policies) and volumes. The command publishes the run into the bucket (version,
# then recs/current.json) and imports it with the product's importer, checksums included; every
# API replica serves it within the model cache's bound (30 s). The CronJob's own import then finds
# it already served, until the pipeline publishes a run of its own.
#
# Refused while a fresh pipeline run is served (REPLACE=1 replaces it anyway). The Job is deleted
# and recreated on every run; `kubectl delete job webflix-recs-demo` removes it.
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/lib.sh"

job="$RELEASE-recs-demo"
cron="$RELEASE-recs-train-and-score"
kc -n "$NAMESPACE" get cronjob "$cron" >/dev/null 2>&1 \
  || fail "No CronJob $cron: deploy with the pipeline enabled first (make k8s-up)."

step "Demo recommendation run ($job)"
kc -n "$NAMESPACE" delete job "$job" --ignore-not-found --wait=true >/dev/null
kc -n "$NAMESPACE" get cronjob "$cron" -o json \
  | python3 "$KIND_DIR/recs-demo-job.py" "$job" ${REPLACE:+--replace} \
  | kc -n "$NAMESPACE" apply -f - >/dev/null
info "job $job created"
if ! kc -n "$NAMESPACE" wait --for=condition=complete --timeout=300s "job/$job" >/dev/null 2>&1; then
  kc -n "$NAMESPACE" logs "job/$job" -c demo 2>/dev/null | tail -n 20 | cut -c1-600 || true
  fail "The demo run Job did not complete (kubectl -n $NAMESPACE logs job/$job -c demo)."
fi
kc -n "$NAMESPACE" logs "job/$job" -c demo | tail -n 1 | cut -c1-600
ok "demo run published and imported"
