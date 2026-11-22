# syntax=docker/dockerfile:1.7
# The recommendation pipeline's job image (CronJobs in the Kubernetes mode; any scheduler next
# to R2 in the Cloudflare mode). Build: make recs-image. Run: webflix-recs <command> ...
#
# Two stages on the same pinned base: the builder resolves the locked dependency tree with uv
# (wheels only) into /opt/venv; the runtime stage copies only that environment and runs as an
# unprivileged user. Node is not included: `evaluate` takes the rule engine's rankings with
# `--external rule-engine=<file>`, produced by scripts/rule-engine-rankings.ts in an image that
# has the repository's TypeScript packages (README.md, "Running as a job").

ARG PYTHON_IMAGE=python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.9@sha256:8b940d3a9d65bed080436972241af2e21c84b5e8c9193f7014ed71479ee795ff

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_CACHE=1
WORKDIR /src
# Dependencies first (cached while only the code changes), then the project itself, installed
# as a regular (non-editable) wheel so the JSON schemas travel inside the package.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project --python /usr/local/bin/python3.13
COPY src ./src
COPY schemas ./schemas
RUN uv sync --frozen --no-dev --no-editable --python /usr/local/bin/python3.13 \
    && rm -rf /opt/venv/lib/python3.13/site-packages/*/tests \
    && find /opt/venv -name '__pycache__' -path '*/tests/*' -prune -exec rm -rf {} +

FROM ${PYTHON_IMAGE} AS runtime
ARG GIT_COMMIT=unknown
ARG GIT_DIRTY=1
LABEL org.opencontainers.image.title="webflix-recs" \
      org.opencontainers.image.description="Webflix offline recommendation pipeline" \
      org.opencontainers.image.revision="${GIT_COMMIT}"
RUN groupadd --system --gid 10001 recs \
    && useradd --system --uid 10001 --gid recs --home-dir /work --shell /usr/sbin/nologin recs \
    && mkdir -p /work && chown recs:recs /work
COPY --from=build /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WEBFLIX_RECS_GIT_COMMIT=${GIT_COMMIT} \
    WEBFLIX_RECS_GIT_DIRTY=${GIT_DIRTY} \
    WEBFLIX_RECS_THREADS=4 \
    TMPDIR=/work
USER 10001:10001
WORKDIR /work
# A read-only root filesystem works: everything written goes to the blob store or to /work
# (mount an emptyDir there).
ENTRYPOINT ["webflix-recs"]
CMD ["--help"]
