{{/* ---------------------------------------------------------------------- names ---- */}}

{{- define "webflix.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "webflix.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* "<fullname>-<suffix>", e.g. include "webflix.component" (list . "api") */}}
{{- define "webflix.component" -}}
{{- printf "%s-%s" (include "webflix.fullname" (index . 0)) (index . 1) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "webflix.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- labels --- */}}

{{/* Selector labels: include "webflix.selectorLabels" (list . "api") */}}
{{- define "webflix.selectorLabels" -}}
{{- $ctx := index . 0 -}}
app.kubernetes.io/name: {{ include "webflix.name" $ctx }}
app.kubernetes.io/instance: {{ $ctx.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{/* Common labels: include "webflix.labels" (list . "api") */}}
{{- define "webflix.labels" -}}
{{- $ctx := index . 0 -}}
helm.sh/chart: {{ include "webflix.chart" $ctx }}
{{ include "webflix.selectorLabels" . }}
app.kubernetes.io/part-of: webflix
app.kubernetes.io/version: {{ $ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ $ctx.Release.Service }}
{{- end -}}

{{/* ---------------------------------------------------------------------- images --- */}}

{{/* First-party image: include "webflix.image" (list . .Values.api.image) */}}
{{- define "webflix.image" -}}
{{- $ctx := index . 0 -}}
{{- $image := index . 1 -}}
{{- $ref := printf "%s%s" $ctx.Values.image.registry $image.repository -}}
{{- if $image.digest -}}
{{- printf "%s@%s" $ref $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $ref (default $ctx.Chart.AppVersion $image.tag) -}}
{{- end -}}
{{- end -}}

{{/* Third-party image pinned by tag and digest: include "webflix.thirdPartyImage" .Values.valkey.image */}}
{{- define "webflix.thirdPartyImage" -}}
{{- if .digest -}}
{{- printf "%s:%s@%s" .repository .tag .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}
{{- end -}}

{{- define "webflix.imagePullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "webflix.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "webflix.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- secrets -- */}}

{{/*
A generated secret value that survives upgrades: the value already stored in the cluster if
there is one, else `default` (a fresh random value). Data stores initialise themselves from
these on first start, so they must never change behind their back.
  include "webflix.persistedValue" (dict "ctx" . "secret" "name" "key" "k" "default" "x")
*/}}
{{- define "webflix.persistedValue" -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace .secret -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key | b64dec -}}
{{- else -}}
{{- .default -}}
{{- end -}}
{{- end -}}

{{- define "webflix.postgresql.secretName" -}}
{{- if .Values.postgresql.enabled -}}
{{- default (include "webflix.component" (list . "postgresql")) .Values.postgresql.auth.existingSecret -}}
{{- else -}}
{{- .Values.externalDatabase.existingSecret -}}
{{- end -}}
{{- end -}}

{{- define "webflix.postgresql.passwordKey" -}}
{{- if .Values.postgresql.enabled -}}{{ .Values.postgresql.auth.passwordKey }}{{- else -}}{{ .Values.externalDatabase.passwordKey }}{{- end -}}
{{- end -}}

{{- define "webflix.valkey.secretName" -}}
{{- if .Values.valkey.enabled -}}
{{- default (include "webflix.component" (list . "valkey")) .Values.valkey.auth.existingSecret -}}
{{- else -}}
{{- .Values.externalValkey.existingSecret -}}
{{- end -}}
{{- end -}}

{{- define "webflix.valkey.passwordKey" -}}
{{- if .Values.valkey.enabled -}}{{ .Values.valkey.auth.passwordKey }}{{- else -}}{{ .Values.externalValkey.passwordKey }}{{- end -}}
{{- end -}}

{{- define "webflix.objectStore.secretName" -}}
{{- default (include "webflix.component" (list . "objectstore")) .Values.objectStore.auth.existingSecret -}}
{{- end -}}

{{- define "webflix.mediaTokens.secretName" -}}
{{- default (include "webflix.component" (list . "media-tokens")) .Values.secrets.existingSecret -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- config --- */}}

{{- define "webflix.publicOrigin" -}}
{{- if .Values.config.publicOrigin -}}
{{- .Values.config.publicOrigin -}}
{{- else if .Values.httpRoute.hostnames -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.gateway.tls.enabled) (first .Values.httpRoute.hostnames) -}}
{{- else -}}
http://localhost:8080
{{- end -}}
{{- end -}}

{{- define "webflix.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- printf "postgres://%s@%s:5432/%s" .Values.postgresql.username (include "webflix.component" (list . "postgresql")) .Values.postgresql.database -}}
{{- else -}}
{{- required "externalDatabase.url is required when postgresql.enabled is false" .Values.externalDatabase.url -}}
{{- end -}}
{{- end -}}

{{- define "webflix.valkeyUrl" -}}
{{- if .Values.valkey.enabled -}}
{{- printf "redis://%s:6379/0" (include "webflix.component" (list . "valkey")) -}}
{{- else -}}
{{- required "externalValkey.url is required when valkey.enabled is false" .Values.externalValkey.url -}}
{{- end -}}
{{- end -}}

{{/*
Environment shared by every pod running the API image (serve, worker, migrate, seed, wait):
the ConfigMap, then secrets by reference (never inlined).
*/}}
{{- define "webflix.appEnv" -}}
envFrom:
  - configMapRef:
      name: {{ include "webflix.component" (list . "config") }}
env:
  - name: WEBFLIX_MEDIA_TOKEN_KEYS
    valueFrom:
      secretKeyRef:
        name: {{ include "webflix.mediaTokens.secretName" . }}
        key: WEBFLIX_MEDIA_TOKEN_KEYS
{{- $pgSecret := include "webflix.postgresql.secretName" . }}
{{- if $pgSecret }}
  # node-postgres reads PGPASSWORD when the URL carries no password.
  - name: PGPASSWORD
    valueFrom:
      secretKeyRef:
        name: {{ $pgSecret }}
        key: {{ include "webflix.postgresql.passwordKey" . }}
{{- end }}
{{- $valkeySecret := include "webflix.valkey.secretName" . }}
{{- if $valkeySecret }}
  - name: WEBFLIX_VALKEY_PASSWORD
    valueFrom:
      secretKeyRef:
        name: {{ $valkeySecret }}
        key: {{ include "webflix.valkey.passwordKey" . }}
{{- end }}
{{- if .Values.objectStore.enabled }}
  - name: WEBFLIX_S3_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: {{ include "webflix.objectStore.secretName" . }}
        key: access-key-id
  - name: WEBFLIX_S3_SECRET_ACCESS_KEY
    valueFrom:
      secretKeyRef:
        name: {{ include "webflix.objectStore.secretName" . }}
        key: secret-access-key
{{- else if .Values.externalS3.existingSecret }}
  - name: WEBFLIX_S3_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: {{ .Values.externalS3.existingSecret }}
        key: {{ .Values.externalS3.accessKeyIdKey }}
  - name: WEBFLIX_S3_SECRET_ACCESS_KEY
    valueFrom:
      secretKeyRef:
        name: {{ .Values.externalS3.existingSecret }}
        key: {{ .Values.externalS3.secretAccessKeyKey }}
{{- end }}
{{- if include "webflix.caBundle.enabled" . }}
  # Private CAs (managed PostgreSQL, Valkey over TLS, an internal S3 endpoint), trusted by
  # every TLS client in the process on top of the public roots.
  - name: NODE_EXTRA_CA_CERTS
    value: /etc/webflix/ca/{{ .Values.tls.extraCaCerts.key }}
{{- end }}
{{- end -}}

{{/* ------------------------------------------------------------------ TLS trust --- */}}

{{- define "webflix.caBundle.enabled" -}}
{{- if or .Values.tls.extraCaCerts.secretName .Values.tls.extraCaCerts.configMapName -}}true{{- end -}}
{{- end -}}

{{/* Volumes every pod running the API image needs: /tmp, and TLS material when configured. */}}
{{- define "webflix.appVolumes" -}}
- name: tmp
  emptyDir:
    sizeLimit: 64Mi
{{- $ca := .Values.tls.extraCaCerts }}
{{- if $ca.secretName }}
- name: ca-bundle
  secret:
    secretName: {{ $ca.secretName }}
    items:
      - key: {{ $ca.key }}
        path: {{ $ca.key }}
{{- else if $ca.configMapName }}
- name: ca-bundle
  configMap:
    name: {{ $ca.configMapName }}
    items:
      - key: {{ $ca.key }}
        path: {{ $ca.key }}
{{- end }}
{{- with .Values.externalDatabase.clientCertSecret }}
- name: database-client-cert
  secret:
    secretName: {{ . }}
    defaultMode: 0440
{{- end }}
{{- end -}}

{{- define "webflix.appVolumeMounts" -}}
- name: tmp
  mountPath: /tmp
{{- if include "webflix.caBundle.enabled" . }}
- name: ca-bundle
  mountPath: /etc/webflix/ca
  readOnly: true
{{- end }}
{{- if .Values.externalDatabase.clientCertSecret }}
# Mutual TLS: reference the files in the URL (sslcert=…/tls.crt&sslkey=…/tls.key).
- name: database-client-cert
  mountPath: /etc/webflix/tls/database
  readOnly: true
{{- end }}
{{- end -}}

{{/*
Pod annotation that changes whenever the secrets the processes read change (as seen in the
cluster), so a `helm upgrade` after rotating a key rolls the pods. Empty without cluster access.
*/}}
{{- define "webflix.secretsChecksum" -}}
{{- $data := dict -}}
{{- range $name := list (include "webflix.mediaTokens.secretName" .) (include "webflix.postgresql.secretName" .) (include "webflix.valkey.secretName" .) (ternary (include "webflix.objectStore.secretName" .) .Values.externalS3.existingSecret .Values.objectStore.enabled) -}}
{{- if $name -}}
{{- $secret := lookup "v1" "Secret" $.Release.Namespace $name -}}
{{- if $secret -}}{{- $_ := set $data $name ($secret.data | default dict) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- $data | toJson | sha256sum -}}
{{- end -}}

{{/* extraEnv maps (config.extraEnv + a component's own) as a list of env entries. */}}
{{- define "webflix.extraEnv" -}}
{{- range $name, $value := . }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- end -}}

{{/* The init container that blocks until the database (migrated), Valkey and optionally the bucket are usable. */}}
{{- define "webflix.waitContainer" -}}
{{- $ctx := index . 0 -}}
{{- $args := index . 1 -}}
- name: wait-for-dependencies
  image: {{ include "webflix.image" (list $ctx $ctx.Values.api.image) }}
  imagePullPolicy: {{ $ctx.Values.image.pullPolicy }}
  args: {{ $args | toJson }}
  {{- include "webflix.appEnv" $ctx | nindent 2 }}
  securityContext:
    {{- toYaml $ctx.Values.containerSecurityContext | nindent 4 }}
  resources:
    requests:
      cpu: 10m
      memory: 96Mi
    limits:
      cpu: 200m
      memory: 192Mi
  volumeMounts:
    {{- include "webflix.appVolumeMounts" $ctx | nindent 4 }}
{{- end -}}

{{/* Default topology spread: zones, then nodes, best effort. */}}
{{- define "webflix.topologySpread" -}}
{{- $ctx := index . 0 -}}
{{- $component := index . 1 -}}
{{- $custom := index . 2 -}}
{{- if $custom }}
{{- toYaml $custom }}
{{- else }}
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "webflix.selectorLabels" (list $ctx $component) | nindent 6 }}
  matchLabelKeys: [pod-template-hash]
- maxSkew: 1
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "webflix.selectorLabels" (list $ctx $component) | nindent 6 }}
  matchLabelKeys: [pod-template-hash]
{{- end }}
{{- end -}}

{{- define "webflix.metricsAnnotations" -}}
{{- if .Values.metrics.podAnnotations }}
prometheus.io/scrape: "true"
prometheus.io/port: "4001"
prometheus.io/path: /metrics
{{- end }}
{{- end -}}

{{/*
Pod securityContext of the processes that hold database connections (API, worker, Jobs): the
chart's podSecurityContext plus the TCP keepalive sysctls (tcpKeepalive).
*/}}
{{- define "webflix.appPodSecurityContext" -}}
{{- $context := deepCopy .Values.podSecurityContext -}}
{{- $sysctls := list -}}
{{- with .Values.tcpKeepalive -}}
{{- if .intervalSec -}}{{- $sysctls = append $sysctls (dict "name" "net.ipv4.tcp_keepalive_intvl" "value" (.intervalSec | int | toString)) -}}{{- end -}}
{{- if .probes -}}{{- $sysctls = append $sysctls (dict "name" "net.ipv4.tcp_keepalive_probes" "value" (.probes | int | toString)) -}}{{- end -}}
{{- end -}}
{{- if $sysctls -}}{{- $_ := set $context "sysctls" (concat ($context.sysctls | default list) $sysctls) -}}{{- end -}}
{{- toYaml $context -}}
{{- end -}}
