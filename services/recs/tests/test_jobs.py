"""train-and-score on a young lake: having nothing to train is an ordinary outcome. Every phase
ends cleanly and says why, the Node step between them still gets an input, and publish then has
nothing to publish."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import orjson
import pytest

from helpers import ANCHOR_MS, put_catalog, synthetic_catalog, synthetic_catalog_document
from webflix_recs import cli
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.jobs import SCORED_MARKER, train_and_score
from webflix_recs.simulate.config import preset
from webflix_recs.simulate.run import run_simulation
from webflix_recs.storage import LocalStorage, get_json


def _young_lake(root: Path, days: int) -> LocalStorage:
    storage = LocalStorage(root)
    put_catalog(storage, synthetic_catalog_document())
    if days:
        config = replace(
            preset("smoke"),
            accounts=12,
            days=days,
            shard_size=12,
            start=iso_ms(ANCHOR_MS - days * DAY_MS),
        )
        run_simulation(config, synthetic_catalog(), str(root), root.parent / f"{root.name}-truth",
                       workers=1, log=lambda *_: None)  # fmt: skip
    return storage


def _publish(store: Path, capsys: pytest.CaptureFixture[str]) -> tuple[int, dict[str, Any]]:
    try:
        cli.main(["--store", str(store), "publish"])
    except SystemExit as stop:
        return int(stop.code or 0), {}
    return 0, orjson.loads(capsys.readouterr().out)


@pytest.mark.parametrize(
    ("days", "reason"),
    [
        (0, "no events received"),  # nothing at all
        (3, "no events received before"),  # nothing before the backtest's cutoff (T - 7 d)
        (10, "no play before"),  # nothing before that backtest's ranker window (T - 14 d)
    ],
)
def test_a_young_lake_has_nothing_to_train_and_every_step_says_so(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], days: int, reason: str
) -> None:
    store = tmp_path / "store"
    storage = _young_lake(store, days)
    work = tmp_path / "work"
    prepared = train_and_score(str(store), as_of_ms=ANCHOR_MS, phase="prepare", work=work,
                               log=lambda *_: None)  # fmt: skip
    assert prepared["status"] == "nothing-to-train" and reason in prepared["reason"]
    # The Node step still finds an input (no profile: it writes empty rankings).
    lines = (work / "engine-input.ndjson").read_bytes().splitlines()
    assert len(lines) == 1 and orjson.loads(lines[0])["format"] == "webflix.rule-engine-input"
    finished = train_and_score(
        str(store), as_of_ms=0, phase="finish", work=work, log=lambda *_: None
    )
    assert finished["status"] == "nothing-to-train" and finished["asOf"] == iso_ms(ANCHOR_MS)
    marker = get_json(storage, SCORED_MARKER) or {}
    assert marker["status"] == "nothing-to-train" and marker["run"] is None
    code, published = _publish(store, capsys)
    assert code == 0 and published["status"] == "nothing-to-publish"
    assert reason in published["reason"]
    assert get_json(storage, "recs/current.json") is None


def test_the_command_exits_zero_with_nothing_to_train(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    store = tmp_path / "store"
    _young_lake(store, 0)
    cli.main([
        "--store", str(store), "train-and-score", "--as-of", iso_ms(ANCHOR_MS),
        "--work", str(tmp_path / "work"),
    ])  # fmt: skip
    summary = orjson.loads(capsys.readouterr().out)
    assert summary["status"] == "nothing-to-train"


def test_a_cutoff_already_scored_ends_cleanly_in_every_phase(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A second run of a day's cutoff (a Job's retry after its import failed): prepare leaves an
    engine input without profiles and a state saying so, the Node step has its input, finish
    follows the state; every phase exits 0 and says `already-scored`."""
    from webflix_recs.provenance import recipe_hash
    from webflix_recs.storage import put_json
    from webflix_recs.train import TrainParams, run_id_for

    store = tmp_path / "store"
    storage = _young_lake(store, 0)
    run = run_id_for(ANCHOR_MS, recipe_hash(TrainParams().to_dict()))
    put_json(storage, f"recs/v={run}/manifest.json", {"run": run})  # the version is complete
    work = tmp_path / "work"
    for phase in ("prepare", "finish"):
        cli.main([
            "--store", str(store), "train-and-score", "--as-of", iso_ms(ANCHOR_MS),
            "--work", str(work), "--phase", phase,
        ])  # fmt: skip
        summary = orjson.loads(capsys.readouterr().out)
        assert summary["status"] == "already-scored" and summary["run"] == run, phase
        if phase == "prepare":
            lines = Path(summary["engineInput"]).read_bytes().splitlines()
            assert (
                len(lines) == 1 and orjson.loads(lines[0])["format"] == "webflix.rule-engine-input"
            )
