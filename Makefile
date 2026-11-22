# Webflix: generic targets. Each area adds its own targets in a fragment it owns
# (blueprint §8), so nobody edits this file to add a command:
#
#   tools/media/media.mk       make content PROFILE=fast|full
#   deploy/kind/k8s.mk         make k8s-up / make k8s-down
#   apps/edge/cloudflare.mk    make cf-dev / make cf-deploy
#   e2e/e2e.mk                 make e2e TARGET=dev|k8s|cf
#   tools/smoke/smoke.mk       make smoke BASE_URL=http://localhost:8080
#   tools/stripe/stripe.mk     make stripe-sandbox (milestone 2, docs/BLUEPRINT-M2.md)
#   services/recs/recs.mk      make recs (milestone 2, docs/BLUEPRINT-M2.md)
#
# Fragments may extend `setup`, `clean` and `doctor` with double-colon rules
# (`setup:: content`), and document their targets with `## description` for `make help`.

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

PNPM ?= pnpm

.PHONY: help install dev typecheck lint lint-fix format test check

help: ## List available targets
	@grep -hE '^[a-zA-Z0-9_-]+:+.*## ' $(MAKEFILE_LIST) \
		| sort -u \
		| awk 'BEGIN { FS = ":+.*## " } { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }'

install: ## Install dependencies (pnpm workspace)
	$(PNPM) install

setup:: install ## One-time setup: dependencies and the Playwright browsers (Chromium, Firefox, WebKit)
	$(PNPM) --filter @webflix/e2e e2e:install

dev: ## Run the dev mode: API on :4000, web on :5173
	$(PNPM) dev

typecheck: ## Type-check every package
	$(PNPM) typecheck

lint: ## Lint and format-check (Biome)
	$(PNPM) lint

lint-fix: ## Apply safe lint fixes and formatting
	$(PNPM) lint:fix

format: ## Format every file
	$(PNPM) format

test: ## Run unit, contract and integration tests
	$(PNPM) test

check: lint typecheck test ## Lint, type-check and test (what CI runs)

clean:: ## Remove build output and tool caches (keeps node_modules and .cache media)
	rm -rf .turbo apps/*/.turbo packages/*/.turbo tools/*/.turbo e2e/.turbo \
		apps/*/dist packages/*/dist e2e/test-results e2e/playwright-report

doctor:: ## Check the host toolchain
	@node --version
	@$(PNPM) --version
	@docker --version

-include tools/media/media.mk
-include deploy/kind/k8s.mk
-include apps/edge/cloudflare.mk
-include e2e/e2e.mk
-include tools/smoke/smoke.mk
-include tools/stripe/stripe.mk
-include services/recs/recs.mk
