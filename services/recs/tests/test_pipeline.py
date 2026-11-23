"""End to end on the real catalogue: leakage, restricted subjects from lake to artefacts, the
real rule engine, the publish gate and atomic publishing."""

from __future__ import annotations

import gzip
import io
from pathlib import Path
from typing import Any

import orjson
import polars as pl
import pytest

from conftest import EndToEnd
from webflix_recs import artefacts
from webflix_recs.evaluation.harness import EvaluationInputs, evaluate
from webflix_recs.history import LeakError, targets
from webflix_recs.ids import DAY_MS, iso_ms
from webflix_recs.lake import compact
from webflix_recs.storage import get_json, put_json

pytestmark = [pytest.mark.slow, pytest.mark.node]


@pytest.fixture(scope="module")
def evaluation(e2e: EndToEnd, trained: dict[str, Any]) -> dict[str, Any]:
    models, manifest = trained["backtest"]
    report = evaluate(
        EvaluationInputs(
            e2e.catalog, e2e.dataset, models, manifest, truth_dir=e2e.truth, bootstrap=200
        ),
        work_dir=e2e.work / "evaluate",
        log=lambda *_: None,
    )
    artefacts.store_evaluation(e2e.storage, report)
    return report


def test_the_real_rule_engine_ranks_every_evaluated_profile(evaluation: dict[str, Any]) -> None:
    assert evaluation["externalCoverage"] == {
        "rule-engine": 1.0,
        "rule-engine-home": 1.0,
        "learned-home": 1.0,
    }
    results = evaluation["results"]
    assert results["rule-engine"]["all"]["ndcg@10"][0] > results["random"]["all"]["ndcg@10"][0]
    assert evaluation["leakCheck"] == "passed"
    # The gate compares what members see: the engine's home page with and without the run.
    gate = evaluation["gate"]
    assert gate["metric"] == "utility@10"
    assert (gate["candidate"], gate["baseline"]) == ("learned-home", "rule-engine-home")
    assert (
        gate["difference"]
        == evaluation["differencesVsRuleEngineHome"]["learned-home"]["utility@10"]
    )
    # The run changes the page: the learned home page is not the engine's own.
    assert (
        results["learned-home"]["all"]["utility@10"]
        != results["rule-engine-home"]["all"]["utility@10"]
    )


def test_the_engine_gets_each_profiles_whole_library(
    e2e: EndToEnd, trained: dict[str, Any], tmp_path: Path
) -> None:
    """What the engine reads from the database, as of the cutoff, for every evaluated profile:
    My List, ratings and progress, each checked against the dataset independently; and, for
    the learned home page, the run's lists for that profile and its neighbours."""
    from webflix_recs import schemas as ev
    from webflix_recs.evaluation.harness import write_rule_engine_input

    models, manifest = trained["backtest"]
    inputs = EvaluationInputs(e2e.catalog, e2e.dataset, models, manifest)
    path = write_rule_engine_input(inputs, tmp_path, log=lambda *_: None)
    header, *lines = [orjson.loads(line) for line in path.read_bytes().splitlines()]
    assert header["learned"]["run"] == manifest["run"] and header["learned"]["neighbours"]
    known = pl.col("received_at") < e2e.cutoff_ms
    playback = e2e.dataset.tables["playback"].filter(known)
    actions = e2e.dataset.tables["actions"].filter(known).sort("event_time")

    def latest(kinds: tuple[str, str]) -> dict[str, set[str]]:
        last = (
            actions.filter(pl.col("type").is_in(kinds))
            .group_by(["profile", "title_id"])
            .agg(pl.col("type").last())
            .filter(pl.col("type") == kinds[0])
        )
        out: dict[str, set[str]] = {}
        for profile, title, _ in last.iter_rows():
            out.setdefault(profile, set()).add(title)
        return out

    in_list = latest((ev.LIST_ADD, ev.LIST_REMOVE))
    rated = latest((ev.RATING_SET, ev.RATING_CLEAR))
    items: dict[str, set[str]] = {}
    for profile, item in playback.select(
        "profile", pl.coalesce("episode_id", "title_id")
    ).iter_rows():
        items.setdefault(profile, set()).add(item)
    assert lines and any(line["progress"] for line in lines)
    for line in lines:
        key = line["profileKey"]
        assert {entry["itemId"] for entry in line["progress"]} == items.get(key, set()), key
        assert {entry["titleId"] for entry in line["myList"]} == in_list.get(key, set()), key
        assert {entry["titleId"] for entry in line["ratings"]} == rated.get(key, set()), key
        assert line["lists"] and {row["type"] for row in line["lists"]} >= {"personal"}


