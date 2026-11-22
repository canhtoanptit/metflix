"""The lake lease refuses to pretend: on a store that ignores conditional writes (Garage) or
refuses them, acquiring it fails loudly (exit 10) unless the scheduler is declared to serialise
the lake jobs; on a directory or a store that honours them it is held."""

from __future__ import annotations

import os
import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import orjson
import pytest

from helpers import ANCHOR_MS, make_event, write_lake
from webflix_recs import cli, lake, lease
from webflix_recs.ids import iso_ms
from webflix_recs.storage import ConditionalWriteUnsupported, LocalStorage, S3Storage


class IgnoringStorage(LocalStorage):
    """What Garage v2.5.0 does: a create-only write overwrites and reports success."""

    def put_if_absent(self, key: str, data: bytes, *, content_type: str | None = None) -> bool:
        self.put(key, data, content_type=content_type)
        return True


class RefusingStorage(LocalStorage):
    def put_if_absent(self, key: str, data: bytes, *, content_type: str | None = None) -> bool:
        raise ConditionalWriteUnsupported("this store does not implement If-None-Match")


@pytest.fixture(autouse=True)
def fresh_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lease, "_PROBED", {})
    monkeypatch.setattr(lease, "LAST_MODE", None)
    monkeypatch.delenv(lease.SERIALIZED_ENV, raising=False)


def test_a_directory_holds_the_lease(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    holder = lease.acquire(storage, "compact")
    assert lease.LAST_MODE == "held"
    with pytest.raises(lease.LakeBusy):
        lease.acquire(storage, "erase")
    lease.release(storage, holder)
    assert [i.key for i in storage.list("recs-work/locks/")] == []  # the probe left nothing


@pytest.mark.parametrize("store", [IgnoringStorage, RefusingStorage])
def test_a_store_that_cannot_hold_it_refuses_loudly(tmp_path: Path, store: type) -> None:
    storage = store(tmp_path)
    with pytest.raises(lease.LeaseUnsupported, match="WEBFLIX_RECS_LAKE_SERIALIZED"):
        lease.acquire(storage, "erase")
    assert storage.get(lease.LAKE_LEASE_KEY) is None
    assert [i.key for i in storage.list("recs-work/locks/")] == []


def test_declaring_the_scheduler_serialises_the_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = IgnoringStorage(tmp_path)
    monkeypatch.setenv(lease.SERIALIZED_ENV, "true")
    holder = lease.acquire(storage, "compact")
    assert holder == lease.SCHEDULER and lease.LAST_MODE == "scheduler"
    assert storage.get(lease.LAKE_LEASE_KEY) is None  # neither probed nor taken
    lease.release(storage, holder)


def _run(args: list[str], capsys: pytest.CaptureFixture[str]) -> tuple[int, dict[str, Any]]:
    try:
        cli.main(args)
    except SystemExit as stop:
        capsys.readouterr()
        return int(stop.code or 0), {}
    return 0, orjson.loads(capsys.readouterr().out)


def test_what_an_operator_sees(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    write_lake(LocalStorage(tmp_path), [make_event("title.open", ANCHOR_MS - 3 * 3_600_000)])
    command = ["--store", str(tmp_path), "--workers", "1", "compact", "--now", iso_ms(ANCHOR_MS)]
    # A directory: the lease is held.
    code, summary = _run(command, capsys)
    assert code == 0 and summary["lakeLease"] == "held"
    # A store that ignores conditional writes (Garage): exit 10, nothing run.
    import webflix_recs.storage as storage_module

    monkeypatch.setattr(storage_module, "open_storage", IgnoringStorage)
    monkeypatch.setattr(lake, "open_storage", IgnoringStorage)
    monkeypatch.setattr(lease, "_PROBED", {})
    code, _ = _run(command, capsys)
    assert code == cli.EXIT_LEASE_UNSUPPORTED
    # Declared serialised by the scheduler: runs, and says how it was protected.
    code, summary = _run(["--lake-serialized", *command], capsys)
    assert code == 0 and summary["lakeLease"] == "scheduler"
    os.environ.pop(lease.SERIALIZED_ENV, None)


# --- An S3-compatible store that honours, ignores or refuses the condition ----------------------


def _free_port() -> int:
    for port in range(5800, 5810):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("no free port in 5800-5809")


@pytest.fixture
def s3() -> Iterator[S3Storage]:
    moto_server = pytest.importorskip("moto.server")
    port = _free_port()
    server = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=port, verbose=False)
    server.start()
    storage = S3Storage(
        "webflix-media",
        prefix="lease",
        endpoint=f"http://127.0.0.1:{port}",
        access_key_id="test",
        secret_access_key="test",
    )
    storage._client.create_bucket(Bucket="webflix-media")
    try:
        yield storage
    finally:
        server.stop()


def test_s3_honouring_ignoring_and_refusing(s3: S3Storage, monkeypatch: pytest.MonkeyPatch) -> None:
    # Honours If-None-Match (as AWS S3 does and R2 documents): held, and exclusive.
    holder = lease.acquire(s3, "compact")
    with pytest.raises(lease.LakeBusy):
        lease.acquire(s3, "erase")
    lease.release(s3, holder)
    # Accepts the header and ignores it, as Garage v2.5.0 does: refused.
    real = s3._client.put_object

    def ignoring(**kwargs: Any) -> Any:
        kwargs.pop("IfNoneMatch", None)
        return real(**kwargs)

    monkeypatch.setattr(s3._client, "put_object", ignoring)
    monkeypatch.setattr(lease, "_PROBED", {})
    with pytest.raises(lease.LeaseUnsupported, match="ignores conditional writes"):
        lease.acquire(s3, "erase")
    # Refuses it outright: refused too.
    from botocore.exceptions import ClientError

    def refusing(**kwargs: Any) -> Any:
        raise ClientError({"Error": {"Code": "NotImplemented", "Message": "no"}}, "PutObject")

    monkeypatch.setattr(s3._client, "put_object", refusing)
    monkeypatch.setattr(lease, "_PROBED", {})
    with pytest.raises(lease.LeaseUnsupported, match="does not implement conditional writes"):
        lease.acquire(s3, "erase")
