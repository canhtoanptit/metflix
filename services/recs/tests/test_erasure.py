"""`erase`: an erased member's subject leaves raw objects, compacted hours, the quarantine,
datasets and artefacts alike; nothing is confirmed unless verification passes; a rerun after a
failure anywhere finishes the job; compaction and erasure never overlap."""

from __future__ import annotations

import base64
import gzip
import http.server
import io
import os
import socket
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any, ClassVar

import orjson
import polars as pl
import pytest

from helpers import ANCHOR_MS, make_event, write_lake, write_version
from webflix_recs import artefacts, cli, erasure, lease, schemas
from webflix_recs.erasure import PLAN_KEY, ErasureIncomplete, erase, load_plan, mark_confirmed
from webflix_recs.ids import DAY_MS, HOUR_MS, iso_ms, partition_prefix
from webflix_recs.lake import COMPACTION_MANIFEST, compact, list_hours, read_events
from webflix_recs.storage import LocalStorage, get_json, put_json

ERASED = "E" * 22  # the account being erased
ERASED_PROFILE = "e" * 22  # its profile: discovered from the lake
KEEP = "K" * 22
KEEP_PROFILE = "k" * 22
H1 = ANCHOR_MS - 3 * DAY_MS
H2 = H1 + 5 * HOUR_MS


def _event(kind: str, at: int, account: str, profile: str, **extra: Any) -> dict[str, Any]:
    return make_event(kind, at, account=account, profile=profile, **extra)


def _contains(body: bytes, *keys: str) -> bool:
    return any(key.encode() in body for key in keys)


def _everything(storage: LocalStorage) -> dict[str, bytes]:
    """Every object's content as a reader would see it (raw objects decompressed, Parquet
    files' text columns, everything else as stored)."""
    seen: dict[str, bytes] = {}
    for info in storage.list():
        body = storage.get(info.key) or b""
        if info.key.endswith(".gz"):
            body = gzip.decompress(body)
        elif info.key.endswith(".parquet"):
            frame = pl.read_parquet(io.BytesIO(body))
            body = orjson.dumps(
                {
                    name: [str(v) for v in frame[name].to_list()]
                    for name in frame.columns
                    if frame[name].dtype == pl.String
                }
            )
        seen[info.key] = body
    return seen


def build_store(root: Path) -> LocalStorage:
    storage = LocalStorage(root)
    hour1 = [_event("title.open", H1 + i * 60_000, ERASED, ERASED_PROFILE) for i in range(6)]
    hour1 += [_event("title.open", H1 + i * 60_000 + 7, KEEP, KEEP_PROFILE) for i in range(8)]
    write_lake(storage, hour1, "a")
    # Hour 1 is compacted, its sources kept (the default): the subject is in both.
    compact(str(root), now_ms=H1 + 2 * HOUR_MS)
    # A straggler after compaction (a late outbox drain), mixed accounts.
    write_lake(
        storage,
        [
            _event("playback.start", H1 + 50 * 60_000, ERASED, ERASED_PROFILE),
            _event("playback.start", H1 + 51 * 60_000, KEEP, KEEP_PROFILE),
        ],
        "straggler",
    )
    # Hour 2 is not compacted: one object only the subject's, one mixed.
    write_lake(storage, [_event("title.open", H2 + 1, ERASED, ERASED_PROFILE)], "only")
    write_lake(
        storage,
        [
            _event("title.open", H2 + 2, ERASED, ERASED_PROFILE),
            _event("title.open", H2 + 3, KEEP, KEEP_PROFILE),
        ],
        "mixed",
    )
    # A consent change of the account: no profile (it carries the account only).
    consent = _event("consent.change", H2 + 4, ERASED, ERASED_PROFILE)
    consent["subject"]["profile"] = None
    write_lake(storage, [consent], "consent")
    # The quarantine: an invalid event of the subject and a line that is not even JSON.
    bad = orjson.dumps({"eventId": "x", "subject": {"account": ERASED, "profile": None}})
    storage.put(
        f"events-quarantine/{partition_prefix(H2).removeprefix('events/')}q.ndjson.gz",
        gzip.compress(bad + b"\nnot json " + ERASED.encode() + b"\n" + b'{"other": 1}\n'),
    )
    # A dataset: the profiles table maps the account to its profile.
    prefix = "recs-work/datasets/d1/"
    tables = {
        "profiles": pl.DataFrame(
            {"profile": [ERASED_PROFILE, KEEP_PROFILE], "account": [ERASED, KEEP]}
        ),
        "playback": pl.DataFrame(
            {"profile": [ERASED_PROFILE, KEEP_PROFILE, ERASED_PROFILE], "watched_sec": [1.0, 2, 3]}
        ),
        "accounts": pl.DataFrame({"account": [ERASED, KEEP], "state": ["active", "active"]}),
    }
    for name, frame in tables.items():
        buffer = io.BytesIO()
        frame.write_parquet(buffer)
        storage.put(f"{prefix}{name}.parquet", buffer.getvalue())
    put_json(
        storage,
        prefix + "manifest.json",
        {"datasetId": "d1", "rows": {name: frame.height for name, frame in tables.items()}},
    )
    # Two artefact versions: an older one and the published one, both listing the profile.
    write_version(
        storage, "20261001-000000-0123abcd", {ERASED_PROFILE: ["t-1"], KEEP_PROFILE: ["t-2"]}
    )
    write_version(
        storage, "20261002-000000-0123abcd", {ERASED_PROFILE: ["t-3", "t-4"], KEEP_PROFILE: ["t-5"]}
    )
    return storage


