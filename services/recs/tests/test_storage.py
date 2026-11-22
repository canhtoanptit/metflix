"""Storage: the filesystem layout shared with the Node adapter, and the S3 implementation
against a local S3 stand-in (moto's server, in process, no Docker)."""

from __future__ import annotations

import gzip
import json
import os
from collections.abc import Iterator
from pathlib import Path

import orjson
import pytest

from webflix_recs.storage import InvalidKeyError, LocalStorage, S3Storage, Storage, key_problem

MOTO_PORT = 5790  # this pipeline's port range (5790-5809)


def test_local_layout_matches_the_node_filesystem_blob_store(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    storage.put("recs/v=20261013-000000-ab/Profiles/part 1.json", b"{}")
    # Same encoding as packages/adapters-node/src/fs-blob-store.ts: bytes outside [a-z0-9._-]
    # percent-encoded with lowercase hex, objects suffixed with "~", sidecars under meta/.
    data = tmp_path / "data/recs/v%3d20261013-000000-ab/%50rofiles/part%201.json~"
    meta = tmp_path / "meta/recs/v%3d20261013-000000-ab/%50rofiles/part%201.json~.json"
    assert data.read_bytes() == b"{}"
    sidecar = json.loads(meta.read_text())
    assert sidecar["key"] == "recs/v=20261013-000000-ab/Profiles/part 1.json"
    assert sidecar["contentType"] == "application/json"
    assert set(sidecar["file"]) == {"ino", "size", "mtimeMs"}


def test_local_reads_objects_written_by_hand_without_a_sidecar(tmp_path: Path) -> None:
    path = tmp_path / "data/events/dt=2026-10-01/hh=05/x.ndjson.gz~".replace("=", "%3d")
    path.parent.mkdir(parents=True)
    path.write_bytes(gzip.compress(b"{}\n"))
    storage = LocalStorage(tmp_path)
    infos = list(storage.list("events/"))
    assert [info.key for info in infos] == ["events/dt=2026-10-01/hh=05/x.ndjson.gz"]
    assert storage.get(infos[0].key) is not None


def test_listing_is_in_byte_order_and_respects_the_prefix(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    for key in ["b/2", "a/Z", "a/a", "a/b/c", "ab"]:
        storage.put(key, key.encode())
    assert [info.key for info in storage.list("a/")] == ["a/Z", "a/a", "a/b/c"]
    assert [info.key for info in storage.list("a")] == ["a/Z", "a/a", "a/b/c", "ab"]
    storage.delete(["a/a", "missing"])
    assert storage.get("a/a") is None


@pytest.mark.parametrize("key", ["", "/a", "a/", "a//b", "a/../b", "a\\b", "a\nb"])
def test_invalid_keys_are_refused(tmp_path: Path, key: str) -> None:
    assert key_problem(key) is not None
    with pytest.raises(InvalidKeyError):
        LocalStorage(tmp_path).put(key, b"")


@pytest.fixture(scope="module")
def s3() -> Iterator[S3Storage]:
    moto_server = pytest.importorskip("moto.server")
    server = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=MOTO_PORT, verbose=False)
    server.start()
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
    storage = S3Storage(
        "webflix-media",
        prefix="tests",
        endpoint=f"http://127.0.0.1:{MOTO_PORT}",
        access_key_id="test",
        secret_access_key="test",
    )
    storage._client.create_bucket(Bucket="webflix-media")
    try:
        yield storage
    finally:
        server.stop()


def _contract(storage: Storage) -> None:
    assert storage.get("missing/key") is None
    assert storage.head("missing/key") is None
    info = storage.put("recs/v=1/manifest.json", b'{"a":1}')
    assert info.size == 7
    assert storage.get("recs/v=1/manifest.json") == b'{"a":1}'
    head = storage.head("recs/v=1/manifest.json")
    assert head is not None and head.size == 7
    storage.put("recs/v=1/manifest.json", b'{"a":2}')  # replace
    assert storage.get("recs/v=1/manifest.json") == b'{"a":2}'
    for key in [
        "recs/v=1/profiles/part-00001.parquet",
        "recs/v=1/profiles/part-00000.parquet",
        "recs/current.json",
    ]:
        storage.put(key, b"x")
    assert [i.key for i in storage.list("recs/v=1/")] == [
        "recs/v=1/manifest.json",
        "recs/v=1/profiles/part-00000.parquet",
        "recs/v=1/profiles/part-00001.parquet",
    ]
    storage.delete([i.key for i in storage.list("recs/")])
    assert list(storage.list("recs/")) == []


def test_local_storage_contract(tmp_path: Path) -> None:
    _contract(LocalStorage(tmp_path))


def test_s3_storage_contract_against_a_local_stand_in(s3: S3Storage) -> None:
    _contract(s3)


def test_s3_storage_reads_a_lake_written_there(s3: S3Storage) -> None:
    from webflix_recs.lake import read_events

    event = orjson.loads((Path(__file__).parent / "fixtures" / "event.json").read_bytes())
    s3.put(
        "events/dt=2026-10-01/hh=05/0190-a.ndjson.gz", gzip.compress(orjson.dumps(event) + b"\n")
    )
    os.environ.update(
        WEBFLIX_S3_ENDPOINT=f"http://127.0.0.1:{MOTO_PORT}",
        WEBFLIX_S3_ACCESS_KEY_ID="test",
        WEBFLIX_S3_SECRET_ACCESS_KEY="test",
    )
    try:
        frames, stats, hours = read_events("s3://webflix-media/tests")
    finally:
        for name in (
            "WEBFLIX_S3_ENDPOINT",
            "WEBFLIX_S3_ACCESS_KEY_ID",
            "WEBFLIX_S3_SECRET_ACCESS_KEY",
        ):
            os.environ.pop(name, None)
    assert hours == 1
    assert stats.valid == 1
    assert frames[0]["event_id"].to_list() == [event["eventId"]]
