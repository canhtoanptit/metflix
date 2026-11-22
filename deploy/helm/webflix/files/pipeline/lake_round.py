"""The jobs that rewrite the lake, one after another, for a store without conditional writes.

The pipeline's lake lease (services/recs, `lease.py`) is a create-only `PutObject` with
`If-None-Match: *`. Garage accepts the header and ignores it (measured on v2.5.0: a second
create-only write overwrites the first, 16 concurrent writers all "win", the lease is granted
twice), and its maintainers say conditional writes do not fit its replication model; the
pipeline now probes for that and refuses (exit 10) unless WEBFLIX_RECS_LAKE_SERIALIZED=true
says the scheduler is the lock. So with the in-chart store the three jobs that rewrite hours
(erase, export-events, compact) never run as separate CronJobs: this one round runs them in
order in one pod with that variable set, and its CronJob's `concurrencyPolicy: Forbid` is the
mutual exclusion the lease cannot give.

Per round, each step only when it has something to do:
  1. erase          keys pending at the staff API, or the last run older than ERASE_EVERY_HOURS
                    (the plan's watched keys: late arrivals of erased members)
  2. export-events  pending data exports (requests from and results to the staff API)
  3. compact        the last compaction older than COMPACT_EVERY_MINUTES

When each step last ran is kept in the bucket (recs-work/k8s/lake-round.json); this job is its
only writer. Exit status: 0, or the first failing step's code (each step still runs; failed
exports, export-events' 8, stay listed for the next round and do not fail it).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

from webflix_recs.admin_api import AdminApi, AdminApiError
from webflix_recs.storage import get_json, open_storage, put_json

STATE_KEY = "recs-work/k8s/lake-round.json"


def log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}), file=sys.stderr, flush=True)


def enabled(name: str) -> bool:
    return os.environ.get(name, "true").lower() not in {"0", "false", "no"}


def run(args: list[str]) -> int:
    started = time.monotonic()
    code = subprocess.run(args, check=False).returncode  # noqa: S603 - fixed commands
    log("lake_round.step", command=next((a for a in args if a in {"erase", "export-events", "compact"}), args[0]),
        code=code, seconds=round(time.monotonic() - started, 2))
    return code


def main() -> int:
    store_url = os.environ["WEBFLIX_RECS_STORE"]
    store = open_storage(store_url)
    state: dict[str, float] = get_json(store, STATE_KEY) or {}
    now = time.time()
    codes: list[int] = []
    recs = ["webflix-recs", "--store", store_url]
    if os.environ.get("WEBFLIX_RECS_WORKERS"):
        recs += ["--workers", os.environ["WEBFLIX_RECS_WORKERS"]]

    if enabled("LAKE_ERASE"):
        pending = None
        try:
            pending = len(AdminApi.from_environment().pending_erasures())
        except AdminApiError as error:
            log("lake_round.staff_api_failed", step="erase", error=str(error))
            codes.append(6)
        every = float(os.environ.get("ERASE_EVERY_HOURS", "24")) * 3600
        if pending or (pending is not None and now - state.get("erase", 0) >= every):
            code = run([*recs, "erase", "--keys", "api", "--confirm", "api", "--reason",
                        "pipeline lake round (Kubernetes): verified removal from the lake"])
            codes.append(code)
            if code == 0:
                state["erase"] = now

    if enabled("LAKE_EXPORT_EVENTS"):
        grace = os.environ.get("EXPORT_GRACE_MINUTES", "15")
        codes.append(run([*recs, "export-events", "--grace-minutes", grace]))

    if enabled("LAKE_COMPACT"):
        every = float(os.environ.get("COMPACT_EVERY_MINUTES", "60")) * 60
        if now - state.get("compact", 0) >= every:
            args = [*recs, "compact", "--grace-minutes", os.environ.get("COMPACT_GRACE_MINUTES", "15")]
            if os.environ.get("COMPACT_DELETE_SOURCES") == "true":
                args.append("--delete-sources")
            code = run(args)
            codes.append(code)
            if code == 0:
                state["compact"] = now

    put_json(store, STATE_KEY, state)
    # 8: some exports failed; they stay listed and the next round tries them again.
    failed = [code for code in codes if code not in (0, 8)]
    return failed[0] if failed else 0


if __name__ == "__main__":
    sys.exit(main())