def test_a_planted_leak_is_refused_and_would_have_inflated_the_metrics(
    e2e: EndToEnd, trained: dict[str, Any], evaluation: dict[str, Any]
) -> None:
    leaky_models, leaky_manifest = trained["production"]  # trained through the test window
    honest = evaluation
    inputs = EvaluationInputs(
        e2e.catalog,
        e2e.dataset,
        leaky_models,
        leaky_manifest,
        cutoff_ms=e2e.cutoff_ms,
        bootstrap=100,
    )
    with pytest.raises(LeakError, match="after the evaluation cutoff"):
        evaluate(inputs, work_dir=e2e.work / "leak", log=lambda *_: None)

    # A rankings file that peeked at the test window: refused on its provenance...
    peek = e2e.work / "peek.ndjson"
    profiles = e2e.dataset.tables["profiles"]["profile"].to_list()
    future = targets(e2e.dataset, e2e.catalog, e2e.cutoff_ms, e2e.end_ms, profiles)
    ids = e2e.catalog.ids
    lines = [
        orjson.dumps(
            {
                "format": "webflix.rankings",
                "formatVersion": 1,
                "system": "peek",
                "asOf": iso_ms(e2e.end_ms),
            }
        )
    ]
    lines += [
        orjson.dumps(
            {"profileKey": p, "titleIds": [ids[t] for t in sorted(f, key=lambda t: -f[t])]}
        )
        for p, f in future.items()
    ]
    peek.write_bytes(b"\n".join(lines) + b"\n")
    honest_models, honest_manifest = trained["backtest"]
    externals = {"peek": peek}  # the harness runs the rule engine itself
    with pytest.raises(LeakError, match="after the cutoff"):
        evaluate(
            EvaluationInputs(
                e2e.catalog,
                e2e.dataset,
                honest_models,
                honest_manifest,
                externals=externals,
                bootstrap=50,
            ),
            work_dir=e2e.work / "leak",
            log=lambda *_: None,
        )

    # ...and, with the guard bypassed, both leaks show up as a jump in the metrics.
    bypassed = evaluate(
        EvaluationInputs(
            e2e.catalog,
            e2e.dataset,
            leaky_models,
            leaky_manifest,
            cutoff_ms=e2e.cutoff_ms,
            externals=externals,
            bootstrap=50,
            allow_leak=True,
        ),
        work_dir=e2e.work / "leak",
        log=lambda *_: None,
    )
    assert bypassed["leakCheck"].startswith("bypassed")
    assert bypassed["results"]["peek"]["all"]["recall@20"][0] > 0.99
    assert (
        bypassed["results"]["peek"]["all"]["recall@20"][0]
        > honest["results"]["learned"]["all"]["recall@20"][0] + 0.05
    )
    assert (
        bypassed["results"]["learned"]["all"]["ndcg@10"][0]
        > honest["results"]["learned"]["all"]["ndcg@10"][0]
    )


def _restricted_and_unconsented(e2e: EndToEnd) -> set[str]:
    truth = pl.read_parquet(e2e.truth / "profiles" / "*.parquet")
    excluded = truth.filter(pl.col("restricted") | ~pl.col("personalisation_final"))
    return set(excluded["profile_key"].to_list())