def _kept_events(root: Path) -> list[str]:
    frames, _, _ = read_events(str(root))
    return sorted({i for f in frames for i in f["event_id"].to_list()})


def test_erase_removes_the_subject_everywhere_and_leaves_the_rest(tmp_path: Path) -> None:
    storage = build_store(tmp_path)
    frames, _, _ = read_events(str(tmp_path))
    before = {row["event_id"]: row["account"] for f in frames for row in f.iter_rows(named=True)}
    keep_ids = sorted(i for i, account in before.items() if account == KEEP)
    run = "20261002-000000-0123abcd"
    assert any(_contains(body, ERASED, ERASED_PROFILE) for body in _everything(storage).values())

    outcome = erase(str(tmp_path), [ERASED], now_ms=ANCHOR_MS, log=lambda _: None)

    # The account the product listed, and its profile key, discovered and verified gone too.
    assert outcome.to_confirm == sorted([ERASED, ERASED_PROFILE])
    assert outcome.discovered_profiles == 1
    leftovers = {
        key
        for key, body in _everything(storage).items()
        if _contains(body, ERASED, ERASED_PROFILE) and key != PLAN_KEY
    }
    assert leftovers == set()
    # Only the plan remembers the keys (until the watch period ends).
    assert set(load_plan(storage)["subjects"]) == {ERASED, ERASED_PROFILE}
    # Everybody else's events are untouched, raw and compacted.
    assert _kept_events(tmp_path) == keep_ids
    counts = outcome.counts
    assert counts["raw.objectsDeleted"] >= 2  # `only` and `consent` held nothing else
    assert counts["parquet.filesRewritten"] == 1
    assert counts["quarantine.linesRemoved"] == 2
    assert counts["datasets.rowsRemoved"] == 4  # profiles 1, playback 2, accounts 1
    assert counts["artefacts.profilesRemoved"] == 2
    assert counts["artefacts.pointerUpdated"] == 1
    # The compacted hour is still a valid format-2 hour, its sources still covered.
    hour = next(h for h in list_hours(storage) if h.hour_ms == H1 - H1 % HOUR_MS)
    manifest: dict[str, Any] = get_json(storage, hour.prefix + COMPACTION_MANIFEST) or {}
    schemas.validate("events-compaction", manifest)
    assert manifest["erased"] == 6 and "erasedAt" in manifest
    assert len(hour.parquet) == 1
    # Datasets: rows gone, counts updated.
    dataset: dict[str, Any] = get_json(storage, "recs-work/datasets/d1/manifest.json") or {}
    assert dataset["rows"] == {"profiles": 1, "playback": 1, "accounts": 1}
    assert dataset["erasure"]["rowsRemoved"] == 4
    # Artefacts: both versions still validate, and the importer's path (pointer -> manifest
    # digest -> files) still verifies.
    for version in ("20261001-000000-0123abcd", run):
        assert artefacts.validate_version(storage, version) == []
    current = artefacts.read_current(storage)
    assert current is not None and current[1]["counts"]["profiles"] == 1


