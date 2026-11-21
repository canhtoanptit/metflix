# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
#
# Webflix images, built from the repository root (the pnpm workspace):
#
#   docker buildx bake -f deploy/docker/docker-bake.hcl          # both, in parallel
#   docker build -f deploy/docker/Dockerfile --target api .      # API + worker + migrate + seed
#   docker build -f deploy/docker/Dockerfile --target web .      # the SPA behind nginx
#   docker build -f deploy/docker/Dockerfile --target media-tools .   # media uploader (kind)
#
# Every base is pinned by digest. Dependencies are installed from the lockfile in a layer
# keyed only by the package manifests, with a persistent pnpm store cache, so a code change
# rebuilds in seconds. Runtime images carry no package manager, no dev dependencies, no
# sources and no secrets, run as a non-root user and work with a read-only root filesystem.

# Build stages run on glibc: some dev tool binaries (workerd, rolldown, lightningcss) are glibc-first.
ARG BUILD_IMAGE=node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146
# The runtime takes the Node binary from the official Alpine image and nothing else from it.
ARG NODE_IMAGE=node:26.8.1-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3
ARG RUNTIME_IMAGE=alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
ARG PNPM_VERSION=10.5.2

# --- workspace: pnpm + every package manifest (the dependency graph, no sources) -------------
FROM ${BUILD_IMAGE} AS workspace
ARG PNPM_VERSION
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    DO_NOT_TRACK=1
RUN --mount=type=cache,id=webflix-npm,target=/root/.npm \
    npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY --parents apps/*/package.json packages/*/package.json tools/*/package.json e2e/package.json ./

# --- api ---------------------------------------------------------------------------------------
FROM workspace AS api-deps
# Lifecycle scripts are skipped: nothing the API build needs runs one, and it keeps unrelated
# tools (workerd, sharp) from executing at build time.
RUN --mount=type=cache,id=webflix-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
      --filter "@webflix/api..."

FROM api-deps AS api-build
COPY --parents apps/api packages ./
# One ESM bundle (+ source map, licences, the docs UI script): see apps/api/scripts/bundle.ts.
RUN pnpm --filter @webflix/api build \
 && cd apps/api/dist \
 && node main.mjs --help > /dev/null

FROM ${NODE_IMAGE} AS node

FROM ${RUNTIME_IMAGE} AS api
ARG VERSION=dev
LABEL org.opencontainers.image.title="webflix-api" \
      org.opencontainers.image.description="Webflix API, worker, migrate and seed (Node)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED"
# Node needs only libstdc++ and libgcc next to musl: copied from the same official image the
# binary comes from, so the pair always matches and no package index is consulted.
COPY --from=node /usr/lib/libstdc++.so.6 /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN addgroup -S -g 10001 webflix \
 && adduser -S -D -H -u 10001 -G webflix -s /sbin/nologin webflix \
 && node --version
WORKDIR /app
COPY --from=api-build --chown=0:0 --chmod=0444 \
     /src/apps/api/dist/main.mjs /src/apps/api/dist/main.mjs.map \
     /src/apps/api/dist/main.mjs.LEGAL.txt /src/apps/api/dist/scalar.js /app/
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    PORT=4000
USER 10001:10001
EXPOSE 4000
# Node is PID 1: every command handles SIGTERM itself (serve/worker drain, see main.ts).
ENTRYPOINT ["node", "/app/main.mjs"]
CMD ["serve"]

# --- web ---------------------------------------------------------------------------------------
FROM workspace AS web-deps
RUN --mount=type=cache,id=webflix-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
      --filter "@webflix/web..."

FROM web-deps AS web-build
COPY --parents apps/web packages ./
RUN pnpm --filter @webflix/web build \
 && test -f apps/web/dist/index.html \
 # Pre-compressed copies, served by nginx's gzip_static without spending CPU per request.
 && find apps/web/dist -type f -size +1k \
      \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
         -o -name '*.json' -o -name '*.webmanifest' -o -name '*.txt' -o -name '*.wasm' \) \
      -exec gzip -9 --keep --no-name {} +

FROM ${NGINX_IMAGE} AS web
ARG VERSION=dev
LABEL org.opencontainers.image.title="webflix-web" \
      org.opencontainers.image.description="Webflix single-page app (static, nginx)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="UNLICENSED"
COPY --chown=0:0 --chmod=0444 deploy/docker/web/nginx.conf /etc/nginx/nginx.conf
COPY --chown=0:0 --chmod=0444 deploy/docker/web/security-headers.conf /etc/nginx/security-headers.conf
# Source maps and Vite's build manifest stay out of the image: nothing public should need them.
COPY --from=web-build --chown=0:0 --exclude=**/*.map --exclude=.vite \
     /src/apps/web/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080 8081
STOPSIGNAL SIGQUIT
# The stock entrypoint rewrites config files at start; this image ships its final config and
# runs with a read-only root filesystem, so nginx starts directly.
ENTRYPOINT ["nginx", "-g", "daemon off;"]

# --- media-tools: the media pipeline's CLI, for uploading packaged media without host Node ----
# Not a runtime image: `make k8s-up` runs `upload` from it with .cache/media mounted.
FROM workspace AS media-tools
RUN --mount=type=cache,id=webflix-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store \
      --filter "@webflix/media..."
COPY --parents tools/media packages ./
ENTRYPOINT ["node", "/src/tools/media/src/cli.ts"]