def test_restricted_profiles_never_reach_training_data_candidates_or_artefacts(
    e2e: EndToEnd, trained: dict[str, Any], evaluation: dict[str, Any]
) -> None:
    excluded = _restricted_and_unconsented(e2e)
    truth = pl.read_parquet(e2e.truth / "profiles" / "*.parquet")
    restricted = set(truth.filter(pl.col("restricted"))["profile_key"].to_list())
    # The product stores nothing of a restricted profile (collector.ts) and the simulator now
    # collects the same way: they are absent from the lake itself, compacted hours included.
    # The pipeline's own exclusion rules stay as the second line (older lakes, test fixtures).
    lake_profiles: set[str] = set()
    flagged = 0
    for info in e2e.storage.list("events/"):
        if info.key.endswith(".parquet"):
            frame = pl.read_parquet(io.BytesIO(e2e.storage.get(info.key) or b""))
            lake_profiles |= set(frame["profile"].drop_nulls().to_list())
            flagged += sum(1 for raw in frame["raw"] if '"restricted":true' in raw)
    assert restricted and lake_profiles
    assert not lake_profiles & restricted
    assert flagged == 0
    assert e2e.dataset.manifest["counts"]["profiles"]["excludedRestricted"] == 0
    for name, table in e2e.dataset.tables.items():
        if "profile" in table.columns:
            assert not set(table["profile"].to_list()) & excluded, f"dataset table {name}"
    models, manifest = trained["production"]
    result = artefacts.score(
        e2e.storage, e2e.catalog, e2e.dataset, models, manifest, log=lambda *_: None
    )
    published: set[str] = set()
    for entry in result.manifest["files"]:
        if entry["table"] == "profiles":
            body = e2e.storage.get(f"recs/v={result.run}/{entry['path']}") or b""
            published |= set(pl.read_parquet(io.BytesIO(body))["profile_key"].to_list())
    assert published
    assert not published & excluded
    assert evaluation["profiles"] > 0


def test_publish_refuses_unless_the_runs_own_backtest_passed(
    e2e: EndToEnd, trained: dict[str, Any]
) -> None:
    models, manifest = trained["production"]
    recipe = manifest["recipeHash"]
    stored = {
        i.key: e2e.storage.get(i.key)
        for i in e2e.storage.list(f"{artefacts.EVALUATIONS_PREFIX}{recipe}/")
    }
    e2e.storage.delete(list(stored))
    put_json(e2e.storage, *_report(recipe, e2e.cutoff_ms, passed=False))
    # A pass of the same recipe at another cutoff does not stand in for it.
    put_json(e2e.storage, *_report(recipe, e2e.cutoff_ms - 7 * DAY_MS, passed=True))
    try:
        result = artefacts.score(
            e2e.storage, e2e.catalog, e2e.dataset, models, manifest,
            evaluation=_decided(e2e.storage, manifest, 1), log=lambda *_: None,
        )  # fmt: skip
        assert result.manifest["evaluation"]["passed"] is False
        with pytest.raises(artefacts.PublishRefused, match="did not all beat the rule engine"):
            artefacts.publish(e2e.storage, result.run, log=lambda *_: None)
        assert get_json(e2e.storage, artefacts.POINTER_KEY) is None
    finally:
        e2e.storage.delete(
            [i.key for i in e2e.storage.list(f"{artefacts.EVALUATIONS_PREFIX}{recipe}/")]
        )
        for key, body in stored.items():
            e2e.storage.put(key, body or b"")


def _report(recipe: str, cutoff_ms: int, *, passed: bool = True) -> tuple[str, dict[str, Any]]:
    """An evaluation of the backtest of `recipe` at `cutoff_ms`, and its key."""
    from webflix_recs import gate
    from webflix_recs.train import run_id_for

    run = run_id_for(cutoff_ms, recipe)
    report = {
        "recipeHash": recipe,
        "run": run,
        "cutoff": iso_ms(cutoff_ms),
        "profiles": 1,
        "gate": {
            "metric": "utility@10",
            "candidate": "learned",
            "baseline": "rule-engine",
            "difference": [0.1, 0.05, 0.15] if passed else [-0.1, -0.15, -0.05],
            "passed": passed,
        },
    }
    return gate.evaluation_key(recipe, run), report