def test_an_account_without_any_data_is_confirmed(tmp_path: Path) -> None:
    build_store(tmp_path)
    outcome = erase(str(tmp_path), ["N" * 22], now_ms=ANCHOR_MS, log=lambda _: None)
    assert outcome.to_confirm == ["N" * 22]
    assert outcome.discovered_profiles == 0


class Boom(RuntimeError):
    pass


@pytest.mark.parametrize("where", ["lake", "datasets", "artefact-manifest", "pointer"])
def test_a_rerun_after_a_failure_anywhere_finishes_the_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, where: str
) -> None:
    storage = build_store(tmp_path)
    real_put = LocalStorage.put
    calls = {"n": 0}

    def failing_put(self: LocalStorage, key: str, data: bytes, **kwargs: Any) -> Any:
        hit = (
            (where == "lake" and key.endswith(".ndjson.gz") and key.startswith("events/"))
            or (where == "datasets" and key.startswith("recs-work/datasets/"))
            or (
                where == "artefact-manifest"
                and key.endswith("/manifest.json")
                and key.startswith("recs/v=")
            )
            or (where == "pointer" and key == artefacts.POINTER_KEY)
        )
        if hit:
            calls["n"] += 1
            if calls["n"] == 1:
                raise Boom(where)
        return real_put(self, key, data, **kwargs)

    monkeypatch.setattr(LocalStorage, "put", failing_put)
    with pytest.raises(Boom):
        erase(str(tmp_path), [ERASED], now_ms=ANCHOR_MS, log=lambda _: None)
    # Nothing was confirmed, and the plan already knows both keys (the profile was discovered
    # before anything was rewritten).
    plan = load_plan(storage)
    assert set(plan["subjects"]) == {ERASED, ERASED_PROFILE}
    assert all(entry["confirmedAt"] is None for entry in plan["subjects"].values())
    assert lease.LAKE_LEASE_KEY not in {i.key for i in storage.list("recs-work/locks/")}
    monkeypatch.setattr(LocalStorage, "put", real_put)
    # The product still lists the key; the next run finishes.
    outcome = erase(str(tmp_path), [ERASED], now_ms=ANCHOR_MS + 1, log=lambda _: None)
    assert outcome.to_confirm == sorted([ERASED, ERASED_PROFILE])
    leftovers = [
        key
        for key, body in _everything(storage).items()
        if _contains(body, ERASED, ERASED_PROFILE) and key != PLAN_KEY
    ]
    assert leftovers == []
    for version in ("20261001-000000-0123abcd", "20261002-000000-0123abcd"):
        assert artefacts.validate_version(storage, version) == []
    assert artefacts.read_current(storage) is not None
    assert load_plan(storage)["versionsInProgress"] == []


class SilentStorage(LocalStorage):
    """A store that acknowledges one rewrite without doing it (the case verification is for)."""

    def put(self, key: str, data: bytes, *, content_type: str | None = None) -> Any:
        if key.endswith("mixed.ndjson.gz"):
            info = self.head(key)
            assert info is not None
            return info
        return super().put(key, data, content_type=content_type)


def test_nothing_is_confirmed_unless_verification_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    build_store(tmp_path)
    monkeypatch.setattr(erasure, "open_storage", SilentStorage)
    with pytest.raises(ErasureIncomplete, match="raw 1"):
        erase(str(tmp_path), [ERASED], now_ms=ANCHOR_MS, log=lambda _: None)


