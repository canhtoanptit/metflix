#!/usr/bin/env bash
# The whole recommendation pipeline at smoke size, as Kubernetes workloads against the cluster's
# bucket (make k8s-pipeline-smoke). The release's CronJobs run the pipeline on the product's
# own lake, which on a fresh cluster holds a few hundred events; this Job runs every step on a
# simulated smoke-size lake instead (300 accounts, 21 days ending now), under its own prefix
# `sim/` of the bucket (emptied first) so the product's lake is never touched, with the same
# images and the same S3 interface:
#
#   catalogue snapshot (Node) → simulate → compact → erase (one simulated account, verified)
#   → train-and-score --phase prepare → rule engine (Node) → --phase finish → publish (the gate
#   refuses at smoke size: expected) → analyse-experiments → the product's importers (Node)
#
# WORKERS=N passes --workers N to every pipeline step (default: the pipeline's own, from the
# container's CPU limit, 2 here: one worker); WORKERS=4 runs the process pools (spawned) for
# real. The Job is the sim/ prefix's only writer, so its steps declare the scheduler as the
# lake's lock (WEBFLIX_RECS_LAKE_SERIALIZED=true): Garage ignores the lease's conditional write.
#
# The importers read the run back from the bucket through a filesystem copy (`--from`), and
# import it with `--run` because publishing is refused at this size. Nothing here is a release
# object: the Job is deleted and recreated on every run, and `kubectl delete job
# webflix-pipeline-smoke` removes it.
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/lib.sh"

job="$RELEASE-pipeline-smoke"
cron="$RELEASE-recs-train-and-score"
kc -n "$NAMESPACE" get cronjob "$cron" >/dev/null 2>&1 \
  || fail "No CronJob $cron: deploy with the pipeline enabled first (make k8s-up)."
spec() { kc -n "$NAMESPACE" get cronjob "$cron" -o "jsonpath=$1"; }
RECS_IMAGE="$(spec '{.spec.jobTemplate.spec.template.spec.initContainers[?(@.name=="prepare")].image}')"
TOOLS_IMAGE="$(spec '{.spec.jobTemplate.spec.template.spec.initContainers[?(@.name=="catalog")].image}')"
BUCKET="$(kc -n "$NAMESPACE" get configmap "$RELEASE-config" -o 'jsonpath={.data.WEBFLIX_S3_BUCKET}')"
STORE="s3://$BUCKET/sim"

