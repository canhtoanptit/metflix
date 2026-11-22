"""Shared fixtures. The end-to-end fixture runs the whole pipeline once per session on the real
catalogue (exported by Node from @webflix/catalog) at a small size."""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from webflix_recs.catalog import Catalog, load_catalog
from webflix_recs.dataset import DatasetResult, build_dataset
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.lake import compact
from webflix_recs.simulate.config import SimConfig, preset
from webflix_recs.simulate.run import run_simulation
from webflix_recs.storage import LocalStorage

REPO = Path(__file__).resolve().parents[3]
EXPORT = REPO / "services" / "recs" / "scripts" / "export-catalog.ts"
E2E_START_MS = 1_788_220_800_000  # 2026-09-01T00:00:00Z
E2E_DAYS = 21


def export_catalog(store: Path, anchor_ms: int) -> None:
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js is needed to export the real catalogue")
    subprocess.run(
        [node, str(EXPORT), "--store", str(store), "--anchor", iso_ms(anchor_ms)],
        check=True,
        capture_output=True,
        timeout=120,
    )


@dataclass
class EndToEnd:
    store: Path
    truth: Path
    work: Path
    storage: LocalStorage
    catalog: Catalog
    config: SimConfig
    simulation: dict[str, Any]
    dataset: DatasetResult

    @property
    def location(self) -> str:
        return str(self.store)

    @property
    def end_ms(self) -> int:
        return self.config.end_ms

    @property
    def cutoff_ms(self) -> int:
        return self.config.end_ms - 7 * DAY_MS


@pytest.fixture(scope="session")
def e2e(tmp_path_factory: pytest.TempPathFactory) -> EndToEnd:
    root = tmp_path_factory.mktemp("e2e")
    store = root / "store"
    truth = root / "truth"
    config = replace(
        preset("smoke"),
        accounts=220,
        days=E2E_DAYS,
        shard_size=110,
        start=iso_ms(E2E_START_MS),
        duplicate_rate=0.03,
        late_rate=0.05,
    )
    export_catalog(store, config.end_ms)
    storage = LocalStorage(store)
    catalog = load_catalog(storage)
    simulation = run_simulation(config, catalog, str(store), truth, workers=2, log=lambda *_: None)
    compact(str(store), now_ms=config.end_ms + DAY_MS, workers=2)
    dataset = build_dataset(
        str(store),
        storage,
        dataset_id="e2e",
        as_of_ms=config.end_ms,
        workers=2,
        log=lambda *_: None,
    )
    return EndToEnd(store, truth, root / "work", storage, catalog, config, simulation, dataset)


@pytest.fixture(scope="session")
def trained(e2e: EndToEnd) -> dict[str, Any]:
    """A backtest run at T = end - 7 days and a production run at the end, same recipe."""
    from webflix_recs.train import TrainParams, load_run, save_run, train

    out: dict[str, Any] = {}
    for name, as_of in (("backtest", e2e.cutoff_ms), ("production", e2e.end_ms)):
        models, report = train(
            e2e.catalog, e2e.dataset, as_of_ms=as_of, params=TrainParams(), log=lambda *_: None
        )
        manifest = save_run(
            e2e.storage, models, report, dataset=e2e.dataset, catalog=e2e.catalog, as_of_ms=as_of
        )
        out[name] = load_run(e2e.storage, manifest["run"])
    return out
