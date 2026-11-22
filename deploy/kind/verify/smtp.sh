#!/usr/bin/env bash
# Email through SMTP to the in-chart mail catcher (production configuration,
# mailcatcher.enabled): a new member signs up and asks for a password reset; the worker's email
# jobs send both over SMTP; Mailpit's API (port-forward on 127.0.0.1:4521) shows them.
# make k8s-test-smtp
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/../lib.sh"

kc -n "$NAMESPACE" get deployment "$RELEASE-mailcatcher" >/dev/null 2>&1 \
  || fail "No mail catcher in the release: it is part of the production configuration (make k8s-up VARIANT=production)."
work="$(mktemp -d -t webflix-smtp.XXXXXX)"
address="smtp-$(date +%s)-$$@example.test"
H=(-H 'Content-Type: application/json' -H 'X-Webflix-Client: web')
# JSON bodies in variables first: bash 3.2 (macOS) mis-parses escaped quotes inside $( ) inside
# double quotes, and would brace-expand the body.
signup_body='{"email":"'"$address"'","password":"correct horse battery staple 42"}'
reset_body='{"email":"'"$address"'"}'
step "A member: $address"
status="$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -d "$signup_body" "$BASE_URL/api/v1/auth/signup")"
info "sign-up: $status"
status="$(curl -sS -o /dev/null -w '%{http_code}' "${H[@]}" -d "$reset_body" "$BASE_URL/api/v1/auth/password-reset")"
info "password reset: $status"
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$NAMESPACE" port-forward \
  "svc/$RELEASE-mailcatcher" 4521:8025 --address 127.0.0.1 >"$work/pf.log" 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null; wait $PF 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do grep -q Forwarding "$work/pf.log" && break; sleep 0.2; done
search() { curl -sS "http://127.0.0.1:4521/api/v1/search?query=to:$address"; }
for _ in $(seq 1 30); do
  count="$(search | python3 -c 'import sys,json; print(json.load(sys.stdin)["messages_count"])')"
  [ "$count" -ge 2 ] && break
  sleep 1
done
step "Mailpit has $count message(s) for $address"
search | python3 -c 'import sys,json
for m in json.load(sys.stdin)["messages"]: print("    " + m["Created"] + "  " + m["Subject"])'
id="$(search | python3 -c 'import sys,json; print(next(m["ID"] for m in json.load(sys.stdin)["messages"] if "eset" in m["Subject"]))')"
curl -sS "http://127.0.0.1:4521/api/v1/message/$id/headers" \
  | python3 -c 'import sys,json; h=json.load(sys.stdin); [print("    " + k + ": " + " | ".join(h[k])) for k in ["From","To","Subject","Received"] if k in h]'
[ "$count" -ge 2 ] || fail "expected the verification and the reset email"
ok "both emails left through SMTP and reached the catcher"
