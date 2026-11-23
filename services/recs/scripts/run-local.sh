#!/usr/bin/env bash
# The full local run of the recommendation pipeline, from an empty directory (make recs).
#
#   services/recs/scripts/run-local.sh [smoke|medium|full]
#
# Everything lands under .cache/recs/<preset>/ (or RECS_ROOT): store/ (the blob store: lake,
# catalogue, working data, artefacts), truth/ (the simulator's ground truth, read only by
# evaluation) and reports/ (evaluations, experiment analysis, summary.md). Each step prints what
# it did and how long it took; the CLI's JSON summaries are kept in reports/steps/.
#
# The gate needs a passing backtest at each of GATE_CUTOFFS rolling cutoffs (end - 7 d, end - 14
# d, ...; default 3, 1 at smoke size, whose 21 days hold one). Each is trained and evaluated
# here; reports/evaluation-<k>.json holds the k-th, reports/evaluation.json the most recent.
# SEED picks the simulator's seed (default: the preset's); WORKERS caps the worker processes.
set -euo pipefail

PRESET="${1:-full}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RECS="$REPO/services/recs"
ROOT="${RECS_ROOT:-$REPO/.cache/recs/$PRESET}"
STORE="$ROOT/store"
TRUTH="$ROOT/truth"
REPORTS="$ROOT/reports"
CLI="$RECS/.venv/bin/webflix-recs"
PY="$RECS/.venv/bin/python"
START="2026-09-01T00:00:00.000Z"

if [[ ! -x "$CLI" ]]; then
  echo "services/recs is not set up: run 'make recs-setup' first" >&2
  exit 2
fi

DAYS="$("$PY" -c "from webflix_recs.simulate.config import preset; print(preset('$PRESET').days)")"
instant() { "$PY" -c "from webflix_recs.ids import iso_ms, parse_iso_ms; print(iso_ms(parse_iso_ms('$START') + int(($1) * 86400000)))"; }
END="$(instant "$DAYS")"
CUTOFF="$(instant "$DAYS - 7")"
COMPACT_AT="$(instant "$DAYS + 0.05")"
if [[ "$PRESET" == "smoke" ]]; then
  GATE_CUTOFFS="${GATE_CUTOFFS:-1}"
else
  GATE_CUTOFFS="${GATE_CUTOFFS:-3}"
fi
SEED_ARGS=()
[[ -n "${SEED:-}" ]] && SEED_ARGS=(--seed "$SEED")

rm -rf "$ROOT"
mkdir -p "$STORE" "$TRUTH" "$REPORTS/steps"

step() {
  local name="$1"
  shift
  local started=$SECONDS
  echo "==> $name"
  if ! "$@" >"$REPORTS/steps/$name.json"; then
    echo "{\"failed\": true, \"wallSeconds\": $((SECONDS - started))}" >"$REPORTS/steps/$name.json"
    return 1
  fi
  echo "    done in $((SECONDS - started))s: $(
    "$PY" -c "import json,sys; d=json.load(open(sys.argv[1])); print({k: d[k] for k in sys.argv[2:] if k in d})" \
      "$REPORTS/steps/$name.json" run recipeHash rows eventLines profiles sessions gate counts hours_compacted maxRssMb
  )"
}
field() { "$PY" -c "import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$REPORTS/steps/$1.json" "$2"; }

echo "recs: preset $PRESET, simulated window $START .. $END, $GATE_CUTOFFS gate cutoff(s) from $CUTOFF, into $ROOT"
echo "==> export-catalog (Node, @webflix/catalog read-only)"
node "$RECS/scripts/export-catalog.ts" --store "$STORE" --anchor "$END"
step simulate "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} simulate --preset "$PRESET" --start "$START" --truth "$TRUTH" \
  ${SEED_ARGS[@]+"${SEED_ARGS[@]}"} --experiment recs-aa --experiment "recs-ranking:effect=0.10"
step compact "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} compact --now "$COMPACT_AT"
step build-dataset "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} build-dataset --dataset main --as-of "$END" --erasures none
for ((k = 1; k <= GATE_CUTOFFS; k++)); do
  at="$(instant "$DAYS - 7 * $k")"
  # Each backtest learns from what was known at its cutoff (a dataset as of it); it is evaluated
  # with the main dataset, which covers its test week.
  step "build-dataset-$k" "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} build-dataset --dataset "cutoff-$k" --as-of "$at" --erasures none
  step "train-backtest-$k" "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} train --dataset "cutoff-$k" --as-of "$at"
  BACKTEST="$(field "train-backtest-$k" run)"
  step "evaluate-$k" "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} evaluate --run "$BACKTEST" --dataset main --truth "$TRUTH" \
    --work "$ROOT/work/$BACKTEST" --out "$REPORTS/evaluation-$k.json"
done
cp "$REPORTS/evaluation-1.json" "$REPORTS/evaluation.json"
step train-production "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} train --dataset main --as-of "$END"
PRODUCTION="$(field train-production run)"
step score "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} score --run "$PRODUCTION" --gate-cutoffs "$GATE_CUTOFFS" --erasures none
# A refusal by the gate is an outcome, not a failure of the run: it is recorded and the run goes
# on (the summary's gate table says at which cutoffs the learned home page lost).
PUBLISHED=1
if ! step publish "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} publish --run "$PRODUCTION"; then
  PUBLISHED=0
  echo "    publish refused by the gate: nothing published"
fi
if [[ "$PUBLISHED" == 1 ]]; then
  step validate "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} validate
fi
step analyse-experiments "$CLI" --store "$STORE" ${WORKERS:+--workers "$WORKERS"} analyse-experiments --as-of "$END" --out "$REPORTS/experiments.json"

"$PY" -m webflix_recs.evaluation.summary "$REPORTS" >"$REPORTS/summary.md"
cat "$REPORTS/summary.md"
echo
if [[ "$PUBLISHED" == 1 ]]; then
  echo "recs: published recs/v=$PRODUCTION/ (pointer: $STORE, key recs/current.json); reports in $REPORTS"
else
  echo "recs: scored recs/v=$PRODUCTION/ but did not publish it (gate refused); reports in $REPORTS"
fi