# 21 simulated days ending at the last full hour, so the run's lists are fresh (expiresAt = the
# cutoff + 3 days) when the product imports them.
END="$(date -u +%Y-%m-%dT%H:00:00.000Z)"
START="$(python3 -c "import datetime as d; e=d.datetime.strptime('$END','%Y-%m-%dT%H:%M:%S.000Z'); print((e-d.timedelta(days=21)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")"
COMPACT_AT="$(python3 -c "import datetime as d; e=d.datetime.strptime('$END','%Y-%m-%dT%H:%M:%S.000Z'); print((e+d.timedelta(hours=1, minutes=12)).strftime('%Y-%m-%dT%H:%M:%S.000Z'))")"

step "Pipeline at smoke size on $STORE (simulated $START .. $END, workers: ${WORKERS:-default})"
kc -n "$NAMESPACE" delete job "$job" --ignore-not-found --wait=true >/dev/null

workers_env=""
workers_args=""
[ -n "${WORKERS:-}" ] && workers_args="\"--workers\", \"$WORKERS\", "
[ -n "${WORKERS:-}" ] && workers_env="
            - {name: WEBFLIX_RECS_WORKERS, value: \"$WORKERS\"}"
recs_env='
          envFrom: [{configMapRef: {name: '"$RELEASE"'-config}}]
          env:
            - {name: WEBFLIX_RECS_STORE, value: "'"$STORE"'"}
            - {name: WEBFLIX_RECS_THREADS, value: "2"}
            - {name: WEBFLIX_RECS_LAKE_SERIALIZED, value: "true"}'"$workers_env"'
            - name: WEBFLIX_S3_ACCESS_KEY_ID
              valueFrom: {secretKeyRef: {name: '"$RELEASE"'-objectstore, key: access-key-id}}
            - name: WEBFLIX_S3_SECRET_ACCESS_KEY
              valueFrom: {secretKeyRef: {name: '"$RELEASE"'-objectstore, key: secret-access-key}}'
common='
          securityContext: {runAsUser: 10001, runAsGroup: 10001, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
          resources: {requests: {cpu: 200m, memory: 512Mi}, limits: {cpu: "2", memory: 2Gi}}
          volumeMounts: [{name: work, mountPath: /work}, {name: scripts, mountPath: /scripts}, {name: tmp, mountPath: /tmp}]'
recs() { # name, then the arguments of webflix-recs
  local name="$1" args
  shift
  args="$(printf '"%s", ' "$@")"
  printf '        - name: %s\n          image: %s\n          args: ["--store", "%s", %s%s]%s%s\n' \
    "$name" "$RECS_IMAGE" "$STORE" "$workers_args" "${args%, }" "$recs_env" "$common"
}
recs_sh() { # name, shell command
  printf '        - name: %s\n          image: %s\n          command: ["sh", "-c", %s]%s%s\n' \
    "$1" "$RECS_IMAGE" "$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "$recs_env" "$common"
}
tools() { # name, shell command (the API's environment: database, Valkey, bucket, app Secret)
  printf '        - name: %s\n          image: %s\n          workingDir: /src\n          command: ["sh", "-c", %s]\n          envFrom: [{configMapRef: {name: %s-config}}, {secretRef: {name: %s-app}}]\n          env:\n            - name: WEBFLIX_MEDIA_TOKEN_KEYS\n              valueFrom: {secretKeyRef: {name: %s-media-tokens, key: WEBFLIX_MEDIA_TOKEN_KEYS}}\n            - name: PGPASSWORD\n              valueFrom: {secretKeyRef: {name: %s-postgresql, key: password}}\n            - name: WEBFLIX_VALKEY_PASSWORD\n              valueFrom: {secretKeyRef: {name: %s-valkey, key: password}}\n            - name: WEBFLIX_S3_ACCESS_KEY_ID\n              valueFrom: {secretKeyRef: {name: %s-objectstore, key: access-key-id}}\n            - name: WEBFLIX_S3_SECRET_ACCESS_KEY\n              valueFrom: {secretKeyRef: {name: %s-objectstore, key: secret-access-key}}%s\n' \
    "$1" "$TOOLS_IMAGE" "$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$RELEASE" "$RELEASE" "$RELEASE" "$RELEASE" "$RELEASE" "$RELEASE" "$RELEASE" "$common"
}

# One simulated account erased from the lake (raw objects and the compacted hours), with the
# erasure's own verification pass; nothing to confirm (the product does not know the account).
read -r -d '' ERASE_ONE <<'SH' || true
key=$(python -c 'import gzip, json, os
from webflix_recs.storage import open_storage
s = open_storage(os.environ["WEBFLIX_RECS_STORE"])
print(next(k for i in s.list("events/") if i.key.endswith(".ndjson.gz")
           for l in gzip.decompress(s.get(i.key)).splitlines()
           for k in [(json.loads(l).get("subject") or {}).get("account")] if k))')
echo "erasing simulated account $key" >&2
echo "$key" | webflix-recs --store "$WEBFLIX_RECS_STORE" ${WEBFLIX_RECS_WORKERS:+--workers $WEBFLIX_RECS_WORKERS} \
  erase --keys - --confirm none --reason "pipeline smoke: one simulated account"
SH

manifest="$(mktemp -t webflix-pipeline-smoke.XXXXXX)"
trap 'rm -f "$manifest"' EXIT
{
  cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $job
  labels: {app.kubernetes.io/name: webflix, app.kubernetes.io/instance: $RELEASE, app.kubernetes.io/component: pipeline, webflix.dev/job: pipeline-smoke}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 1800
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels: {app.kubernetes.io/name: webflix, app.kubernetes.io/instance: $RELEASE, app.kubernetes.io/component: pipeline, webflix.dev/job: pipeline-smoke}
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext: {runAsNonRoot: true, seccompProfile: {type: RuntimeDefault}}
      volumes:
        - {name: work, emptyDir: {sizeLimit: 4Gi}}
        - {name: tmp, emptyDir: {sizeLimit: 256Mi}}
        - {name: scripts, configMap: {name: $RELEASE-pipeline}}
      initContainers:
EOF
  # The sim/ prefix starts empty on every run (an earlier run's simulated lake would overlap).
  recs_sh reset 'python -c "from webflix_recs.storage import open_storage; import os; s = open_storage(os.environ[\"WEBFLIX_RECS_STORE\"]); keys = [i.key for i in s.list(\"\")]; s.delete(keys); print(\"removed\", len(keys), \"objects\")"'
  tools catalog "node services/recs/scripts/export-catalog.ts --store /work/catalog --anchor $END"
  recs_sh catalog-upload "python /scripts/copy_objects.py /work/catalog $STORE catalog/"
  recs simulate simulate --preset smoke --start "$START" --truth /work/truth --experiment recs-aa --experiment "recs-ranking:effect=0.10"
  recs compact compact --now "$COMPACT_AT"
  recs_sh erase "$ERASE_ONE"
  recs prepare train-and-score --phase prepare --work /work/train --as-of "$END" --truth /work/truth
  tools rule-engine "node services/recs/scripts/rule-engine-rankings.ts --input /work/train/engine-input.ndjson --out-dir /work/train"
  recs finish train-and-score --phase finish --work /work/train --as-of "$END" --truth /work/truth
  # shellcheck disable=SC2016 # expanded by the container's shell, not here
  recs_sh publish 'webflix-recs --store "$WEBFLIX_RECS_STORE" publish; code=$?; [ "$code" = 3 ] && { echo "publish refused by the gate (exit 3), expected at smoke size" >&2; exit 0; }; exit $code'
  recs analyse analyse-experiments --as-of "$END"
  # shellcheck disable=SC2016
  recs_sh fetch-run 'python /scripts/copy_objects.py "$WEBFLIX_RECS_STORE" /work/simstore recs/ experiments/ recs-work/scored/ && python -c "from webflix_recs.storage import open_storage, get_json; print(get_json(open_storage(\"/work/simstore\"), \"recs-work/scored/latest.json\")[\"run\"])" > /work/run.txt && cat /work/run.txt'
  echo "      containers:"
  # shellcheck disable=SC2016
  tools import 'run=$(cat /work/run.txt) && node apps/api/src/recs.ts import --from /work/simstore --run "$run" && node apps/api/src/recs.ts experiments-import --from /work/simstore && node apps/api/src/recs.ts status'
} >"$manifest"

kc -n "$NAMESPACE" apply -f "$manifest" >/dev/null
info "job $job created; following its steps"
last=""
while :; do
  phase="$(kc -n "$NAMESPACE" get pods -l "job-name=$job" -o 'jsonpath={.items[0].status.phase}' 2>/dev/null || true)"
  current="$(kc -n "$NAMESPACE" get pods -l "job-name=$job" -o 'jsonpath={range .items[0].status.initContainerStatuses[*]}{.name}={.state.terminated.reason}{.state.running.startedAt} {end}{range .items[0].status.containerStatuses[*]}{.name}={.state.terminated.reason}{.state.running.startedAt}{end}' 2>/dev/null || true)"
  if [ "$current" != "$last" ]; then info "$current"; last="$current"; fi
  case "$phase" in Succeeded | Failed) break ;; esac
  sleep 5
done
pod="$(kc -n "$NAMESPACE" get pods -l "job-name=$job" -o 'jsonpath={.items[0].metadata.name}')"
for container in reset catalog catalog-upload simulate compact erase prepare rule-engine finish publish analyse fetch-run import; do
  printf '\n%s--- %s%s\n' "$C_BOLD" "$container" "$C_RESET"
  kc -n "$NAMESPACE" logs "$pod" -c "$container" 2>/dev/null | tail -n 4 | cut -c1-400 || true
done
[ "$phase" = Succeeded ] || fail "The pipeline Job failed (kubectl -n $NAMESPACE logs $pod -c <step>)."
ok "pipeline at smoke size: every step ran as a Kubernetes workload against $STORE"
