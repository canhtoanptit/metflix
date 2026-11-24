"""The demo run's Job (recs-demo.sh), from the train-and-score CronJob on stdin.

The CronJob's `import` container (the tools image with the API's environment) becomes the Job's
only container, its command replaced by `node apps/api/src/recs.ts demo`; the pod template's
labels, volumes and security settings are kept. Usage: recs-demo-job.py <job name> [--replace]
"""

import json
import sys

HELM_LABELS = {"helm.sh/chart", "app.kubernetes.io/managed-by"}


def demo_job(cron: dict, name: str, extra: list[str]) -> dict:
    template = cron["spec"]["jobTemplate"]
    pod = template["spec"]["template"]
    spec = pod["spec"]
    containers = [c for c in spec["containers"] if c["name"] == "import"]
    if not containers:
        raise SystemExit(f"{cron['metadata']['name']} has no container named import")
    container = containers[0]
    container["name"] = "demo"
    # Exit 3: published and imported, but the shared cache was not told after retries; every
    # replica serves the run within the model's 30 s age bound, so the Job succeeds and says so
    # (log and termination message), as the CronJob's import step does.
    script = (
        'node apps/api/src/recs.ts demo "$@"; code=$?; '
        'if [ "$code" = 3 ]; then msg="demo run imported, but the shared cache could not be told '
        'after retries (exit 3): every replica serves it within 30 s"; echo "$msg" >&2; '
        '{ printf "%s" "$msg" > /dev/termination-log; } 2>/dev/null; exit 0; fi; exit "$code"'
    )
    container["command"] = ["sh", "-c", script, "recs-demo", *extra]
    container.pop("args", None)
    spec["containers"] = [container]
    spec.pop("initContainers", None)
    # The release's labels (the network policies admit component=pipeline), minus Helm's own:
    # this Job is not a release object.
    def relabel(labels: dict) -> dict:
        kept = {k: v for k, v in labels.items() if k not in HELM_LABELS}
        return {**kept, "webflix.dev/job": "recs-demo"}

    labels = relabel(template.get("metadata", {}).get("labels", {}))
    pod.setdefault("metadata", {})
    pod["metadata"]["labels"] = relabel(pod["metadata"].get("labels", {}))
    job_spec = {key: value for key, value in template["spec"].items() if key != "template"}
    job_spec.update({"backoffLimit": 0, "activeDeadlineSeconds": 600, "ttlSecondsAfterFinished": 86400})
    job_spec["template"] = pod
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": name, "labels": labels},
        "spec": job_spec,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    json.dump(demo_job(json.load(sys.stdin), sys.argv[1], sys.argv[2:]), sys.stdout)
