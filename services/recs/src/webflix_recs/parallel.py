"""Process pools, CPU budgets and native thread limits.

The jobs run on shared machines (a developer laptop next to a kind cluster, a Kubernetes node).

* **Pools start their workers with `spawn`**, never `fork`. Python 3.13 still forks by default
  on Linux, and a fork taken after polars', boto3's or OpenMP's threads exist can hand the child
  a lock held by a thread that does not exist there: an erasure hung that way on Kubernetes,
  every process asleep on a futex. A spawned worker starts a fresh interpreter (what macOS does
  by default, where the pipeline was developed and measured).
* **A pool that stops making progress is stopped**: if no task completes for
  `WEBFLIX_RECS_STALL_SECONDS` (default 1800), the workers are terminated and `WorkerStalled`
  is raised (CLI exit code 9). A job fails; it does not hang, which matters most for a privacy
  operation (an erasure that fails confirms nothing and is rerun; one that hangs holds the lake).
* **Budgets come from the CPUs this process may use**: the scheduler affinity, capped by a
  cgroup CPU quota (a container's limit), not the machine's CPU count. Default workers: that
  number minus one, at least 1 and at most 12 (one worker means no pool at all). Worker
  processes run with one native thread each; the main process's BLAS and OpenMP pools are capped
  by `WEBFLIX_RECS_THREADS` (default: half the usable CPUs, at most 8), because an oversubscribed
  OpenMP pool (scikit-learn's gradient boosting) slows down several-fold.
"""

from __future__ import annotations

import math
import multiprocessing
import os
from collections.abc import Callable, Iterable
from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, wait
from pathlib import Path
from typing import Any

DEFAULT_STALL_SECONDS = 1800.0
MAX_WORKERS = 12


class WorkerStalled(RuntimeError):
    """No worker finished a task within the stall timeout; the pool was stopped (exit 9)."""


def _cgroup_cpu_limit(root: Path = Path("/sys/fs/cgroup")) -> float | None:
    """The CPU quota of this process's cgroup in CPUs, or None when there is none (v2 `cpu.max`,
    v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us`)."""
    candidates: list[Path] = []
    try:
        for line in Path("/proc/self/cgroup").read_text().splitlines():
            parts = line.split(":", 2)
            if len(parts) == 3 and parts[0] == "0" and parts[1] == "":
                candidates.append(root / parts[2].lstrip("/") / "cpu.max")
    except OSError:
        pass
    candidates.append(root / "cpu.max")
    for path in candidates:
        try:
            quota, period = path.read_text().split()[:2]
        except (OSError, ValueError):
            continue
        if quota == "max":
            return None
        return int(quota) / int(period)
    for directory in (root / "cpu", root / "cpu,cpuacct"):
        try:
            quota_us = int((directory / "cpu.cfs_quota_us").read_text())
            period_us = int((directory / "cpu.cfs_period_us").read_text())
        except (OSError, ValueError):
            continue
        return None if quota_us <= 0 else quota_us / period_us
    return None


def usable_cpus() -> int:
    """CPUs this process may actually use: its affinity, capped by its cgroup's CPU quota."""
    affinity = getattr(os, "sched_getaffinity", None)  # Linux; not on macOS
    count = len(affinity(0)) if affinity is not None else (os.cpu_count() or 1)
    limit = _cgroup_cpu_limit()
    if limit is not None:
        count = min(count, max(1, math.floor(limit)))
    return max(1, count)


def default_workers() -> int:
    return max(1, min(MAX_WORKERS, usable_cpus() - 1))


def thread_budget() -> int:
    configured = os.environ.get("WEBFLIX_RECS_THREADS")
    if configured:
        return max(1, int(configured))
    return max(1, min(8, usable_cpus() // 2))


def limit_threads(threads: int | None = None) -> None:
    # Idle OpenMP workers sleep instead of spinning: on a busy machine spinning threads steal the
    # cores the busy ones need. Must be set before the runtime starts (first parallel region).
    os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
    os.environ.setdefault("KMP_BLOCKTIME", "0")
    from threadpoolctl import threadpool_limits  # noqa: PLC0415

    threadpool_limits(limits=threads or thread_budget())


def _single_threaded() -> None:
    limit_threads(1)


def process_pool(workers: int) -> ProcessPoolExecutor:
    """A pool whose workers are spawned (fresh interpreters), each single-threaded."""
    return ProcessPoolExecutor(
        max_workers=workers,
        mp_context=multiprocessing.get_context("spawn"),
        initializer=_single_threaded,
    )


def stall_seconds() -> float:
    configured = os.environ.get("WEBFLIX_RECS_STALL_SECONDS")
    return float(configured) if configured else DEFAULT_STALL_SECONDS


def _stop(pool: ProcessPoolExecutor) -> None:
    # No public API terminates a pool's processes; a stalled worker would block shutdown().
    processes = list((getattr(pool, "_processes", None) or {}).values())
    for process in processes:
        process.terminate()
    for process in processes:
        process.join(timeout=10)
    pool.shutdown(wait=False, cancel_futures=True)


def parallel_map[T, R](
    function: Callable[[T], R],
    jobs: Iterable[T],
    *,
    workers: int,
    on_result: Callable[[R], object] | None = None,
) -> list[R]:
    """`[function(job) for job in jobs]` in order, in `workers` spawned processes (inline when
    one worker or one job). Raises the first task's exception, or `WorkerStalled` when no task
    finishes within `stall_seconds()`; either way the pool's processes are gone afterwards."""
    items = list(jobs)
    if workers <= 1 or len(items) <= 1:
        results = []
        for item in items:
            result = function(item)
            if on_result is not None:
                on_result(result)
            results.append(result)
        return results
    timeout = stall_seconds()
    pool = process_pool(min(workers, len(items)))
    stopped = False
    try:
        futures: list[Future[Any]] = [pool.submit(function, item) for item in items]
        pending = set(futures)
        while pending:
            done, pending = wait(pending, timeout=timeout, return_when=FIRST_COMPLETED)
            if not done:
                _stop(pool)
                stopped = True
                raise WorkerStalled(
                    f"no worker finished a task in {timeout:g} s ({len(pending)} of "
                    f"{len(futures)} tasks left): the pool was stopped"
                )
            for future in done:
                result = future.result()  # the first failure ends the map
                if on_result is not None:
                    on_result(result)
        return [future.result() for future in futures]
    except BaseException:
        if not stopped:
            _stop(pool)
            stopped = True
        raise
    finally:
        if not stopped:
            pool.shutdown(wait=True)
