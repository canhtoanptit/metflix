#!/usr/bin/env bash
# Rotate the media token signing key with no failed playback (make k8s-rotate-media-key STEP=…).
#
# Every API pod signs with the FIRST key of WEBFLIX_MEDIA_TOKEN_KEYS and verifies with ALL of
# them. Putting a new key first in one step breaks playback during the rollout: new pods sign
# with a key old pods cannot verify yet. So a rotation is three steps, each followed by a full
# rollout of the API and the worker (a release upgrade with the current values):
#
#   add      append a new key, verify-only        (every pod learns it; old one still signs)
#   promote  move the newest key to the front      (new pods sign with it; old pods verify it)
#   retire   drop every key but the first          (after the token lifetime, 6 h by default:
#                                                    tokens signed with the old key expire first)
#
# The same keys sign the `webflix_device` cookie (known browsers are exempt from the per-email
# sign-in limit): after `retire`, a browser whose cookie the retired key signed is unknown once,
# until it signs in again.
#
# Works on the chart-generated Secret (<release>-media-tokens); the chart keeps edited values
# across upgrades. With secrets.existingSecret, apply the same three edits to that Secret and
# upgrade the release after each.
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/lib.sh"

STEP="${1:-${STEP:-}}"
SECRET="${MEDIA_TOKEN_SECRET:-$RELEASE-media-tokens}"
case "$STEP" in add | promote | retire) ;; *) fail "usage: rotate-media-key.sh add|promote|retire" ;; esac

current="$(kc -n "$NAMESPACE" get secret "$SECRET" -o 'jsonpath={.data.WEBFLIX_MEDIA_TOKEN_KEYS}' | base64 -d)" \
  || fail "Secret $SECRET not found in $NAMESPACE"
IFS=',' read -r -a keys <<<"$current"
ids() { local list=() entry; for entry in "$@"; do list+=("${entry%%:*}"); done; echo "${list[*]}"; }

case "$STEP" in
  add)
    id="k$(date +%y%m%d%H%M%S)"
    # `head` closing the pipe makes `tr` fail with SIGPIPE: not an error here.
    secret="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
    [ "${#secret}" -eq 48 ] || fail "Could not generate a key."
    next=("${keys[@]}" "$id:$secret")
    ;;
  promote)
    [ "${#keys[@]}" -ge 2 ] || fail "Nothing to promote: only one key (run add first)."
    newest="${keys[${#keys[@]}-1]}"
    next=("$newest" "${keys[@]:0:${#keys[@]}-1}")
    ;;
  retire)
    [ "${#keys[@]}" -ge 2 ] || fail "Nothing to retire: only one key."
    next=("${keys[0]}")
    ;;
esac

value="$(IFS=','; echo "${next[*]}")"
step "Media token keys, $STEP: [$(ids "${keys[@]}")] → [$(ids "${next[@]}")] (first signs)"
# The generated Secret's value is edited in place (credentials never go through values); its
# own field manager makes that visible (node deploy/kind/verify/ownership.ts), and the chart
# renders the live value back (lookup), so the two can never conflict. The pods then roll
# through the release: the pod templates carry a checksum of the Secrets.
kc -n "$NAMESPACE" patch secret "$SECRET" --type merge --field-manager=webflix-rotate-media-key \
  -p "{\"stringData\":{\"WEBFLIX_MEDIA_TOKEN_KEYS\":\"$value\"}}" >/dev/null
release_change reapply
ok "every API and worker pod runs with [$(ids "${next[@]}")] (revision $(deployed_revision))"
case "$STEP" in
  add) info "next: STEP=promote (as soon as this rollout is done)" ;;
  promote) info "next: STEP=retire, once tokens signed by the old key have expired (WEBFLIX_MEDIA_TOKEN_TTL_SEC)" ;;
esac