def test_confirmed_keys_are_watched_for_late_arrivals_then_forgotten(tmp_path: Path) -> None:
    storage = build_store(tmp_path)
    erase(str(tmp_path), [ERASED], now_ms=ANCHOR_MS, log=lambda _: None)
    mark_confirmed(storage, [ERASED], ANCHOR_MS)
    # A batch queued before the deletion is replayed from a dead letter days later.
    late = _event("title.open", H2 + 9, ERASED, ERASED_PROFILE)
    write_lake(storage, [late], "replayed")
    outcome = erase(str(tmp_path), [], now_ms=ANCHOR_MS + 5 * DAY_MS, log=lambda _: None)
    assert outcome.to_confirm == []  # already confirmed: nothing to confirm again
    assert outcome.counts.get("raw.objectsDeleted") == 1
    assert late["eventId"] not in _kept_events(tmp_path)
    forgotten = erase(str(tmp_path), [], now_ms=ANCHOR_MS + 31 * DAY_MS, log=lambda _: None)
    assert forgotten.forgotten == 2
    assert load_plan(storage)["subjects"] == {}


def test_compaction_and_erasure_never_overlap(tmp_path: Path) -> None:
    storage = build_store(tmp_path)
    holder = lease.acquire(storage, "compact")
    with pytest.raises(lease.LakeBusy, match="compact holds"):
        erase(str(tmp_path), [ERASED], log=lambda _: None)
    with pytest.raises(lease.LakeBusy):
        compact(str(tmp_path), now_ms=ANCHOR_MS)
    lease.release(storage, holder)
    # An expired lease (its job died) is taken over.
    lease.acquire(storage, "erase", ttl_ms=1, now_ms=ANCHOR_MS)
    assert (get_json(storage, lease.LAKE_LEASE_KEY) or {})["job"] == "erase"
    assert compact(str(tmp_path), now_ms=ANCHOR_MS).hours_seen >= 1


# --- Through the command line, with the staff API -----------------------------------------------


def _free_port() -> int:
    """A port of this pipeline's range (5790-5809) that is free right now."""
    for port in range(5792, 5810):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("no free port in 5792-5809")


class StaffApi(http.server.BaseHTTPRequestHandler):
    # Shared between the handler threads and the test (reset by the fixture).
    pending: ClassVar[list[str]] = []
    confirmed: ClassVar[list[dict[str, Any]]] = []
    headers_seen: ClassVar[list[dict[str, str]]] = []
    token_requests: ClassVar[list[str]] = []
    exports: ClassVar[list[dict[str, Any]]] = []
    export_results: ClassVar[list[dict[str, Any]]] = []

    def log_message(self, *args: object) -> None:
        return None

    def _answer(self, status: int, body: object | None) -> None:
        payload = orjson.dumps(body) if body is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        self.headers_seen.append(dict(self.headers))
        if self.headers.get("Authorization") != "Bearer staff-token":
            self._answer(401, {"code": "unauthenticated"})
        elif self.path.startswith("/api/admin/v1/system/privacy/erasures?limit="):
            self._answer(200, {"subjectKeys": self.pending})
        elif self.path.startswith("/api/admin/v1/system/privacy/exports?limit="):
            self._answer(200, {"requests": self.exports})
        else:
            self._answer(404, {"code": "not_found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.headers_seen.append(dict(self.headers))
        if self.path == "/token":
            # Client authentication by HTTP Basic (client_secret_basic), as the product's
            # issuers expect; the form carries the grant only.
            self.token_requests.append(f"{self.headers.get('Authorization')}|{body.decode()}")
            self._answer(200, {"access_token": "staff-token", "expires_in": 300})
        elif self.path == "/api/admin/v1/system/privacy/exports/results":
            if self.headers.get("X-Webflix-Client") != "web":
                self._answer(403, {"code": "csrf"})
                return
            document = orjson.loads(body)
            self.export_results.append(document)
            recorded = {r["requestId"] for r in document["results"] if r["status"] != "deferred"}
            type(self).exports = [e for e in self.exports if e["requestId"] not in recorded]
            self.send_response(204)
            self.end_headers()
        elif self.path == "/api/admin/v1/system/privacy/erasures/confirm":
            if self.headers.get("X-Webflix-Client") != "web":
                self._answer(403, {"code": "csrf"})
                return
            document = orjson.loads(body)
            self.confirmed.append(document)
            type(self).pending = [k for k in self.pending if k not in document["subjectKeys"]]
            self.send_response(204)
            self.end_headers()
        else:
            self._answer(404, {"code": "not_found"})


@pytest.fixture
def staff_api() -> Iterator[str]:
    port = _free_port()
    StaffApi.pending, StaffApi.confirmed, StaffApi.headers_seen = [ERASED], [], []
    StaffApi.token_requests = []
    StaffApi.exports, StaffApi.export_results = [], []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), StaffApi)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()


