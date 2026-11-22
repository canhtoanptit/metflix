"""Process pools and native thread limits.

The jobs run on shared machines (a developer laptop next to a kind cluster, a Kubernetes node).
Worker processes run with one native thread each; the main process's BLAS and OpenMP pools are
capped by `WEBFLIX_RECS_THREADS` (default: half the CPUs, at most 8), because an oversubscribed
OpenMP pool (scikit-learn's gradient boosting) slows down several-fold rather than degrading
gracefully.
"""

from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor


def thread_budget() -> int:
    configured = os.environ.get("WEBFLIX_RECS_THREADS")
    if configured:
        return max(1, int(configured))
    return max(1, min(8, (os.cpu_count() or 2) // 2))


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
    return ProcessPoolExecutor(max_workers=workers, initializer=_single_threaded)
