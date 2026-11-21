#!/usr/bin/env bash
# Container-level test of the web image's nginx configuration (make k8s-test-web).
#
#   deploy/docker/web/test.sh [image]     (default webflix-web:dev, built by `make k8s-images`)
#
# Runs the image as the chart does (read-only root filesystem, /tmp in memory, non-root) on a
# free loopback port in 4530-4549 and checks the serving rules: hashed assets immutable, the
# shell revalidated, SPA fallback for page loads only, missing files as `no-store` 404 problem
# documents (never the HTML shell), compression, security headers, and the probe listener.
# Checks are strings evaluated by expect(), so the variables fetch() sets are read there.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

IMAGE="${1:-webflix-web:dev}"
NAME="webflix-k8s-web-test-$$"
failures=0

free_port() {
  local port
  for port in $(seq "$1" 4549); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "$port"; return 0; fi
  done
  return 1
}
PORT="$(free_port 4530)"
STATUS_PORT="$(free_port $((PORT + 1)))"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$NAME" --read-only --tmpfs /tmp --user 101:101 \
  -p "127.0.0.1:$PORT:8080" -p "127.0.0.1:$STATUS_PORT:8081" "$IMAGE" >/dev/null
for _ in $(seq 1 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$STATUS_PORT/healthz" 2>/dev/null && break
  sleep 0.2
done

BASE="http://127.0.0.1:$PORT"
RANDOM_ID="$(LC_ALL=C date +%s)$$"
HEADERS="$(mktemp)"
BODY="$(mktemp)"
trap 'cleanup; rm -f "$HEADERS" "$BODY"' EXIT

# fetch <path> [curl args...] → sets STATUS, TYPE, CACHE, ENCODING, CSP
fetch() {
  local path="$1"
  shift
  STATUS="$(curl -sS -o "$BODY" -D "$HEADERS" -w '%{http_code}' "$@" "$BASE$path")"
  # An absent header is an empty value, not a failure (pipefail).
  header() { { grep -i "^$1:" "$HEADERS" || true; } | tail -n 1 | cut -d' ' -f2- | tr -d '\r'; }
  TYPE="$(header Content-Type)"
  CACHE="$(header Cache-Control)"
  ENCODING="$(header Content-Encoding)"
  CSP="$(header Content-Security-Policy)"
}
expect() { # <description> <condition...>
  local description="$1"
  shift
  if "$@"; then printf '  ✓ %s\n' "$description"; else
    printf '  ✗ %s (status %s, type "%s", cache "%s")\n' "$description" "$STATUS" "$TYPE" "$CACHE"
    failures=$((failures + 1))
  fi
}
is() { [ "$1" = "$2" ]; }
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
lacks() { ! contains "$1" "$2"; }
no_positive_max_age() { ! printf '%s' "$1" | grep -Eq 'max-age=[1-9]'; }
NAV=(-H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Dest: document" -H "Accept: text/html,application/xhtml+xml")

echo "web image $IMAGE on $BASE"

fetch / "${NAV[@]}" -H "Accept-Encoding: gzip"
expect "/ is the app shell, revalidated, compressed, with a CSP" \
  eval 'is "$STATUS" 200 && contains "$TYPE" text/html && is "$CACHE" no-cache && is "$ENCODING" gzip && [ -n "$CSP" ]'
SCRIPT="$(curl -sS "$BASE/" | grep -oE '<script type="module"[^>]*src="/assets/[^"]+"' | grep -oE '/assets/[^"]+' | head -n 1)"

# a. an existing hashed asset
fetch "$SCRIPT" -H "Sec-Fetch-Dest: script" -H "Sec-Fetch-Mode: cors" -H "Accept-Encoding: gzip"
expect "a. $SCRIPT: 200 JavaScript, immutable, gzip" \
  eval 'is "$STATUS" 200 && contains "$TYPE" javascript && contains "$CACHE" immutable && is "$ENCODING" gzip'

# b. missing files are 404, not HTML, no-store
for spec in "/assets/smoke-$RANDOM_ID.js|script" "/assets/smoke-$RANDOM_ID.css|style" "/smoke-$RANDOM_ID.png|image"; do
  path="${spec%|*}"
  dest="${spec#*|}"
  fetch "$path" -H "Sec-Fetch-Dest: $dest" -H "Sec-Fetch-Mode: no-cors" -H "Accept: */*"
  expect "b. $path ($dest): 404 problem, no-store, never immutable" \
    eval 'is "$STATUS" 404 && lacks "$TYPE" text/html && contains "$CACHE" no-store && lacks "$CACHE" immutable && no_positive_max_age "$CACHE" && [ -n "$CSP" ]'
done
fetch "/smoke-$RANDOM_ID.png"
expect "b. /smoke-….png without Fetch Metadata or HTML Accept: 404" eval 'is "$STATUS" 404 && lacks "$TYPE" text/html'

# c. a missing asset requested as a page load is still a 404
fetch "/assets/smoke-$RANDOM_ID.js" "${NAV[@]}"
expect "c. /assets/smoke-….js as a navigation: 404, no-store" \
  eval 'is "$STATUS" 404 && contains "$CACHE" no-store'

# d. client-side routes get the shell
fetch "/browse/genre/smoke-$RANDOM_ID" "${NAV[@]}"
expect "d. /browse/genre/smoke-… as a navigation: 200 HTML shell, not immutable" \
  eval 'is "$STATUS" 200 && contains "$TYPE" text/html && lacks "$CACHE" immutable && no_positive_max_age "$CACHE"'
fetch "/title/t-sintel" -H "Accept: text/html"
expect "d. a deep link from a client without Fetch Metadata: the shell" eval 'is "$STATUS" 200 && contains "$TYPE" text/html'

# server-owned paths and probes never get the shell
for path in /api/v1/plans /media/x/vod/a/master.m3u8 /cdn/img/x.webp /metrics /readyz; do
  fetch "$path" "${NAV[@]}"
  expect "$path: 404 problem (the gateway routes it elsewhere)" \
    eval 'is "$STATUS" 404 && contains "$TYPE" application/problem+json && contains "$CACHE" no-store'
done
fetch /favicon.svg -H "Sec-Fetch-Dest: image"
expect "/favicon.svg: an hour of caching" eval 'is "$STATUS" 200 && is "$CACHE" "public, max-age=3600"'
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$STATUS_PORT/healthz")"
expect ":8081/healthz answers" is "$STATUS" 200

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
