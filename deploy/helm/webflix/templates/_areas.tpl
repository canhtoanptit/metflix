{{/* ------------------------------------------- milestone 2: the areas' settings --- */}}

{{/* One `NAME: "value"` line, only when the value is set (not null, not ""). list name value */}}
{{- define "webflix.setting" -}}
{{- $value := index . 1 -}}
{{- if not (or (kindIs "invalid" $value) (eq (toString $value) "")) }}
{{- if or (kindIs "float64" $value) (kindIs "int64" $value) (kindIs "int" $value) }}
{{- if eq (float64 $value) (floor (float64 $value)) }}
{{- $value = int64 $value }}
{{- end }}
{{- end }}
{{ index . 0 }}: {{ $value | toString | quote }}
{{- end }}
{{- end -}}

{{- define "webflix.environment.production" -}}
{{- if eq .Values.config.environment "production" -}}true{{- end -}}
{{- end -}}

{{/* The payment provider in effect: the configured one, else the application's default. */}}
{{- define "webflix.paymentProvider" -}}
{{- .Values.config.billing.paymentProvider | default (ternary "none" "fake" (eq .Values.config.environment "production")) -}}
{{- end -}}

{{/* The URL Keycloak is reached at (browsers, API, jobs) and its realm's issuer. */}}
{{- define "webflix.keycloak.url" -}}
{{- .Values.keycloak.hostname | default (printf "https://%s:8443" (include "webflix.component" (list . "keycloak"))) | trimSuffix "/" -}}
{{- end -}}

{{- define "webflix.keycloak.issuer" -}}
{{- printf "%s/realms/%s" (include "webflix.keycloak.url" .) .Values.keycloak.realm -}}
{{- end -}}

{{/* The staff issuer the API validates tokens against (empty: the application's default). */}}
{{- define "webflix.staff.issuer" -}}
{{- if .Values.config.staff.issuer -}}
{{- .Values.config.staff.issuer -}}
{{- else if .Values.keycloak.enabled -}}
{{- include "webflix.keycloak.issuer" . -}}
{{- end -}}
{{- end -}}

{{/* The email sender in effect (empty: the application's default). */}}
{{- define "webflix.email.sender" -}}
{{- .Values.config.email.sender | default (ternary "smtp" "" .Values.mailcatcher.enabled) -}}
{{- end -}}

{{/* WEBFLIX_RELEASE: the configured release, else the API image's tag (or digest prefix). */}}
{{- define "webflix.release" -}}
{{- if .Values.config.events.release -}}
{{- .Values.config.events.release -}}
{{- else if .Values.api.image.digest -}}
{{- .Values.api.image.digest | trimPrefix "sha256:" | trunc 12 -}}
{{- else -}}
{{- regexReplaceAll "[^A-Za-z0-9._+-]" (default .Chart.AppVersion .Values.api.image.tag) "-" | trunc 40 -}}
{{- end -}}
{{- end -}}