def _decided(storage: Any, manifest: dict[str, Any], count: int) -> dict[str, Any]:
    """What scoring records in the version's manifest: the run's own gate decision."""
    from webflix_recs import gate

    decision = gate.decide(
        storage,
        run=manifest["run"],
        recipe=manifest["recipeHash"],
        as_of_ms=int(manifest["data"]["asOfMs"]),
        count=count,
    )
    return gate.manifest_evaluation(decision)


def test_publishing_is_atomic_and_readers_only_ever_see_complete_versions(
    e2e: EndToEnd, trained: dict[str, Any], tmp_path: Path
) -> None:
    from webflix_recs.storage import LocalStorage

    # A fresh store holding only what publishing needs, so this test controls every version.
    storage = LocalStorage(tmp_path)
    for prefix in ("catalog/", "recs-work/runs/"):
        for info in e2e.storage.list(prefix):
            storage.put(info.key, e2e.storage.get(info.key) or b"")
    models, manifest = trained["production"]
    recipe = manifest["recipeHash"]
    # The gate is tested above and in test_gate.py; here the run's backtest passed.
    put_json(storage, *_report(recipe, e2e.cutoff_ms))

    first = artefacts.score(
        storage,
        e2e.catalog,
        e2e.dataset,
        models,
        manifest,
        evaluation=_decided(storage, manifest, 1),
        profiles_per_shard=40,
        log=lambda *_: None,
    )
    assert len([f for f in first.manifest["files"] if f["table"] == "profiles"]) > 2
    assert artefacts.validate_version(storage, first.run) == []
    pointer = artefacts.publish(storage, first.run, log=lambda *_: None)
    assert pointer["previous"] is None

    # A second version under another run id; the scorer crashes after two shards.
    second_manifest = {**manifest, "run": f"{manifest['run']}-b"}
    with pytest.raises(RuntimeError, match="simulated failure"):
        artefacts.score(
            storage,
            e2e.catalog,
            e2e.dataset,
            models,
            second_manifest,
            evaluation=_decided(storage, second_manifest, 1),
            profiles_per_shard=40,
            fail_after_shards=2,
            log=lambda *_: None,
        )
    # Readers still see the first version, complete and valid; the half-written one has no
    # manifest, is refused by publish and is invisible to readers.
    current = artefacts.read_current(storage)
    assert current is not None and current[0]["run"] == first.run
    assert artefacts.validate_version(storage, first.run) == []
    assert artefacts.validate_version(storage, second_manifest["run"])[0].endswith(
        "the version is incomplete"
    )
    with pytest.raises(artefacts.PublishRefused, match="no complete artefact version"):
        artefacts.publish(storage, second_manifest["run"], log=lambda *_: None)

    # A completed second version is published: the pointer flips last and records the previous.
    artefacts.score(
        storage,
        e2e.catalog,
        e2e.dataset,
        models,
        second_manifest,
        evaluation=_decided(storage, second_manifest, 1),
        profiles_per_shard=40,
        log=lambda *_: None,
    )
    flipped = artefacts.publish(storage, second_manifest["run"], log=lambda *_: None)
    assert flipped["previous"] == first.run
    assert artefacts.read_current(storage) is not None
    history = [i.key for i in storage.list("recs/history/")]
    assert len(history) == 2

    # Corruption after the fact is caught by the validator and blocks a publish.
    latest = artefacts.read_current(storage)
    assert latest is not None
    shard = next(f for f in latest[1]["files"] if f["table"] == "profiles")
    key = f"recs/v={second_manifest['run']}/{shard['path']}"
    storage.put(key, (storage.get(key) or b"")[:-10])
    assert any(
        "SHA-256" in problem
        for problem in artefacts.validate_version(storage, second_manifest["run"])
    )
    with pytest.raises(artefacts.PublishRefused, match="invalid"):
        artefacts.publish(storage, second_manifest["run"], log=lambda *_: None)