def _run_cli(args: list[str], capsys: pytest.CaptureFixture[str]) -> tuple[int, dict[str, Any]]:
    try:
        cli.main(args)
    except SystemExit as stop:
        return int(stop.code or 0), {}
    return 0, orjson.loads(capsys.readouterr().out)


def test_the_erase_job_reads_and_confirms_through_the_staff_api(
    tmp_path: Path,
    staff_api: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    build_store(tmp_path)
    monkeypatch.setenv("WEBFLIX_ADMIN_API_URL", f"{staff_api}/api/admin/v1")
    monkeypatch.setenv("WEBFLIX_STAFF_TOKEN_URL", f"{staff_api}/token")
    monkeypatch.setenv("WEBFLIX_STAFF_CLIENT_ID", "webflix-recs")
    monkeypatch.setenv("WEBFLIX_STAFF_CLIENT_SECRET", "secret")
    monkeypatch.delenv("WEBFLIX_STAFF_TOKEN", raising=False)
    code, summary = _run_cli(["--store", str(tmp_path), "--workers", "1", "erase"], capsys)
    assert code == 0
    assert summary["confirmed"] == 2 and summary["verified"]
    (body,) = StaffApi.confirmed
    assert body["subjectKeys"] == sorted([ERASED, ERASED_PROFILE]) and len(body["reason"]) >= 3
    authorization, form = StaffApi.token_requests[0].split("|", 1)
    assert authorization == "Basic " + base64.b64encode(b"webflix-recs:secret").decode()
    assert form == "grant_type=client_credentials"
    assert all(h.get("Authorization") == "Bearer staff-token" for h in StaffApi.headers_seen[1:])
    # Run again: nothing pending, nothing to confirm, the key is watched.
    code, summary = _run_cli(["--store", str(tmp_path), "--workers", "1", "erase"], capsys)
    assert code == 0 and summary["keysGiven"] == 0 and "confirmed" not in summary


def test_the_erase_job_exits_6_when_the_staff_api_is_unreachable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    build_store(tmp_path)
    monkeypatch.setenv("WEBFLIX_ADMIN_API_URL", f"http://127.0.0.1:{_free_port()}/api/admin/v1")
    monkeypatch.setenv("WEBFLIX_STAFF_TOKEN", "staff-token")
    code, _ = _run_cli(["--store", str(tmp_path), "--workers", "1", "erase"], capsys)
    assert code == cli.EXIT_STAFF_API
    assert get_json(LocalStorage(tmp_path), PLAN_KEY) is None  # nothing done


def test_compact_erase_file_writes_the_confirm_bodies(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build_store(tmp_path)
    keys = tmp_path.parent / f"{tmp_path.name}-keys.json"
    keys.write_bytes(orjson.dumps({"subjectKeys": [ERASED]}))
    code, summary = _run_cli(
        [
            "--store", str(tmp_path), "--workers", "1", "compact",
            "--now", iso_ms(ANCHOR_MS), "--erase", str(keys),
        ],
        capsys,
    )  # fmt: skip
    assert code == 0
    assert summary["hours_compacted"] >= 1
    assert summary["erase"]["confirmBodies"] == [
        {
            "subjectKeys": sorted([ERASED, ERASED_PROFILE]),
            "reason": summary["erase"]["confirmBodies"][0]["reason"],
        }
    ]


def test_the_lake_busy_exit_code(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    storage = build_store(tmp_path)
    lease.acquire(storage, "erase")
    code, _ = _run_cli(["--store", str(tmp_path), "compact"], capsys)
    assert code == cli.EXIT_LAKE_BUSY


# --- Against an S3-compatible store --------------------------------------------------------------


def test_compaction_and_erasure_against_an_s3_compatible_store(tmp_path: Path) -> None:
    moto_server = pytest.importorskip("moto.server")
    from webflix_recs.storage import S3Storage

    port = _free_port()
    server = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=port, verbose=False)
    server.start()
    saved = {
        k: os.environ.get(k)
        for k in ("WEBFLIX_S3_ENDPOINT", "WEBFLIX_S3_ACCESS_KEY_ID", "WEBFLIX_S3_SECRET_ACCESS_KEY")
    }
    os.environ.update(
        WEBFLIX_S3_ENDPOINT=f"http://127.0.0.1:{port}",
        WEBFLIX_S3_ACCESS_KEY_ID="test",
        WEBFLIX_S3_SECRET_ACCESS_KEY="test",
    )
    try:
        s3 = S3Storage.from_environment("webflix-media", prefix="jobs")
        s3._client.create_bucket(Bucket="webflix-media")
        local = build_store(tmp_path)
        for info in local.list():
            s3.put(info.key, local.get(info.key) or b"")
        location = "s3://webflix-media/jobs"
        compact(location, now_ms=ANCHOR_MS)
        outcome = erase(location, [ERASED], now_ms=ANCHOR_MS, log=lambda _: None)
        assert outcome.to_confirm == sorted([ERASED, ERASED_PROFILE])
        for info in s3.list():
            if info.key == PLAN_KEY:
                continue
            body = s3.get(info.key) or b""
            if info.key.endswith(".gz"):
                body = gzip.decompress(body)
            elif info.key.endswith(".parquet"):
                body = orjson.dumps(pl.read_parquet(io.BytesIO(body)).to_dicts(), default=str)
            assert not _contains(body, ERASED, ERASED_PROFILE), info.key
        assert artefacts.read_current(s3) is not None
    finally:
        server.stop()
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_export_events_reads_and_records_through_the_staff_api(
    tmp_path: Path,
    staff_api: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """`export-events` with no file: the pending exports from `GET /system/privacy/exports`,
    pending erasures from `GET /system/privacy/erasures`, the results to
    `POST /system/privacy/exports/results`, as the product's contract checks them."""
    build_store(tmp_path)
    window = {"from": iso_ms(H1 - HOUR_MS), "to": iso_ms(H2 + HOUR_MS)}
    StaffApi.exports = [
        {"requestId": "exp-keep", "accountKey": KEEP, **window},
        {"requestId": "exp-erased", "accountKey": ERASED, **window},  # its erasure is pending
    ]
    monkeypatch.setenv("WEBFLIX_ADMIN_API_URL", f"{staff_api}/api/admin/v1")
    monkeypatch.setenv("WEBFLIX_STAFF_TOKEN_URL", f"{staff_api}/token")
    monkeypatch.setenv("WEBFLIX_STAFF_CLIENT_ID", "webflix-recs")
    monkeypatch.setenv("WEBFLIX_STAFF_CLIENT_SECRET", "secret")
    monkeypatch.delenv("WEBFLIX_STAFF_TOKEN", raising=False)
    now = iso_ms(H2 + 3 * HOUR_MS)
    code, summary = _run_cli(
        ["--store", str(tmp_path), "--workers", "1", "export-events", "--now", now], capsys
    )
    assert code == 0 and summary["recorded"] == 2
    assert summary["statuses"] == {"complete": 1, "erased": 1}
    (body,) = StaffApi.export_results
    assert body["format"] == "webflix.export-events-results" and len(body["reason"]) >= 3
    by_id = {r["requestId"]: r for r in body["results"]}
    keep = by_id["exp-keep"]
    # What the product's ExportResultsBody insists on.
    assert keep["file"] == "privacy/export-events/exp-keep/events.ndjson.gz"
    assert keep["manifest"] == "privacy/export-events/exp-keep/manifest.json"
    assert keep["events"] == 10 and keep["bytes"] > 0 and len(keep["sha256"]) == 64
    assert by_id["exp-erased"] == {
        "requestId": "exp-erased",
        "status": "erased",
        "events": 0,
        **window,
    }
    # Recorded, so no longer listed: the next round is one list call and nothing else.
    code, summary = _run_cli(
        ["--store", str(tmp_path), "--workers", "1", "export-events", "--now", now], capsys
    )
    assert code == 0 and summary["requests"] == 0 and "lakeLease" not in summary
    assert len(StaffApi.export_results) == 1
