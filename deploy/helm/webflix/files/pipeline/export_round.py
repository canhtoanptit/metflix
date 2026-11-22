"""One round of the data-export job on Kubernetes (pipeline.jobs.exportEvents).

services/recs's `export-events` takes the pending requests and returns the results as files
(services/recs/README.md, "Exports of members' events"); the product lists the requests and
takes the results through its staff API (docs/BACKEND.md §3, "Download your data"). This joins
the two, as `apps/edge/scripts/lib/pipeline-jobs.ts` does for the local Worker:

  GET  /system/privacy/exports      the requests whose events are not extracted yet
  GET  /system/privacy/erasures     subjects being erased (their exports yield nothing)
  webflix-recs export-events        the lake → privacy/export-events/{requestId}/ in the bucket
  POST /system/privacy/exports/results

A round with nothing pending costs one token and one list call. Exit codes: those of
export-events (0 done, 8 some requests failed and are kept listed), 6 when the staff API
refused or could not be reached. Standard library and the pipeline's own modules only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from webflix_recs.admin_api import AdminApi, AdminApiError


def log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}), file=sys.stderr, flush=True)


def main() -> int:
    started = time.monotonic()
    store = os.environ["WEBFLIX_RECS_STORE"]
    grace = os.environ.get("EXPORT_GRACE_MINUTES", "15")
    try:
        api = AdminApi.from_environment()
        pending = api._call("GET", "/system/privacy/exports?limit=100") or {}
        requests = pending.get("requests") or []
        if not requests:
            log("export_round.nothing_pending", seconds=round(time.monotonic() - started, 2))
            print(json.dumps({"pending": 0}))
            return 0
        erasures = api._call("GET", "/system/privacy/erasures?limit=500") or {"subjectKeys": []}
    except AdminApiError as error:
        log("export_round.staff_api_failed", error=str(error))
        return 6
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR", "/work")) as work:
        folder = Path(work)
        (folder / "requests.json").write_text(json.dumps({"requests": requests}))
        (folder / "erasures.json").write_text(json.dumps(erasures))
        results_file = folder / "results.json"
        run = subprocess.run(  # noqa: S603 - the pipeline's own CLI, fixed arguments
            [
                "webflix-recs",
                "--store",
                store,
                "--workers",
                os.environ.get("WEBFLIX_RECS_WORKERS", "1"),
                "export-events",
                "--requests",
                str(folder / "requests.json"),
                "--results",
                str(results_file),
                "--erasures",
                str(folder / "erasures.json"),
                "--grace-minutes",
                grace,
            ],
            check=False,
            stdout=subprocess.PIPE,
        )
        sys.stderr.flush()
        if run.returncode not in (0, 8) or not results_file.exists():
            log("export_round.job_failed", code=run.returncode)
            return run.returncode or 1
        results = json.loads(results_file.read_text())
        statuses: dict[str, int] = {}
        for result in results.get("results", []):
            statuses[result.get("status", "?")] = statuses.get(result.get("status", "?"), 0) + 1
        try:
            outcome = api._call(
                "POST",
                "/system/privacy/exports/results",
                {
                    **results,
                    "reason": "pipeline export-events CronJob (Kubernetes): the lake in the bucket",
                },
            )
        except AdminApiError as error:
            log("export_round.results_refused", error=str(error), statuses=statuses)
            return 6
    summary = {
        "pending": len(requests),
        "statuses": statuses,
        "outcome": outcome,
        "seconds": round(time.monotonic() - started, 2),
    }
    log("export_round.done", **summary)
    print(json.dumps(summary))
    return run.returncode


if __name__ == "__main__":
    sys.exit(main())