def test_published_artefacts_follow_the_documented_schema(
    e2e: EndToEnd, trained: dict[str, Any]
) -> None:
    models, manifest = trained["production"]
    result = artefacts.score(
        e2e.storage, e2e.catalog, e2e.dataset, models, manifest, log=lambda *_: None
    )
    assert artefacts.validate_version(e2e.storage, result.run) == []
    neighbours = pl.read_parquet(
        io.BytesIO(e2e.storage.get(f"recs/v={result.run}/neighbours/part-00000.parquet") or b"")
    )
    assert neighbours.columns == ["title_id", "rank", "neighbour_id", "score", "support"]
    assert (
        int(neighbours.group_by("title_id").agg(pl.len())["len"].to_numpy().max())
        <= artefacts.NEIGHBOURS
    )
    shard = next(f for f in result.manifest["files"] if f["table"] == "profiles")
    profiles = pl.read_parquet(
        io.BytesIO(e2e.storage.get(f"recs/v={result.run}/{shard['path']}") or b"")
    )
    payload = orjson.loads(profiles["payload"][0])
    assert {row["type"] for row in payload["rows"]} >= {"personal", "top-picks", "billboard"}
    # The importer's budget: a neighbours row is 5 bound parameters, so 20 rows per statement.
    assert len(artefacts.TABLES["neighbours"]["columns"]) * 20 <= 100


