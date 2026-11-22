#!/usr/bin/env bash
# Host guard: run a heavy command (a browser suite, a redeploy) and stop it, with every process it
# started, when this machine runs short (e2e/README.md "Host guard").
#
#   e2e/scripts/host-guard.sh <command> [args...]   exit 99 if the guard stopped it (or would not
#                                                   start it); otherwise the command's own code
#   e2e/scripts/host-guard.sh --probe               print one sample of the host and exit
#
# Why it exists: on 2026-11-22 a full browser run (nine workers, a video and a trace for every
# test, dozens of headless browsers) was started on a Mac already 27 GB into swap. The host ran out
# of memory, the window server aborted and the owner's session ended with every app in it. The
# guard refuses to start on a host that is already short, and stops the run when it gets there.
#
# Limits, each checked every HOST_GUARD_INTERVAL_SEC (5) seconds; HOST_GUARD_STRIKES (3) samples
# in a row over any limit stop the command:
#   HOST_GUARD_SWAP_MAX_MB   (6000)  swap in use
#   HOST_GUARD_LOAD_MAX      (45)    1-minute load average
#   HOST_GUARD_SURFACES_MAX  (3000)  kernel graphics surfaces (`ioclasscount IOSurface`); idle
#                                    is about 190, and an IOSurface leak preceded the crash
# Other settings:
#   HOST_GUARD=off           run the command unguarded
#   HOST_GUARD_LOG=<file>    append one line per sample (time, swap, load, surfaces, compressed)
#   HOST_GUARD_GRACE_SEC     (10) seconds between SIGTERM and SIGKILL when stopping
#   HOST_GUARD_PROBE=<cmd>   replaces the macOS probes: prints "<swapMB> <load> <surfaces>
#                            [<compressedMB>]", "-" for an unknown field (scripts/check-host-guard.ts)
#
# Where the probes do not exist (Linux, most CI) the guard is a no-op: it runs the command as is.
#
# The command stays in the caller's process group, so Ctrl-C reaches it directly. Stopping walks
# its process tree by PID, because Playwright starts each browser in a process group of its own.
set -u

swap_max=${HOST_GUARD_SWAP_MAX_MB:-6000}
load_max=${HOST_GUARD_LOAD_MAX:-45}
surfaces_max=${HOST_GUARD_SURFACES_MAX:-3000}
strikes_max=${HOST_GUARD_STRIKES:-3}
interval=${HOST_GUARD_INTERVAL_SEC:-5}
grace=${HOST_GUARD_GRACE_SEC:-10}
log=${HOST_GUARD_LOG:-}

say() { echo "host-guard: $*" >&2; }

# One sample: "<swapMB> <load> <surfaces> <compressedMB>", "-" where a probe is missing.
probe() {
  if [ -n "${HOST_GUARD_PROBE:-}" ]; then
    sh -c "$HOST_GUARD_PROBE" 2>/dev/null | head -n 1
    return
  fi
  local swap load surfaces compressed
  # "total = 2048.00M  used = 348.00M  free = 1700.00M  (encrypted)"
  swap=$(sysctl -n vm.swapusage 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "used" && $(i + 1) == "=") { v = $(i + 2); m = (v ~ /G$/) ? 1024 : 1; sub(/[MG]$/, "", v); printf "%d", v * m } }')
  # "{ 1.63 1.80 2.07 }"
  load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{ print $2 }')
  # "IOSurface = 193"
  surfaces=$(ioclasscount IOSurface 2>/dev/null | awk -F= '{ gsub(/ /, "", $2); print $2 }')
  # "Mach Virtual Memory Statistics: (page size of 16384 bytes)" ... "Pages stored in compressor: 92274."
  compressed=$(vm_stat 2>/dev/null |
    awk '/page size of/ { for (i = 1; i <= NF; i++) if ($i == "of") size = $(i + 1) } /stored in compressor/ { gsub(/\./, "", $NF); pages = $NF } END { if (size && pages != "") printf "%d", pages * size / 1048576 }')
  echo "${swap:--} ${load:--} ${surfaces:--} ${compressed:--}"
}

# Prints what is over its limit ("swap 7000 MB > 6000 MB, ..."), nothing when all is well.
over_limits() {
  awk -v s="$1" -v l="$2" -v f="$3" -v sm="$swap_max" -v lm="$load_max" -v fm="$surfaces_max" 'BEGIN {
    out = ""
    if (s != "-" && s + 0 > sm + 0) out = out sprintf("swap %d MB > %d MB, ", s, sm)
    if (l != "-" && l + 0 > lm + 0) out = out sprintf("load %s > %s, ", l, lm)
    if (f != "-" && f + 0 > fm + 0) out = out sprintf("surfaces %d > %d, ", f, fm)
    sub(/, $/, "", out); printf "%s", out
  }'
}

# Sets swap, load, surfaces and compressed from one probe; "-" for anything missing.
sample() {
  read -r swap load surfaces compressed <<<"$(probe)"
  swap=${swap:--} load=${load:--} surfaces=${surfaces:--} compressed=${compressed:--}
}

describe() { echo "swapMB=$1 load=$2 surfaces=$3 compressedMB=$4"; }

