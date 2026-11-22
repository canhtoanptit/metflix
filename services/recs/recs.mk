# Recommendation pipeline (services/recs; docs/RECOMMENDATIONS-ML.md). Included by the root
# Makefile. Python is managed by uv inside services/recs/.venv; uv's cache stays in
# .cache/recs/uv, so nothing is installed system-wide.
#
#   make recs-setup                      Python environment (pinned, from uv.lock)
#   make recs-test                       ruff, mypy, pytest, TypeScript check of the Node scripts
#   make recs-simulate PRESET=smoke      catalogue export + simulation only
#   make recs [PRESET=full]              the full local run from an empty directory
#   make recs-image                      the job image (webflix-recs:dev)

RECS_DIR := services/recs
RECS_VENV := $(RECS_DIR)/.venv
RECS_UV := UV_CACHE_DIR=$(CURDIR)/.cache/recs/uv uv
RECS_BIN := $(RECS_VENV)/bin
PRESET ?= full
RECS_ROOT := .cache/recs/$(PRESET)

.PHONY: recs-setup recs-test recs-simulate recs recs-clean recs-image

recs-setup: ## Recommendation pipeline: create services/recs/.venv from uv.lock (Python 3.13, pinned)
	@cd $(RECS_DIR) && $(RECS_UV) sync --frozen
	@echo "recs-setup: $$($(RECS_BIN)/python --version) with $$($(RECS_BIN)/python -c 'import numpy, polars, sklearn; print(f"numpy {numpy.__version__}, polars {polars.__version__}, scikit-learn {sklearn.__version__}")') in $(RECS_VENV)"

recs-test: recs-setup ## Recommendation pipeline: ruff, mypy --strict, pytest (unit + end to end), tsc on the Node scripts
	@cd $(RECS_DIR) && .venv/bin/ruff format --check src tests && .venv/bin/ruff check src tests
	@echo "recs-test: ruff format and lint clean"
	@cd $(RECS_DIR) && .venv/bin/mypy
	@echo "recs-test: mypy --strict clean"
	@node_modules/.bin/tsc -p $(RECS_DIR)/scripts
	@echo "recs-test: TypeScript scripts typecheck"
	@cd $(RECS_DIR) && .venv/bin/pytest
	@echo "recs-test: pytest passed (unit tests and the end-to-end pipeline at smoke size)"

recs-simulate: recs-setup ## Recommendation pipeline: export the catalogue and simulate PRESET=smoke|medium|full into .cache/recs/PRESET
	@rm -rf $(RECS_ROOT) && mkdir -p $(RECS_ROOT)
	@days=$$($(RECS_BIN)/python -c "from webflix_recs.simulate.config import preset; print(preset('$(PRESET)').days)"); \
	end=$$($(RECS_BIN)/python -c "from webflix_recs.ids import iso_ms; print(iso_ms(1788220800000 + $$days * 86400000))"); \
	node $(RECS_DIR)/scripts/export-catalog.ts --store $(RECS_ROOT)/store --anchor $$end && \
	$(RECS_BIN)/webflix-recs --store $(RECS_ROOT)/store simulate --preset $(PRESET) --start 2026-09-01T00:00:00.000Z \
		--truth $(RECS_ROOT)/truth --experiment recs-aa --experiment recs-ranking:effect=0.10
	@echo "recs-simulate: lake in $(RECS_ROOT)/store (events/), ground truth in $(RECS_ROOT)/truth"

recs: recs-setup ## Recommendation pipeline: full local run (simulate, compact, dataset, train, evaluate, score, publish, experiments), PRESET=full|medium|smoke
	@bash $(RECS_DIR)/scripts/run-local.sh $(PRESET)

recs-clean: ## Recommendation pipeline: delete simulated data and runs under .cache/recs (keeps the uv cache)
	@rm -rf .cache/recs/smoke .cache/recs/medium .cache/recs/full .cache/recs/work
	@echo "recs-clean: removed .cache/recs/{smoke,medium,full,work}"

recs-image: ## Recommendation pipeline: build the job image webflix-recs:dev
	@docker build -t webflix-recs:dev \
		--build-arg GIT_COMMIT=$$(git rev-parse HEAD) \
		--build-arg GIT_DIRTY=$$(test -z "$$(git status --porcelain -- $(RECS_DIR))" && echo 0 || echo 1) \
		-f $(RECS_DIR)/Dockerfile $(RECS_DIR)
	@echo "recs-image: built webflix-recs:dev ($$(docker image inspect webflix-recs:dev --format '{{.Size}}' | awk '{printf "%.0f MB", $$1/1e6}'))"