{{- define "webflix.areaSettings" -}}
{{- $c := .Values.config -}}
{{- $production := eq $c.environment "production" -}}
{{- /* identity */}}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_PROVIDERS" $c.identity.oidcProviders) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_GOOGLE_CLIENT_ID" $c.identity.google.clientId) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_GOOGLE_ISSUER" $c.identity.google.issuer) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_APPLE_CLIENT_ID" $c.identity.apple.clientId) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_APPLE_TEAM_ID" $c.identity.apple.teamId) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_APPLE_KEY_ID" $c.identity.apple.keyId) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_APPLE_ISSUER" $c.identity.apple.issuer) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_KEYCLOAK_ISSUER" $c.identity.keycloak.issuer) }}
{{- include "webflix.setting" (list "WEBFLIX_OIDC_KEYCLOAK_CLIENT_ID" $c.identity.keycloak.clientId) }}
{{- /* email */}}
{{- $sender := include "webflix.email.sender" . }}
{{- include "webflix.setting" (list "WEBFLIX_EMAIL_SENDER" $sender) }}
{{- include "webflix.setting" (list "WEBFLIX_EMAIL_FROM" $c.email.from) }}
{{- if eq $sender "smtp" }}
{{- $catcher := and .Values.mailcatcher.enabled (not $c.email.smtp.host) }}
{{- include "webflix.setting" (list "WEBFLIX_SMTP_HOST" ($c.email.smtp.host | default (ternary (include "webflix.component" (list . "mailcatcher")) "" $catcher))) }}
{{- include "webflix.setting" (list "WEBFLIX_SMTP_PORT" ($c.email.smtp.port | default (ternary 1025 nil $catcher))) }}
{{- include "webflix.setting" (list "WEBFLIX_SMTP_TLS" ($c.email.smtp.tls | default (ternary "none" "" $catcher))) }}
{{- include "webflix.setting" (list "WEBFLIX_SMTP_USERNAME" $c.email.smtp.username) }}
{{- end }}
{{- include "webflix.setting" (list "WEBFLIX_EMAIL_HTTP_URL" $c.email.http.url) }}
{{- include "webflix.setting" (list "WEBFLIX_EMAIL_HTTP_PROVIDER" $c.email.http.provider) }}
{{- /* billing */}}
{{- include "webflix.setting" (list "WEBFLIX_PAYMENT_PROVIDER" $c.billing.paymentProvider) }}
{{- include "webflix.setting" (list "WEBFLIX_BILLING_GRACE_SEC" $c.billing.graceSec) }}
{{- include "webflix.setting" (list "WEBFLIX_PAYMENTS_FAKE_DELIVERY" $c.billing.fake.delivery) }}
{{- include "webflix.setting" (list "WEBFLIX_PAYMENTS_FAKE_PROMOTIONS" $c.billing.fake.promotions) }}
{{- include "webflix.setting" (list "WEBFLIX_PAYMENTS_FAKE_RETRIES_EXHAUSTED" $c.billing.fake.retriesExhausted) }}
{{- /* events */}}
{{- include "webflix.setting" (list "WEBFLIX_EVENT_SINK" $c.events.sink) }}
{{- include "webflix.setting" (list "WEBFLIX_CONSENT_MODE" $c.events.consentMode) }}
{{- include "webflix.setting" (list "WEBFLIX_EXPORT_EVENTS" $c.events.exportEvents) }}
{{- include "webflix.setting" (list "WEBFLIX_DELETION_COOLING_OFF_SEC" $c.events.deletionCoolingOffSec) }}
{{- include "webflix.setting" (list "WEBFLIX_EVENTS_RETENTION_DAYS" $c.events.retentionDays) }}
{{- include "webflix.setting" (list "WEBFLIX_AGGREGATES_RETENTION_DAYS" $c.events.aggregatesRetentionDays) }}
{{- include "webflix.setting" (list "WEBFLIX_EXPORT_LINK_TTL_SEC" $c.events.exportLinkTtlSec) }}
{{- include "webflix.setting" (list "WEBFLIX_RELEASE" (include "webflix.release" .)) }}
{{- /* personalisation */}}
{{- /* experiments */}}
{{- include "webflix.setting" (list "WEBFLIX_EXPERIMENTS_PROPAGATION_SEC" $c.experiments.propagationSec) }}
{{- include "webflix.setting" (list "WEBFLIX_RECOMMENDATION_STORE" $c.recommendations.store) }}
{{- include "webflix.setting" (list "WEBFLIX_RECS_DEFAULT_POLICY" $c.recommendations.defaultPolicy) }}
{{- include "webflix.setting" (list "WEBFLIX_RECS_EXPLORE_SHARE" $c.recommendations.exploreShare) }}
{{- /* admin: the staff issuer */}}
{{- $issuer := include "webflix.staff.issuer" . }}
{{- include "webflix.setting" (list "WEBFLIX_STAFF_VERIFIER" ($c.staff.verifier | default (ternary "oidc" "" (ne $issuer "")))) }}
{{- include "webflix.setting" (list "WEBFLIX_STAFF_ISSUER" $issuer) }}
{{- include "webflix.setting" (list "WEBFLIX_STAFF_ALGORITHMS" $c.staff.algorithms) }}
{{- end -}}

