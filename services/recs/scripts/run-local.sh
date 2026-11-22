#!/usr/bin/env bash
# The full local run of the recommendation pipeline, from an empty directory (make recs).
#
#   services/recs/scripts/run-local.sh [smoke|medium|full]
#
# Everything lands under .cache/recs/<preset>/: store/ (the blob store: lake, catalogue,
# working data, artefacts), truth/ (the simulator's ground truth, read only by evaluation) and
# reports/ (evaluation, experiment analysis, summary.md). Each step prints what it did and how
# long it took; the CLI's JSON summaries are kept in reports/steps/.
set -euo pipefail

PRESET="${1:-full}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RECS="$REPO/services/recs"
ROOT="$REPO/.cache/recs/$PRESET"
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

echo "recs: preset $PRESET, simulated window $START .. $END, backtest cutoff $CUTOFF, into $ROOT"
echo "==> export-catalog (Node, @webflix/catalog read-only)"
node "$RECS/scripts/export-catalog.ts" --store "$STORE" --anchor "$END"
step simulate "$CLI" --store "$STORE" simulate --preset "$PRESET" --start "$START" --truth "$TRUTH" \
  --experiment recs-aa --experiment "recs-ranking:effect=0.10"
step compact "$CLI" --store "$STORE" compact --now "$COMPACT_AT"
step build-dataset "$CLI" --store "$STORE" build-dataset --dataset main --as-of "$END"
step train-backtest "$CLI" --store "$STORE" train --dataset main --as-of "$CUTOFF"
BACKTEST="$(field train-backtest run)"
step evaluate "$CLI" --store "$STORE" evaluate --run "$BACKTEST" --dataset main --truth "$TRUTH" \
  --work "$ROOT/work" --out "$REPORTS/evaluation.json"
step train-production "$CLI" --store "$STORE" train --dataset main --as-of "$END"
PRODUCTION="$(field train-production run)"
step score "$CLI" --store "$STORE" score --run "$PRODUCTION"
# At smoke size the learned models have too little data to beat the rule engine, and the gate
# refuses to publish: the run records the refusal and goes on. At other sizes it is a failure.
PUBLISHED=1
if ! step publish "$CLI" --store "$STORE" publish --run "$PRODUCTION"; then
  PUBLISHED=0
  if [[ "$PRESET" != "smoke" ]]; then
    echo "recs: publish refused (see above)" >&2
    exit 3
  fi
  echo "    publish refused by the gate (expected at smoke size): nothing published"
fi
if [[ "$PUBLISHED" == 1 ]]; then
  step validate "$CLI" --store "$STORE" validate
fi
step analyse-experiments "$CLI" --store "$STORE" analyse-experiments --as-of "$END" --out "$REPORTS/experiments.json"

"$PY" -m webflix_recs.evaluation.summary "$REPORTS" >"$REPORTS/summary.md"
cat "$REPORTS/summary.md"
echo
if [[ "$PUBLISHED" == 1 ]]; then
  echo "recs: published recs/v=$PRODUCTION/ (pointer: $STORE, key recs/current.json); reports in $REPORTS"
else
  echo "recs: scored recs/v=$PRODUCTION/ but did not publish it (gate refused); reports in $REPORTS"
fi