def test_the_scheduled_jobs_on_simulated_data(
    e2e: EndToEnd, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """train-and-score split around the Node step (as a Kubernetes job with init containers
    runs it), publish of the scored run behind the gate, idempotent reruns, then the erasure of
    a member who is in the dataset, the artefacts and the published version."""
    import shutil
    import subprocess

    from webflix_recs import cli
    from webflix_recs.erasure import erase
    from webflix_recs.jobs import SCORED_MARKER, dataset_id_for
    from webflix_recs.storage import LocalStorage

    store = tmp_path / "store"
    shutil.copytree(e2e.store, store)
    storage = LocalStorage(store)
    storage.delete([i.key for i in storage.list("recs")])  # only the lake and the catalogue
    work = tmp_path / "work"
    # Lighter training than the default recipe (the job, not the models, is under test here).
    params = tmp_path / "params.json"
    params.write_bytes(orjson.dumps({"em_rounds": 1, "iterations": 4}))
    common = ["--store", str(store), "--workers", "2"]
    # Erasures pending when the job starts leave the dataset; one requested while it runs (after
    # the prepare phase) leaves the scored lists. Two active members, both in the lake.
    profiles = e2e.dataset.tables["profiles"]
    active = (
        profiles.filter(pl.col("last_seen") >= e2e.end_ms - 7 * DAY_MS)
        .group_by("account")
        .agg(pl.col("profile"))
        .sort("account")
    )
    (early, early_profiles), (late, late_profiles) = active.head(2).iter_rows()
    pending = tmp_path / "pending.json"
    pending.write_bytes(orjson.dumps({"subjectKeys": [early]}))
    job = [
        *common, "train-and-score", "--as-of", iso_ms(e2e.end_ms), "--work", str(work),
        "--truth", str(e2e.truth), "--bootstrap", "100", "--params", str(params),
        "--gate-cutoffs", "2", "--erasures", str(pending),
    ]  # fmt: skip

    def run(args: list[str]) -> tuple[int, dict[str, Any]]:
        try:
            cli.main(args)
        except SystemExit as stop:
            capsys.readouterr()
            return int(stop.code or 0), {}
        return 0, orjson.loads(capsys.readouterr().out)

    def node_step(engine_input: str) -> None:
        node = subprocess.run(
            [
                "node",
                str(Path(__file__).resolve().parents[1] / "scripts" / "rule-engine-rankings.ts"),
                "--input", engine_input, "--out-dir", str(work),
            ],
            capture_output=True, text=True, timeout=600, check=False,
        )  # fmt: skip
        assert node.returncode == 0, node.stderr

    code, prepared = run([*job, "--phase", "prepare"])
    assert code == 0 and Path(prepared["engineInput"]).exists()
    assert prepared["excludedAtStart"] == 1 and len(prepared["backtestRuns"]) == 2
    pending.write_bytes(orjson.dumps({"subjectKeys": [early, late]}))
    node_step(prepared["engineInput"])
    code, finished = run([*job, "--phase", "finish"])
    assert code == 0 and finished["status"] == "scored"
    run_id = finished["run"]
    assert finished["dataset"] == dataset_id_for(e2e.end_ms)
    assert finished["excludedAtScoring"] == 2
    # The backtest learned from a dataset as of its own cutoff, deleted once it was trained.
    backtest = get_json(storage, f"recs-work/runs/{finished['backtestRuns'][0]}/manifest.json")
    assert backtest is not None and backtest["data"]["datasetId"].startswith("backtest-")
    assert backtest["data"]["asOfMs"] == e2e.cutoff_ms
    assert not list(storage.list("recs-work/datasets/backtest-"))
    # Two gate cutoffs, end - 7 d and end - 14 d; the lake (21 days) is too young to train at the
    # second (no play before its ranker window): that fails the gate, not the job.
    assert len(finished["evaluations"]) == 1
    second = get_json(storage, finished["gate"]["decision"])["cutoffs"][1]  # type: ignore[index]
    assert second["passed"] is False and second["reason"].startswith("nothing to train")
    assert finished["gate"]["passed"] is False
    job_dataset = pl.read_parquet(
        io.BytesIO(storage.get(f"recs-work/datasets/{finished['dataset']}/profiles.parquet") or b"")
    )["profile"].to_list()
    assert not set(job_dataset) & set(early_profiles)
    assert set(late_profiles) <= set(job_dataset)  # in the dataset (requested later) ...

    def scored_profiles() -> set[str]:
        keys: set[str] = set()
        for info in storage.list(f"recs/v={run_id}/profiles/"):
            frame = pl.read_parquet(io.BytesIO(storage.get(info.key) or b""))
            keys |= set(frame["profile_key"].to_list())
        return keys

    assert scored_profiles()  # ... but not scored
    assert not scored_profiles() & {*early_profiles, *late_profiles}
    # The exchange files with the Node step held profile keys and libraries: gone once scored.
    sample = [key.encode() for key in job_dataset[:200]]
    for path in work.rglob("*"):
        if path.is_file():
            body = path.read_bytes()
            assert not any(key in body for key in sample), path
    assert (get_json(storage, SCORED_MARKER) or {})["run"] == run_id
    assert artefacts.validate_version(storage, run_id) == []
    # Idempotent: the version is complete, so a rerun does nothing (and cannot rescore files a
    # pointer may name), in one process or split around the Node step as a Kubernetes Job runs
    # it (its retry after a failed import): every phase ends cleanly, and publish runs after.
    code, again = run([*job, "--phase", "all"])
    assert code == 0 and again["status"] == "already-scored"
    code, again = run([*job, "--phase", "prepare"])
    assert code == 0 and again["status"] == "already-scored"
    node_step(again["engineInput"])
    code, again = run([*job, "--phase", "finish"])
    assert code == 0 and again["status"] == "already-scored" and again["run"] == run_id
    assert (get_json(storage, SCORED_MARKER) or {})["run"] == run_id
    # Publish takes the scored run; it is refused unless the run's own gate decision passed,
    # and nothing is published then.
    code, published = run([*common, "publish"])
    assert code == cli.EXIT_PUBLISH_REFUSED
    assert get_json(storage, artefacts.POINTER_KEY) is None
    # Passing evaluations of the same recipe planted afterwards do not change the decision the
    # run was scored with ...
    recipe = finished["recipeHash"]
    for weeks in (1, 2):
        put_json(storage, *_report(recipe, e2e.end_ms - 7 * weeks * DAY_MS))
    code, published = run([*common, "publish"])
    assert code == cli.EXIT_PUBLISH_REFUSED
    # ... scoring the run again records a new one (and still leaves out what is pending).
    code, rescored = run([
        *common, "score", "--run", run_id, "--gate-cutoffs", "2", "--erasures", str(pending),
    ])  # fmt: skip
    assert code == 0 and rescored["gate"]["passed"] and rescored["excludedSubjects"] == 2
    assert not scored_profiles() & {*early_profiles, *late_profiles}
    code, published = run([*common, "publish"])
    assert code == 0 and published["status"] == "published" and published["run"] == run_id
    code, unchanged = run([*common, "publish"])
    assert code == 0 and unchanged["status"] == "unchanged"

    # Erase a member who is everywhere: the lake, the job's dataset, the published lists.
    shard = next(f for f in artefacts.read_current(storage)[1]["files"] if f["table"] == "profiles")  # type: ignore[index]
    listed = pl.read_parquet(io.BytesIO(storage.get(f"recs/v={run_id}/{shard['path']}") or b""))[
        "profile_key"
    ].to_list()
    member = profiles.filter(pl.col("profile").is_in(listed))["account"][0]
    member_profiles = set(profiles.filter(pl.col("account") == member)["profile"].to_list())
    compact(str(store), now_ms=e2e.end_ms + DAY_MS)
    outcome = erase(str(store), [member], workers=2, log=lambda _: None)
    assert member in outcome.to_confirm and member_profiles <= set(outcome.to_confirm)
    assert outcome.discovered_profiles >= len(member_profiles)
    for info in storage.list():
        if info.key.startswith("recs-work/erasure/"):
            continue
        body = storage.get(info.key) or b""
        if info.key.endswith(".gz"):
            body = gzip.decompress(body)
        elif info.key.endswith(".parquet"):
            frame = pl.read_parquet(io.BytesIO(body))
            body = orjson.dumps(
                [
                    frame[c].cast(pl.String).to_list()
                    for c in frame.columns
                    if c in {"profile", "account", "profile_key", "raw"}
                ]
            )
        for key in {member, *member_profiles}:
            assert key.encode() not in body, info.key
    assert artefacts.validate_version(storage, run_id) == []
    assert artefacts.read_current(storage) is not None


def test_nobody_to_evaluate_is_a_refused_gate_not_a_crash(
    e2e: EndToEnd, trained: dict[str, Any]
) -> None:
    """A test window without a single discovery (a quiet week on a young lake): the evaluation
    reports zero profiles and a gate that did not pass, and the rule engine's input has no
    profile, so the Node step after it still runs."""
    from dataclasses import replace as replace_dataclass

    from webflix_recs.evaluation.harness import write_rule_engine_input

    tables = dict(e2e.dataset.tables)
    tables["playback"] = tables["playback"].filter(pl.col("event_time") < e2e.cutoff_ms)
    quiet = replace_dataclass(e2e.dataset, tables=tables)
    models, manifest = trained["backtest"]
    inputs = EvaluationInputs(e2e.catalog, quiet, models, manifest, bootstrap=20)
    report = evaluate(inputs, work_dir=e2e.work / "quiet", log=lambda *_: None)
    assert report["profiles"] == 0
    assert report["gate"]["passed"] is False and "nothing to evaluate" in report["gate"]["reason"]
    path = write_rule_engine_input(inputs, e2e.work / "quiet-input", log=lambda *_: None)
    assert len(path.read_bytes().splitlines()) == 1


def test_the_ranker_learns_from_features_its_labels_never_saw(
    e2e: EndToEnd, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Temporal stacking: the ranker's training examples are the impressions of [T - 7 d, T),
    and their features come from candidate models and a history as of T - 7 d (stage A), so no
    feature saw its own label. Computed as of T, a play inside the window would feed the
    features of the very impression it labels."""
    from webflix_recs import train as training

    seen: dict[str, Any] = {}

    class Stop(Exception):
        pass

    def spy(context: Any, examples: pl.DataFrame) -> Any:
        seen["history"] = context.history.as_of_ms
        times = examples["event_time"].to_numpy()
        seen["window"] = (int(times.min()), int(times.max()))
        raise Stop

    monkeypatch.setattr(training, "gather_features", spy)
    with pytest.raises(Stop):
        training.train(
            e2e.catalog, e2e.dataset, as_of_ms=e2e.cutoff_ms, params=training.TrainParams(),
            log=lambda *_: None,
        )  # fmt: skip
    window_start = e2e.cutoff_ms - 7 * DAY_MS
    assert seen["history"] == window_start
    assert window_start <= seen["window"][0] and seen["window"][1] < e2e.cutoff_ms
