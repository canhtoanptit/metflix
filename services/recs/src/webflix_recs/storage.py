"""Object storage: one interface, a local implementation and an S3-compatible one.

The pipeline reads the event lake and writes artefacts through `Storage` only. Keys follow the
platform's blob key rules (`blobKeyProblem` in packages/contracts). Two implementations:

* `LocalStorage`: the on-disk layout of the dev mode's filesystem `BlobStore`
  (packages/adapters-node/src/fs-blob-store.ts): objects under `data/` with every byte outside
  `[a-z0-9._-]` percent-encoded and a `~` suffix, JSON metadata sidecars under `meta/`, writes
  staged in `tmp/` and renamed into place. So the API's dev-mode lake and the TypeScript
  importer see exactly what this pipeline reads and writes.
* `S3Storage`: any S3-compatible store (Garage in the chart, Cloudflare R2's S3 API), configured
  with the same `WEBFLIX_S3_*` variables as the API.

`put` replaces an object atomically in both: a reader sees the old or the new bytes, never a
mix. That property is what the publish step's pointer flip relies on.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
import uuid
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, unquote, urlparse

import orjson

MAX_KEY_BYTES = 1024
_CONTENT_TYPES = {
    "json": "application/json",
    "txt": "text/plain; charset=utf-8",
    "parquet": "application/vnd.apache.parquet",
    "gz": "application/gzip",
    "ndjson": "application/x-ndjson",
}


class InvalidKeyError(ValueError):
    pass


class ConditionalWriteUnsupported(RuntimeError):
    """The store refuses conditional writes outright (`NotImplemented`)."""


def key_problem(key: str) -> str | None:
    """Why `key` is not a valid blob key (same rules as packages/contracts), or None."""
    if not key:
        return "empty"
    if len(key.encode("utf-8")) > MAX_KEY_BYTES:
        return "too long"
    if key.startswith("/") or key.endswith("/"):
        return "leading or trailing slash"
    if re.search(r"[\\\x00-\x1f\x7f]", key):
        return "backslash or control character"
    if any(segment in {"", ".", ".."} for segment in key.split("/")):
        return "empty, '.' or '..' segment"
    return None


def assert_key(key: str) -> None:
    problem = key_problem(key)
    if problem is not None:
        raise InvalidKeyError(f"invalid blob key {key!r}: {problem}")


def content_type_for(key: str) -> str:
    extension = key.rsplit(".", 1)[-1].lower() if "." in key else ""
    return _CONTENT_TYPES.get(extension, "application/octet-stream")


@dataclass(frozen=True, slots=True)
class ObjectInfo:
    key: str
    size: int
    etag: str
    uploaded_at_ms: int


class Storage(Protocol):
    """What the pipeline needs from the blob store."""

    def describe(self) -> str: ...

    def get(self, key: str) -> bytes | None: ...

    def head(self, key: str) -> ObjectInfo | None: ...

    def put(self, key: str, data: bytes, *, content_type: str | None = None) -> ObjectInfo: ...

    def put_if_absent(self, key: str, data: bytes, *, content_type: str | None = None) -> bool:
        """Create the object only if no object has the key; False when one exists. Atomic on
        the filesystem layout and on stores that honour `If-None-Match: *` (AWS S3, R2 by its
        documentation); a store that ignores the header overwrites and answers True (lease.py
        probes for that); one that refuses it raises `ConditionalWriteUnsupported`."""
        ...

    def delete(self, keys: Iterable[str]) -> None: ...

    def list(self, prefix: str = "") -> Iterator[ObjectInfo]:
        """Every object whose key starts with `prefix`, in key (UTF-8 byte) order."""
        ...


def get_json(storage: Storage, key: str) -> Any | None:
    data = storage.get(key)
    return None if data is None else orjson.loads(data)


def put_json(storage: Storage, key: str, document: object) -> ObjectInfo:
    return storage.put(
        key,
        orjson.dumps(document, option=orjson.OPT_APPEND_NEWLINE),
        content_type="application/json",
    )


# --- Local (filesystem BlobStore layout) -------------------------------------------------------

_SAFE = frozenset(b"abcdefghijklmnopqrstuvwxyz0123456789._-")
_OBJECT_SUFFIX = "~"


def _encode_segment(segment: str) -> str:
    return "".join(chr(b) if b in _SAFE else f"%{b:02x}" for b in segment.encode("utf-8"))


def _decode_segment(name: str) -> str | None:
    if not re.fullmatch(r"(?:[a-z0-9._-]|%[0-9a-f]{2})*", name):
        return None
    try:
        return unquote(name, errors="strict")
    except UnicodeDecodeError:
        return None


class LocalStorage:
    """The dev mode's filesystem `BlobStore` layout (see module docstring)."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self._data = self.root / "data"
        self._meta = self.root / "meta"
        self._tmp = self.root / "tmp"

    def describe(self) -> str:
        return f"file://{self.root}"

    def _paths(self, key: str) -> tuple[Path, Path]:
        assert_key(key)
        relative = Path(*[_encode_segment(segment) for segment in key.split("/")])
        data = self._data / (str(relative) + _OBJECT_SUFFIX)
        meta = self._meta / (str(relative) + _OBJECT_SUFFIX + ".json")
        return data, meta

    def get(self, key: str) -> bytes | None:
        data, _ = self._paths(key)
        try:
            return data.read_bytes()
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            return None

    def head(self, key: str) -> ObjectInfo | None:
        data, meta = self._paths(key)
        try:
            stat = data.stat()
        except (FileNotFoundError, NotADirectoryError):
            return None
        if not data.is_file():
            return None
        return self._info(key, meta, stat)

    def _info(self, key: str, meta: Path, stat: os.stat_result) -> ObjectInfo:
        mtime_ms = stat.st_mtime_ns / 1e6
        try:
            stored = orjson.loads(meta.read_bytes())
            identity = stored.get("file", {})
            if (
                identity.get("ino") == stat.st_ino
                and identity.get("size") == stat.st_size
                and abs(float(identity.get("mtimeMs", -1)) - mtime_ms) < 1e-3
            ):
                return ObjectInfo(
                    key, int(stored["size"]), str(stored["etag"]), int(stored["uploadedAt"])
                )
        except (FileNotFoundError, NotADirectoryError, orjson.JSONDecodeError, KeyError, TypeError):
            pass
        # Same inference as the Node adapter for objects without a matching sidecar.
        etag = f"{stat.st_size:x}-{int(mtime_ms):x}"
        return ObjectInfo(key, stat.st_size, etag, int(mtime_ms))

    def _write_atomically(self, target: Path, data: bytes) -> None:
        self._tmp.mkdir(parents=True, exist_ok=True)
        temp = self._tmp / str(uuid.uuid4())
        try:
            with temp.open("wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            target.parent.mkdir(parents=True, exist_ok=True)
            temp.replace(target)
        except BaseException:
            temp.unlink(missing_ok=True)
            raise

    def put(self, key: str, data: bytes, *, content_type: str | None = None) -> ObjectInfo:
        target, meta = self._paths(key)
        self._write_atomically(target, data)
        stat = target.stat()
        uploaded = int(time.time() * 1000)
        etag = hashlib.sha256(data).hexdigest()[:32]
        sidecar = {
            "key": key,
            "size": len(data),
            "etag": etag,
            "contentType": content_type or content_type_for(key),
            "cacheControl": None,
            "uploadedAt": uploaded,
            "customMetadata": {},
            "file": {"ino": stat.st_ino, "size": stat.st_size, "mtimeMs": stat.st_mtime_ns / 1e6},
        }
        self._write_atomically(meta, orjson.dumps(sidecar))
        return ObjectInfo(key, len(data), etag, uploaded)

    def put_if_absent(self, key: str, data: bytes, *, content_type: str | None = None) -> bool:
        target, meta = self._paths(key)
        self._tmp.mkdir(parents=True, exist_ok=True)
        temp = self._tmp / str(uuid.uuid4())
        try:
            with temp.open("wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                # A hard link fails if the target exists: the atomic "create if absent".
                os.link(temp, target)
            except FileExistsError:
                return False
        finally:
            temp.unlink(missing_ok=True)
        stat = target.stat()
        sidecar = {
            "key": key,
            "size": len(data),
            "etag": hashlib.sha256(data).hexdigest()[:32],
            "contentType": content_type or content_type_for(key),
            "cacheControl": None,
            "uploadedAt": int(time.time() * 1000),
            "customMetadata": {},
            "file": {"ino": stat.st_ino, "size": stat.st_size, "mtimeMs": stat.st_mtime_ns / 1e6},
        }
        self._write_atomically(meta, orjson.dumps(sidecar))
        return True

    def delete(self, keys: Iterable[str]) -> None:
        for key in keys:
            data, meta = self._paths(key)
            data.unlink(missing_ok=True)
            meta.unlink(missing_ok=True)

    def list(self, prefix: str = "") -> Iterator[ObjectInfo]:
        fixed = prefix[: prefix.rfind("/")] if "/" in prefix else ""
        start = (
            self._data.joinpath(*[_encode_segment(s) for s in fixed.split("/")])
            if fixed
            else self._data
        )
        keys: list[str] = []
        if start.is_dir():
            for directory, _dirs, files in os.walk(start):
                for name in files:
                    if not name.endswith(_OBJECT_SUFFIX):
                        continue
                    path = Path(directory, name[: -len(_OBJECT_SUFFIX)])
                    segments = [
                        _decode_segment(part) for part in path.relative_to(self._data).parts
                    ]
                    if all(segment is not None for segment in segments):
                        key = "/".join(segment for segment in segments if segment is not None)
                        if key.startswith(prefix):
                            keys.append(key)
        keys.sort(key=lambda k: k.encode("utf-8"))
        for key in keys:
            info = self.head(key)
            if info is not None:
                yield info

    def local_path(self, key: str) -> Path:
        """Where an object's bytes live (for readers that memory-map large files)."""
        return self._paths(key)[0]


# --- S3-compatible ------------------------------------------------------------------------------


class S3Storage:
    """S3 API (Garage, R2, AWS). Configured like the API: `WEBFLIX_S3_*` variables."""

    def __init__(
        self,
        bucket: str,
        *,
        prefix: str = "",
        endpoint: str | None = None,
        region: str = "us-east-1",
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        force_path_style: bool = True,
    ) -> None:
        import boto3  # noqa: PLC0415 - only the S3 mode pays for importing botocore
        from botocore.config import Config  # noqa: PLC0415

        self.bucket = bucket
        self.prefix = prefix.strip("/") + "/" if prefix.strip("/") else ""
        self._client: Any = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            config=Config(
                s3={"addressing_style": "path" if force_path_style else "auto"},
                retries={"max_attempts": 5, "mode": "standard"},
                connect_timeout=3,
                read_timeout=30,
            ),
        )
        self._endpoint = endpoint

    @classmethod
    def from_environment(cls, bucket: str | None = None, prefix: str = "") -> S3Storage:
        env = os.environ
        return cls(
            bucket or env.get("WEBFLIX_S3_BUCKET", "webflix-media"),
            prefix=prefix,
            endpoint=env.get("WEBFLIX_S3_ENDPOINT") or None,
            region=env.get("WEBFLIX_S3_REGION", "us-east-1"),
            access_key_id=env.get("WEBFLIX_S3_ACCESS_KEY_ID") or None,
            secret_access_key=env.get("WEBFLIX_S3_SECRET_ACCESS_KEY") or None,
            force_path_style=env.get("WEBFLIX_S3_FORCE_PATH_STYLE", "true").lower()
            not in {"0", "false", "no"},
        )

    def describe(self) -> str:
        where = f" at {self._endpoint}" if self._endpoint else ""
        return f"s3://{self.bucket}/{self.prefix}{where}"

    def _key(self, key: str) -> str:
        assert_key(key)
        return self.prefix + key

    def _is_missing(self, error: Exception) -> bool:
        response = getattr(error, "response", None) or {}
        code = str(response.get("Error", {}).get("Code", ""))
        return code in {"NoSuchKey", "404", "NotFound"}

    def get(self, key: str) -> bytes | None:
        try:
            response = self._client.get_object(Bucket=self.bucket, Key=self._key(key))
        except Exception as error:
            if self._is_missing(error):
                return None
            raise
        body: bytes = response["Body"].read()
        return body

    def head(self, key: str) -> ObjectInfo | None:
        try:
            response = self._client.head_object(Bucket=self.bucket, Key=self._key(key))
        except Exception as error:
            if self._is_missing(error):
                return None
            raise
        return ObjectInfo(
            key,
            int(response["ContentLength"]),
            str(response.get("ETag", "")).strip('"'),
            int(response["LastModified"].timestamp() * 1000),
        )

    def put(self, key: str, data: bytes, *, content_type: str | None = None) -> ObjectInfo:
        response = self._client.put_object(
            Bucket=self.bucket,
            Key=self._key(key),
            Body=data,
            ContentType=content_type or content_type_for(key),
        )
        return ObjectInfo(
            key, len(data), str(response.get("ETag", "")).strip('"'), int(time.time() * 1000)
        )

    def put_if_absent(self, key: str, data: bytes, *, content_type: str | None = None) -> bool:
        try:
            self._client.put_object(
                Bucket=self.bucket,
                Key=self._key(key),
                Body=data,
                ContentType=content_type or content_type_for(key),
                IfNoneMatch="*",
            )
        except Exception as error:
            response = getattr(error, "response", None) or {}
            code = str(response.get("Error", {}).get("Code", ""))
            if code in {"PreconditionFailed", "412", "ConditionalRequestConflict", "409"}:
                return False
            if code in {"NotImplemented", "501"}:
                raise ConditionalWriteUnsupported(
                    f"{self.describe()} does not implement conditional writes (If-None-Match)"
                ) from error
            raise
        # A 200 means created only on a store that honours the header; Garage, for one, accepts
        # it and overwrites (lease.py probes for that before relying on this).
        return True

    def delete(self, keys: Iterable[str]) -> None:
        batch: list[dict[str, str]] = []
        for key in keys:
            batch.append({"Key": self._key(key)})
            if len(batch) == 1000:
                self._client.delete_objects(
                    Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True}
                )
                batch = []
        if batch:
            self._client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True}
            )

    def list(self, prefix: str = "") -> Iterator[ObjectInfo]:
        paginator = self._client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self.prefix + prefix):
            for item in page.get("Contents", []):
                key = str(item["Key"])[len(self.prefix) :]
                yield ObjectInfo(
                    key,
                    int(item["Size"]),
                    str(item.get("ETag", "")).strip('"'),
                    int(item["LastModified"].timestamp() * 1000),
                )


def open_storage(location: str) -> Storage:
    """`s3://bucket/prefix` (endpoint and credentials from WEBFLIX_S3_*), or a directory path
    (also `file:///path`) holding the filesystem BlobStore layout."""
    if location.startswith("s3://"):
        parsed = urlparse(location)
        query = parse_qs(parsed.query)
        storage = S3Storage.from_environment(parsed.netloc or None, prefix=parsed.path)
        if "endpoint" in query:
            storage = S3Storage(
                storage.bucket,
                prefix=parsed.path,
                endpoint=query["endpoint"][0],
                region=os.environ.get("WEBFLIX_S3_REGION", "us-east-1"),
                access_key_id=os.environ.get("WEBFLIX_S3_ACCESS_KEY_ID") or None,
                secret_access_key=os.environ.get("WEBFLIX_S3_SECRET_ACCESS_KEY") or None,
            )
        return storage
    if location.startswith("file://"):
        location = urlparse(location).path
    return LocalStorage(location)
