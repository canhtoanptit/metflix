#!/usr/bin/env bash
# The API image against a TLS-only PostgreSQL whose certificate comes from a private CA (what
# RDS, Cloud SQL and Azure look like), with `?sslmode=require`:
#   - without the CA bundle the connection is refused ("unable to verify the first certificate",
#     or "self-signed certificate in certificate chain" when the server also sends its CA),
#   - with it, passed as NODE_EXTRA_CA_CERTS exactly as the chart's tls.extraCaCerts does,
#     `wait` succeeds and `migrate` runs over TLS,
#   - the server refuses plaintext, so success can only have been over TLS,
#   - a client certificate (externalDatabase.clientCertSecret, referenced from the URL with
#     sslcert/sslkey) authenticates a role that only accepts certificates.
#
#   deploy/kind/verify/pg-tls.sh [api-image]     (default webflix-api:dev; needs openssl)
# Checks are strings evaluated by expect(), so their variables expand there, not here.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

IMAGE="${1:-webflix-api:dev}"
RUN="webflix-k8s-pgtls-$$"
NET="$RUN-net"
DIR="$(mktemp -d)"
PG_IMAGE="postgres:19.0-alpine3.24@sha256:8b0ff4cdf221f0c53d7fcda681d3b461be725c492cd881c5ec9c0ad25023f188"
cleanup() {
  docker rm -f "$RUN" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
failures=0
expect() { if eval "$2"; then echo "  ✓ $1"; else echo "  ✗ $1"; failures=$((failures + 1)); fi; }

# A private CA and a server certificate for the container's DNS name.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$DIR/ca.key" -out "$DIR/ca.crt" -days 1 \
  -subj "/CN=Webflix test private CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout "$DIR/server.key" -out "$DIR/server.csr" \
  -subj "/CN=$RUN" 2>/dev/null
printf 'subjectAltName=DNS:%s\n' "$RUN" >"$DIR/san.ext"
openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -out "$DIR/server.crt" -days 1 -extfile "$DIR/san.ext" 2>/dev/null
# A client certificate for the role `mtls`, which may only log in with it.
openssl req -newkey rsa:2048 -nodes -keyout "$DIR/client.key" -out "$DIR/client.csr" -subj "/CN=mtls" 2>/dev/null
openssl x509 -req -in "$DIR/client.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -out "$DIR/client.crt" -days 1 2>/dev/null
printf 'local all all trust\nhostssl all mtls all cert\nhostssl all all all scram-sha-256\n' >"$DIR/pg_hba.conf"
mkdir -p "$DIR/bundle" "$DIR/client" && cp "$DIR/ca.crt" "$DIR/bundle/ca.crt"
cp "$DIR/client.crt" "$DIR/client/tls.crt" && cp "$DIR/client.key" "$DIR/client/tls.key"

docker network create "$NET" >/dev/null
docker run -d --name "$RUN" --network "$NET" -e POSTGRES_USER=webflix -e POSTGRES_PASSWORD=webflix \
  -e POSTGRES_DB=webflix -v "$DIR:/certs-src:ro" --tmpfs /var/lib/postgresql --entrypoint sh "$PG_IMAGE" \
  -c 'mkdir -p /tmp/certs && cp /certs-src/server.* /certs-src/ca.crt /certs-src/pg_hba.conf /tmp/certs/ \
      && chown postgres /tmp/certs/* && chmod 600 /tmp/certs/server.key \
      && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/certs/server.crt \
         -c ssl_key_file=/tmp/certs/server.key -c ssl_ca_file=/tmp/certs/ca.crt \
         -c hba_file=/tmp/certs/pg_hba.conf' >/dev/null
for _ in $(seq 1 60); do docker exec "$RUN" pg_isready -U webflix >/dev/null 2>&1 && break; sleep 1; done
sleep 2
docker exec "$RUN" psql -q -U webflix -d webflix -c 'CREATE ROLE mtls LOGIN' >/dev/null

api() { # <sslmode> <with-ca: yes|no> <command...>     (WEBFLIX_DATABASE_URL overrides the URL)
  local mode="$1" ca="$2"
  shift 2
  local extra=()
  [ "$ca" = yes ] && extra=(-v "$DIR/bundle:/etc/webflix/ca:ro" -e NODE_EXTRA_CA_CERTS=/etc/webflix/ca/ca.crt
    -v "$DIR/client:/etc/webflix/tls/database:ro")
  docker run --rm --network "$NET" "${extra[@]+"${extra[@]}"}" -e WEBFLIX_MODE=k8s \
    -e "WEBFLIX_DATABASE_URL=${URL:-postgres://webflix@$RUN:5432/webflix?sslmode=$mode}" -e PGPASSWORD=webflix \
    -e WEBFLIX_BLOB_STORE=memory "$IMAGE" "$@" 2>&1 || true
}

echo "API image $IMAGE against a TLS-only PostgreSQL with a private CA"
out="$(api require no wait --skip-migrations --timeout 6)"
expect "sslmode=require without the CA bundle: refused (certificate not trusted)" \
  'printf "%s" "$out" | grep -Eq "unable to verify the first certificate|self-signed certificate in certificate chain"'
out="$(api disable no wait --skip-migrations --timeout 4)"
expect "plaintext: refused by the server (TLS only)" 'printf "%s" "$out" | grep -q "no pg_hba.conf entry"'
out="$(api require yes wait --skip-migrations --timeout 20)"
expect "sslmode=require with the CA bundle (NODE_EXTRA_CA_CERTS): connected" \
  'printf "%s" "$out" | grep -q "\"wait.ready\""'
out="$(api require yes migrate)"
expect "migrate over TLS" 'printf "%s" "$out" | grep -q "\"db.migrated\""'
CLIENT="sslcert=/etc/webflix/tls/database/tls.crt&sslkey=/etc/webflix/tls/database/tls.key"
out="$(URL="postgres://mtls@$RUN:5432/webflix?sslmode=require" api require yes wait --skip-migrations --timeout 4)"
expect "certificate-only role without a client certificate: refused" \
  'printf "%s" "$out" | grep -q "requires a valid client certificate"'
out="$(URL="postgres://mtls@$RUN:5432/webflix?sslmode=require&$CLIENT" api require yes wait --skip-migrations --timeout 20)"
expect "client certificate from the URL (sslcert/sslkey): authenticated" \
  'printf "%s" "$out" | grep -q "\"wait.ready\""'

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