if [ "${1:-}" = "--probe" ]; then
  sample
  describe "$swap" "$load" "$surfaces" "$compressed"
  [ "$swap" != "-" ] || [ "$load" != "-" ] || [ "$surfaces" != "-" ]
  exit
fi

if [ $# -eq 0 ]; then
  echo "usage: host-guard.sh <command> [args...] | --probe" >&2
  exit 2
fi

if [ "${HOST_GUARD:-on}" = "off" ] || [ "${HOST_GUARD:-on}" = "0" ]; then
  exec "$@"
fi

sample
if [ "$swap" = "-" ] && [ "$load" = "-" ] && [ "$surfaces" = "-" ]; then
  # No probes on this host (Linux, CI): nothing to guard with.
  exec "$@"
fi

record() {
  [ -n "$log" ] && echo "$(date +%T) $(describe "$@")" >>"$log"
  return 0
}

record "$swap" "$load" "$surfaces" "$compressed"
reason=$(over_limits "$swap" "$load" "$surfaces")
if [ -n "$reason" ]; then
  say "not starting \`$*\`: the host is already short ($reason)"
  [ -n "$log" ] && echo "$(date +%T) NOT STARTED: $reason" >>"$log"
  exit 99
fi

descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    echo "$child"
    descendants "$child"
  done
}

# SIGTERM to the command and everything under it, SIGKILL to whatever is left after the grace
# period (including anything started meanwhile).
stop_tree() {
  local targets alive pid waited=0
  targets="$cmd_pid $(descendants "$cmd_pid")"
  # shellcheck disable=SC2086 # word splitting is the point: one PID per word
  kill -TERM $targets 2>/dev/null
  while [ "$waited" -lt $((grace * 2)) ]; do
    alive=""
    for pid in $targets; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -z "$alive" ] && break
    sleep 0.5
    waited=$((waited + 1))
  done
  targets="$targets $(descendants "$cmd_pid")"
  # shellcheck disable=SC2086
  kill -KILL $targets 2>/dev/null
  wait "$cmd_pid" 2>/dev/null
}

# A background job of a non-interactive shell starts with SIGINT and SIGQUIT ignored, and `trap -`
# cannot undo that; programs such as make keep ignoring them, so Ctrl-C would not reach the
# command. Perl resets them before it executes the command.
if command -v perl >/dev/null 2>&1; then
  perl -e '$SIG{INT} = $SIG{QUIT} = "DEFAULT"; exec { $ARGV[0] } @ARGV or do { print STDERR "host-guard: $ARGV[0]: $!\n"; exit 127 }' "$@" &
else
  "$@" &
fi
cmd_pid=$!

# Ctrl-C reaches the command from the terminal; the guard waits for it to finish. SIGTERM or SIGHUP
# sent to the guard alone is passed on to the whole tree.
trap ':' INT
trap 'say "stopping \`$*\` (signal)"; stop_tree; exit 143' TERM HUP

# Wait between samples in steps of at most 0.5 s, so the guard ends within 0.5 s of the command.
steps=$(awk -v i="$interval" 'BEGIN { n = int(i / 0.5); print (n < 1) ? 1 : n }')
step=$(awk -v i="$interval" -v n="$steps" 'BEGIN { print i / n }')
sleeper=""
trap '[ -n "$sleeper" ] && kill "$sleeper" 2>/dev/null' EXIT

peak_swap=$swap peak_load=$load first_surfaces=$surfaces peak_surfaces=$surfaces last_surfaces=$surfaces
strikes=0
while kill -0 "$cmd_pid" 2>/dev/null; do
  n=0
  while [ "$n" -lt "$steps" ] && kill -0 "$cmd_pid" 2>/dev/null; do
    sleep "$step" &
    sleeper=$!
    wait "$sleeper" 2>/dev/null
    n=$((n + 1))
  done
  kill -0 "$cmd_pid" 2>/dev/null || break
  sample
  record "$swap" "$load" "$surfaces" "$compressed"
  peak_swap=$(awk -v a="$peak_swap" -v b="$swap" 'BEGIN { print (b != "-" && (a == "-" || b + 0 > a + 0)) ? b : a }')
  peak_load=$(awk -v a="$peak_load" -v b="$load" 'BEGIN { print (b != "-" && (a == "-" || b + 0 > a + 0)) ? b : a }')
  peak_surfaces=$(awk -v a="$peak_surfaces" -v b="$surfaces" 'BEGIN { print (b != "-" && (a == "-" || b + 0 > a + 0)) ? b : a }')
  last_surfaces=$surfaces
  reason=$(over_limits "$swap" "$load" "$surfaces")
  if [ -n "$reason" ]; then
    strikes=$((strikes + 1))
  else
    strikes=0
  fi
  if [ "$strikes" -ge "$strikes_max" ]; then
    say "STOPPED \`$*\` after $strikes samples in a row over the limit: $reason"
    [ -n "$log" ] && echo "$(date +%T) GUARD STOPPED THE RUN: $reason" >>"$log"
    stop_tree
    exit 99
  fi
done

wait "$cmd_pid"
code=$?
say "peak swap ${peak_swap} MB, peak load ${peak_load}, surfaces ${first_surfaces} -> ${last_surfaces} (peak ${peak_surfaces}); exit ${code}"
exit "$code"
