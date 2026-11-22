"""The compacted-hour fixtures the product's data export tests against: produced by this
compactor (and still what it produces), read correctly by this pipeline, and by hyparquet (the
JavaScript reader the product uses, no WASM codec) following the README's reader contract."""

from __future__ import annotations

import gzip
import io
import json
import shutil
import subprocess
from pathlib import Path

import orjson
import polars as pl
import pytest

import compacted_fixture
from webflix_recs import schemas
from webflix_recs.lake import read_events
from webflix_recs.storage import LocalStorage

FIXTURE = Path(__file__).parent / "fixtures" / "compacted"
REPO = Path(__file__).resolve().parents[3]


def _tree(root: Path) -> dict[str, Path]:
    store = root / "store"
    return {str(p.relative_to(store)): p for p in sorted(store.rglob("*")) if p.is_file()}


def test_the_committed_fixture_is_what_the_compactor_produces(tmp_path: Path) -> None:
    rebuilt = tmp_path / "compacted"
    compacted_fixture.build(rebuilt)
    committed, fresh = _tree(FIXTURE), _tree(rebuilt)
    assert sorted(committed) == sorted(fresh), "regenerate: tests/compacted_fixture.py"
    for key, path in committed.items():
        if key.endswith(".parquet"):
            # Compare content, not bytes (another polars version may encode the same rows
            # differently).
            assert pl.read_parquet(path).equals(pl.read_parquet(fresh[key]))
        elif key.endswith("_compaction.json"):
            ours, theirs = json.loads(path.read_text()), json.loads(fresh[key].read_text())
            schemas.validate("events-compaction", ours)
            for field in ("parquetBytes", "parquetSha256"):
                ours.pop(field), theirs.pop(field)
            assert ours == theirs
        else:
            assert path.read_bytes() == fresh[key].read_bytes(), key
    assert json.loads((FIXTURE / "expected.json").read_text()) == json.loads(
        (rebuilt / "expected.json").read_text()
    )


def test_the_pipeline_reads_the_fixture_as_expected(tmp_path: Path) -> None:
    storage = LocalStorage(tmp_path)
    for key, path in _tree(FIXTURE).items():
        storage.put(key, path.read_bytes())
    frames, stats, hours = read_events(str(tmp_path))
    assert hours == 2 and stats.invalid == 0
    expected = json.loads((FIXTURE / "expected.json").read_text())
    found: dict[str, set[str]] = {}
    for frame in frames:
        for account, event_id in frame.select("account", "event_id").iter_rows():
            if account is not None:
                found.setdefault(account, set()).add(event_id)
    assert {a: sorted(ids) for a, ids in found.items()} == {
        a: v["eventIds"] for a, v in expected["accounts"].items()
    }


def test_the_fixture_has_what_the_contract_promises() -> None:
    expected = json.loads((FIXTURE / "expected.json").read_text())
    hour = next(h for h in expected["hours"].values() if h["compacted"])
    manifest = json.loads(
        (FIXTURE / "store" / hour["parquet"]).parent.joinpath("_compaction.json").read_text()
    )
    frame = pl.read_parquet(io.BytesIO((FIXTURE / "store" / hour["parquet"]).read_bytes()))
    assert frame.columns[0] == "account" and "raw" in frame.columns
    # `raw` holds the writer's exact lines: every covered object's lines are in it verbatim.
    raws = set(frame["raw"].to_list())
    for key in hour["skipRawObjects"]:
        lines = gzip.decompress((FIXTURE / "store" / key).read_bytes()).splitlines()
        assert all(line.decode() in raws for line in lines if line), key
    assert {s["key"] for s in manifest["sources"]} == set(hour["skipRawObjects"])
    # Several row groups, and a reader of a small account can skip most of them.
    assert len(hour["rowGroups"]) > 3
    smallest = min(
        hour["rowGroupsAReaderOfThisAccountReads"].items(), key=lambda item: len(item[1])
    )
    assert len(smallest[1]) == 1
    # The straggler repeats an event already compacted (same eventId).
    straggler = hour["readRawObjects"][0]
    repeated = [
        orjson.loads(line)["eventId"]
        for line in gzip.decompress((FIXTURE / "store" / straggler).read_bytes()).splitlines()
    ]
    assert set(repeated) & set(frame["event_id"].to_list())


@pytest.mark.node
def test_hyparquet_reads_the_fixture_as_the_contract_says() -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is needed to run hyparquet")
    if not (REPO / "packages" / "core" / "node_modules" / "hyparquet").exists():
        pytest.skip("the workspace's packages are not installed (pnpm install)")
    result = subprocess.run(
        [node, str(REPO / "services" / "recs" / "scripts" / "check-compacted-fixture.ts")],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "read as the contract says" in result.stdout