{{/* ------------------------------------------------------------- app secrets ------ */}}

{{- define "webflix.appSecret.name" -}}
{{- default (include "webflix.component" (list . "app")) .Values.secrets.appExistingSecret -}}
{{- end -}}

{{/* envFrom entries of every pod running the API image: the app Secret, then secrets.envFrom. */}}
{{- define "webflix.appSecretEnvFrom" -}}
- secretRef:
    name: {{ include "webflix.appSecret.name" . }}
{{- range .Values.secrets.envFrom }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end -}}

{{/* ----------------------------------------------------------- the web app's CSP --- */}}

{{/*
What Stripe.js needs from the page (docs.stripe.com/security/guide, "Stripe.js"; the same
sources as apps/edge/scripts/lib/security-headers.ts): its script, its frames (3-D Secure on
hooks.stripe.com) and its API. Added only when Stripe is the payment provider; a directive the
policy lacks starts from default-src, so nothing else becomes framable or scriptable.
*/}}
{{- define "webflix.web.stripeSources" -}}
script-src: [https://js.stripe.com, "https://*.js.stripe.com", https://maps.googleapis.com]
frame-src: [https://js.stripe.com, "https://*.js.stripe.com", https://hooks.stripe.com]
connect-src: [https://api.stripe.com, https://maps.googleapis.com]
{{- end -}}

{{/* The CSP: list ctx csp. Stripe's sources added per directive when Stripe is the provider. */}}
{{- define "webflix.web.csp" -}}
{{- $ctx := index . 0 -}}
{{- $csp := index . 1 | replace "\n" " " | trim -}}
{{- if ne (include "webflix.paymentProvider" $ctx) "stripe" -}}
{{- $csp -}}
{{- else -}}
{{- $added := include "webflix.web.stripeSources" $ctx | fromYaml -}}
{{- $names := list -}}
{{- $values := dict -}}
{{- range $part := splitList ";" $csp -}}
{{- $words := splitList " " (trim $part) | compact -}}
{{- if $words -}}
{{- $name := lower (first $words) -}}
{{- $names = append $names $name -}}
{{- $_ := set $values $name (rest $words) -}}
{{- end -}}
{{- end -}}
{{- $fallback := without (get $values "default-src" | default list) "'none'" -}}
{{- range $name := list "script-src" "frame-src" "connect-src" -}}
{{- if not (hasKey $values $name) -}}
{{- $names = append $names $name -}}
{{- $_ := set $values $name $fallback -}}
{{- end -}}
{{- $current := get $values $name -}}
{{- range $source := get $added $name -}}
{{- if not (has $source $current) -}}{{- $current = append $current $source -}}{{- end -}}
{{- end -}}
{{- $_ := set $values $name $current -}}
{{- end -}}
{{- $out := list -}}
{{- range $name := $names -}}
{{- $out = append $out (join " " (prepend (get $values $name) $name)) -}}
{{- end -}}
{{- join "; " $out -}}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------- Keycloak ------- */}}

{{- define "webflix.keycloak.secretName" -}}
{{- include "webflix.component" (list . "keycloak") -}}
{{- end -}}

{{- define "webflix.keycloak.tlsSecretName" -}}
{{- .Values.keycloak.tls.secretName | default (include "webflix.component" (list . "keycloak-tls")) -}}
{{- end -}}

{{/* The token endpoint of the in-chart realm. */}}
{{- define "webflix.keycloak.tokenUrl" -}}
{{- printf "%s/protocol/openid-connect/token" (include "webflix.keycloak.issuer" .) -}}
{{- end -}}

{{/* The five staff roles of webflix-admin (docs/BACKEND.md §3, "The staff API"). */}}
{{- define "webflix.staffRoles" -}}
{{- list "support" "billing" "content" "experiments" "admin" | toJson -}}
{{- end -}}

{{/* ---------------------------------------------------------------- pipeline -------- */}}

{{- define "webflix.pipeline.store" -}}
{{- .Values.pipeline.store | default (printf "s3://%s" (ternary .Values.objectStore.bucket .Values.externalS3.bucket .Values.objectStore.enabled)) -}}
{{- end -}}

{{- define "webflix.pipeline.adminUrl" -}}
{{- .Values.pipeline.staffApi.url | default (printf "http://%s/api/admin/v1" (include "webflix.component" (list . "api"))) -}}
{{- end -}}

{{/* The token endpoint of the jobs' service account (empty: none can be derived). */}}
{{- define "webflix.pipeline.tokenUrl" -}}
{{- if .Values.pipeline.staffApi.tokenUrl -}}
{{- .Values.pipeline.staffApi.tokenUrl -}}
{{- else if .Values.keycloak.enabled -}}
{{- include "webflix.keycloak.tokenUrl" . -}}
{{- else if ne .Values.config.environment "production" -}}
{{- printf "http://%s/dev-idp/staff/token" (include "webflix.component" (list . "api")) -}}
{{- end -}}
{{- end -}}

{{/* S3 credentials of the bucket (the same the API uses). */}}
{{- define "webflix.s3CredentialsEnv" -}}
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
{{- end -}}

{{/* Environment of the webflix-recs containers: the bucket and the staff API, nothing else secret. */}}
{{- define "webflix.pipeline.recsEnv" -}}
{{- $p := .Values.pipeline -}}
envFrom:
  - configMapRef:
      name: {{ include "webflix.component" (list . "config") }}
env:
  {{- include "webflix.s3CredentialsEnv" . | nindent 2 }}
  - name: WEBFLIX_RECS_STORE
    value: {{ include "webflix.pipeline.store" . | quote }}
  - name: WEBFLIX_RECS_THREADS
    value: {{ $p.threads | quote }}
  {{- with $p.workers }}
  # Worker processes of each job (--workers; the lake round passes it on). Unset: the
  # pipeline's own default from the container's CPU limit.
  - name: WEBFLIX_RECS_WORKERS
    value: {{ . | quote }}
  {{- end }}
  - name: WEBFLIX_ADMIN_API_URL
    value: {{ include "webflix.pipeline.adminUrl" . | quote }}
  {{- with include "webflix.pipeline.tokenUrl" . }}
  - name: WEBFLIX_STAFF_TOKEN_URL
    value: {{ . | quote }}
  {{- end }}
  - name: WEBFLIX_STAFF_CLIENT_ID
    value: {{ $p.staffApi.clientId | quote }}
  {{- if $p.staffApi.existingSecret }}
  - name: WEBFLIX_STAFF_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: {{ $p.staffApi.existingSecret }}
        key: client-secret
  {{- else if .Values.keycloak.enabled }}
  - name: WEBFLIX_STAFF_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: {{ include "webflix.keycloak.secretName" . }}
        key: jobs-client-secret
  {{- else if ne .Values.config.environment "production" }}
  # The development issuer's published service client (WEBFLIX_DEV_CLIENTS.staffJobs).
  - name: WEBFLIX_STAFF_CLIENT_SECRET
    value: dev-only-jobs-client-secret
  {{- end }}
  {{- if and .Values.keycloak.enabled (not .Values.keycloak.tls.secretName) (not (or .Values.tls.extraCaCerts.secretName .Values.tls.extraCaCerts.configMapName)) }}
  # Python's TLS (the token endpoint): the chart's Keycloak CA.
  - name: SSL_CERT_FILE
    value: /etc/webflix/ca/ca.crt
  {{- end }}
  {{- include "webflix.extraEnv" $p.extraEnv | nindent 2 }}
{{- end -}}

{{/* A webflix-recs container: dict "ctx" . "name" n "args" (list ...) or "command" (list ...). */}}
{{- define "webflix.pipeline.recsContainer" -}}
{{- $ctx := .ctx -}}
- name: {{ .name }}
  image: {{ include "webflix.image" (list $ctx $ctx.Values.pipeline.image) }}
  imagePullPolicy: {{ $ctx.Values.image.pullPolicy }}
  {{- with .command }}
  command: {{ . | toJson }}
  {{- end }}
  {{- with .args }}
  args: {{ . | toJson }}
  {{- end }}
  {{- include "webflix.pipeline.recsEnv" $ctx | nindent 2 }}
  {{- with .env }}
    {{- toYaml . | nindent 4 }}
  {{- end }}
  securityContext:
    {{- toYaml $ctx.Values.containerSecurityContext | nindent 4 }}
    runAsUser: 10001
    runAsGroup: 10001
  resources:
    {{- toYaml $ctx.Values.pipeline.resources | nindent 4 }}
  volumeMounts:
    - name: work
      mountPath: /work
    - name: scripts
      mountPath: /scripts
      readOnly: true
    {{- if include "webflix.caBundle.enabled" $ctx }}
    - name: ca-bundle
      mountPath: /etc/webflix/ca
      readOnly: true
    {{- end }}
{{- end -}}

{{/* A container of the Node tools image (the repository's packages), with the API's environment. */}}
{{- define "webflix.pipeline.toolsContainer" -}}
{{- $ctx := .ctx -}}
- name: {{ .name }}
  image: {{ include "webflix.image" (list $ctx $ctx.Values.pipeline.tools.image) }}
  imagePullPolicy: {{ $ctx.Values.image.pullPolicy }}
  command: {{ .command | toJson }}
  workingDir: /src
  {{- include "webflix.appEnv" $ctx | nindent 2 }}
  securityContext:
    {{- toYaml $ctx.Values.containerSecurityContext | nindent 4 }}
    runAsUser: 10001
    runAsGroup: 10001
  resources:
    {{- toYaml $ctx.Values.pipeline.resources | nindent 4 }}
  volumeMounts:
    - name: work
      mountPath: /work
    {{- include "webflix.appVolumeMounts" $ctx | nindent 4 }}
{{- end -}}

{{/* The CronJob around a pod: dict "ctx" . "job" key "schedule" s "pod" (pod spec YAML string). */}}
{{- define "webflix.pipeline.cronJob" -}}
{{- $ctx := .ctx -}}
{{- $p := $ctx.Values.pipeline -}}
apiVersion: batch/v1
kind: CronJob
metadata:
  name: {{ include "webflix.component" (list $ctx (printf "recs-%s" .job)) }}
  labels:
    {{- include "webflix.labels" (list $ctx "pipeline") | nindent 4 }}
    webflix.dev/job: {{ .job }}
spec:
  schedule: {{ .schedule | quote }}
  timeZone: Etc/UTC
  concurrencyPolicy: {{ $p.concurrencyPolicy }}
  successfulJobsHistoryLimit: {{ $p.successfulJobsHistoryLimit }}
  failedJobsHistoryLimit: {{ $p.failedJobsHistoryLimit }}
  startingDeadlineSeconds: 300
  jobTemplate:
    metadata:
      labels:
        {{- include "webflix.labels" (list $ctx "pipeline") | nindent 8 }}
        webflix.dev/job: {{ .job }}
    spec:
      backoffLimit: {{ $p.backoffLimit }}
      activeDeadlineSeconds: {{ $p.activeDeadlineSeconds }}
      ttlSecondsAfterFinished: {{ $p.ttlSecondsAfterFinished }}
      template:
        metadata:
          labels:
            {{- include "webflix.labels" (list $ctx "pipeline") | nindent 12 }}
            webflix.dev/job: {{ .job }}
        spec:
          restartPolicy: Never
          serviceAccountName: {{ include "webflix.serviceAccountName" $ctx }}
          automountServiceAccountToken: false
          {{- include "webflix.imagePullSecrets" $ctx | nindent 10 }}
          securityContext:
            {{- toYaml $ctx.Values.podSecurityContext | nindent 12 }}
          {{- .pod | nindent 10 }}
          volumes:
            - name: work
              emptyDir:
                sizeLimit: 2Gi
            - name: scripts
              configMap:
                name: {{ include "webflix.component" (list $ctx "pipeline") }}
            {{- include "webflix.appVolumes" $ctx | nindent 12 }}
{{- end -}}
