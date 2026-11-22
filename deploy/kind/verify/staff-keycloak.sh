#!/usr/bin/env bash
# Staff sign-in through the in-chart Keycloak (production configuration, keycloak.enabled), with
# real tokens: the jobs' service account (client credentials), and demo staff signed in as a
# browser would (authorisation code with PKCE through Keycloak's login page), then the staff API
# through the gateway with each token. make k8s-test-keycloak
#
# Keycloak is reached through a port-forward on 127.0.0.1:4520, pinned to its own hostname
# (curl --connect-to), with the chart's CA: the issuer in every token stays the Service's URL.
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/../lib.sh"

kc -n "$NAMESPACE" get deployment "$RELEASE-keycloak" >/dev/null 2>&1 \
  || fail "No Keycloak in the release: it is part of the production configuration (make k8s-up VARIANT=production)."
work="$(mktemp -d -t webflix-keycloak.XXXXXX)"
secret() { kc -n "$NAMESPACE" get secret "$1" -o "jsonpath={.data.$2}" | base64 -d; }
secret "$RELEASE-keycloak-tls" 'ca\.crt' >"$work/ca.crt"
JOBS="$(secret "$RELEASE-keycloak" jobs-client-secret)"
STAFF_PASSWORD="$(secret "$RELEASE-keycloak" staff-password)"
REALM="$(kc -n "$NAMESPACE" get configmap "$RELEASE-config" -o 'jsonpath={.data.WEBFLIX_STAFF_ISSUER}')"
HOSTPORT="$(printf '%s' "$REALM" | sed -E 's#^https://([^/]+)/.*#\1#')"
case "$HOSTPORT" in *:*) ;; *) HOSTPORT="$HOSTPORT:443" ;; esac
kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$CONTEXT" -n "$NAMESPACE" port-forward \
  "svc/$RELEASE-keycloak" 4520:8443 --address 127.0.0.1 >"$work/pf.log" 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null; wait $PF 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do grep -q Forwarding "$work/pf.log" && break; sleep 0.2; done
C=(curl -sS --cacert "$work/ca.crt" --connect-to "$HOSTPORT:127.0.0.1:4520")
json() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }
claims() {
  python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; p+="="*(-len(p)%4); d=json.loads(base64.urlsafe_b64decode(p)); print("    " + json.dumps({k: d.get(k) for k in ["iss","aud","typ","azp","preferred_username","resource_access"]}))' "$1"
}
api() { # token, path → "status body…"
  local status
  status="$(curl -sS -o "$work/body" -w '%{http_code}' -H "Authorization: Bearer $1" "$BASE_URL/api/admin/v1$2")"
  printf '%s %s' "$status" "$(head -c 160 "$work/body")"
}
signin() { # user → access token, through the login page as a browser; the answer in tokens.json
  local verifier challenge action location code
  rm -f "$work/jar"
  verifier="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  challenge="$(python3 -c 'import sys,hashlib,base64; print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).decode().rstrip("="))' "$verifier")"
  action="$("${C[@]}" -c "$work/jar" -b "$work/jar" "$REALM/protocol/openid-connect/auth?client_id=webflix-admin&response_type=code&scope=openid&state=s1&nonce=n1&redirect_uri=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$BASE_URL/admin/auth/callback")&code_challenge=$challenge&code_challenge_method=S256" \
    | python3 -c 'import sys,re,html; print(html.unescape(re.search(r"action=\"([^\"]+)\"", sys.stdin.read()).group(1)))')"
  location="$("${C[@]}" -c "$work/jar" -b "$work/jar" -o /dev/null -w '%{redirect_url}' \
    --data-urlencode "username=$1" --data-urlencode "password=$STAFF_PASSWORD" -d credentialId= "$action")"
  code="$(python3 -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query)["code"][0])' "$location")"
  "${C[@]}" -d grant_type=authorization_code -d client_id=webflix-admin -d "code=$code" -d "code_verifier=$verifier" \
    --data-urlencode "redirect_uri=$BASE_URL/admin/auth/callback" "$REALM/protocol/openid-connect/token" >"$work/tokens.json"
  json '["access_token"]' <"$work/tokens.json"
}

step "Keycloak realm $REALM"
info "discovery issuer: $("${C[@]}" "$REALM/.well-known/openid-configuration" | json '["issuer"]')"
step "Service account webflix-jobs (client credentials)"
SA="$("${C[@]}" -u "webflix-jobs:$JOBS" -d grant_type=client_credentials "$REALM/protocol/openid-connect/token" | json '["access_token"]')"
claims "$SA"
info "GET /me                      $(api "$SA" /me)"
info "GET /system/privacy/exports  $(api "$SA" '/system/privacy/exports?limit=5')"
info "a wrong client secret:       $("${C[@]}" -o /dev/null -w '%{http_code}' -u webflix-jobs:wrong -d grant_type=client_credentials "$REALM/protocol/openid-connect/token")"
for user in staff-support staff-billing staff-none; do
  step "$user (code flow with PKCE through the login page)"
  token="$(signin "$user")"
  claims "$token"
  info "GET /me                      $(api "$token" /me)"
  info "GET /members (support)       $(api "$token" '/members?q=demo')"
  info "GET /plans (billing)         $(api "$token" /plans)"
  info "GET /system/health (admin)   $(api "$token" /system/health)"
done
step "staff-admin: its ID token is refused, its access token is not"
signin staff-admin >/dev/null
info "ID token GET /me             $(api "$(json '["id_token"]' <"$work/tokens.json")" /me)"
info "access token /system/health  $(api "$(json '["access_token"]' <"$work/tokens.json")" /system/health)"
