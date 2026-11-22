"""Process pools: spawned workers (never forked after threads exist), a pool that stalls is
stopped and fails instead of hanging, and budgets come from the CPUs a container may use."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from webflix_recs import parallel
from webflix_recs.parallel import WorkerStalled, parallel_map, process_pool


def square(value: int) -> int:
    return value * value


def sleep_then(value: int) -> int:
    time.sleep(value)
    return value


def fail_on_three(value: int) -> int:
    if value == 3:
        raise ValueError("three")
    return value


def test_workers_are_spawned_never_forked() -> None:
    pool = process_pool(2)
    try:
        # Python 3.13 still forks by default on Linux; a fork after polars', boto3's or OpenMP's
        # threads exist can inherit a lock nobody will release (the Kubernetes erase hang).
        context = pool._mp_context
        assert context is not None and context.get_start_method() == "spawn"
    finally:
        pool.shutdown()
    assert parallel_map(square, range(6), workers=3) == [0, 1, 4, 9, 16, 25]


def test_a_failing_task_fails_the_map() -> None:
    with pytest.raises(ValueError, match="three"):
        parallel_map(fail_on_three, range(6), workers=2)


def test_a_stalled_pool_is_stopped_and_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEBFLIX_RECS_STALL_SECONDS", "3")
    started = time.monotonic()
    with pytest.raises(WorkerStalled, match="no worker finished a task"):
        parallel_map(sleep_then, [60, 60], workers=2)
    # Failed within the stall timeout (plus spawning), not after the tasks' 60 s.
    assert time.monotonic() - started < 30


def test_one_worker_or_one_job_runs_inline() -> None:
    # Inline (no pickling, no process): a lambda works.
    assert parallel_map(lambda _: os.getpid(), [1], workers=4) == [os.getpid()]
    assert parallel_map(lambda _: os.getpid(), [1, 2], workers=1) == [os.getpid(), os.getpid()]


def test_the_cpu_budget_follows_the_cgroup_quota(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    v2 = tmp_path / "v2"
    v2.mkdir()
    (v2 / "cpu.max").write_text("150000 100000\n")
    assert parallel._cgroup_cpu_limit(v2) == pytest.approx(1.5)
    (v2 / "cpu.max").write_text("max 100000\n")
    assert parallel._cgroup_cpu_limit(v2) is None
    v1 = tmp_path / "v1"
    (v1 / "cpu").mkdir(parents=True)
    (v1 / "cpu" / "cpu.cfs_quota_us").write_text("200000\n")
    (v1 / "cpu" / "cpu.cfs_period_us").write_text("100000\n")
    assert parallel._cgroup_cpu_limit(v1) == pytest.approx(2.0)
    (v1 / "cpu" / "cpu.cfs_quota_us").write_text("-1\n")
    assert parallel._cgroup_cpu_limit(v1) is None
    # A container limited to one CPU on an 11-CPU node: one worker (no pool), one thread.
    monkeypatch.setattr(parallel, "_cgroup_cpu_limit", lambda root=None: 1.0)
    monkeypatch.delenv("WEBFLIX_RECS_THREADS", raising=False)
    assert parallel.usable_cpus() == 1
    assert parallel.default_workers() == 1
    assert parallel.thread_budget() == 1
    monkeypatch.setattr(parallel, "_cgroup_cpu_limit", lambda root=None: 4.0)
    assert parallel.default_workers() == min(3, max(1, (os.cpu_count() or 1) - 1))
