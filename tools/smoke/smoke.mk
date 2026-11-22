# Deployment conformance suite (tools/smoke). Included by the root Makefile.
#
#   make smoke                                   the dev API (http://localhost:4000)
#   make smoke TARGET=k8s | TARGET=cf            http://localhost:8080 | http://localhost:8787
#   make smoke BASE_URL=https://webflix.example  any deployment
#   make smoke SMOKE_ARGS="--only identity,consistency --json smoke.json"
#   make smoke-list                              the check catalogue
#   make smoke-m2 [BASE_URL=… | TARGET=…]        milestone 2's journeys only (sign-in, billing,
#                                                privacy, experiments, staff)
#
# Exit status: 0 when nothing failed (skips are listed, never counted as passes; add
# SMOKE_ARGS=--fail-on-skip to require full coverage), 1 on any failure, 2 if unreachable.

TARGET ?= dev
SMOKE_BASE_URL_dev := http://localhost:4000
SMOKE_BASE_URL_k8s := http://localhost:8080
SMOKE_BASE_URL_cf := http://localhost:8787
SMOKE_ARGS ?=
SMOKE := node tools/smoke/src/cli.ts
SMOKE_M2 := identity.oidc,identity.verify-email,identity.password-reset,billing,privacy,experiments,staff

.PHONY: smoke smoke-list smoke-m2

smoke: ## Conformance suite: make smoke [BASE_URL=url | TARGET=dev|k8s|cf] [SMOKE_ARGS="--only ... --json f"]
	$(SMOKE) --base-url "$(or $(BASE_URL),$(SMOKE_BASE_URL_$(TARGET)))" $(SMOKE_ARGS)

smoke-list: ## List the conformance checks (ids, tags, requirements)
	$(SMOKE) --list

smoke-m2: ## Milestone 2 journeys only (what they need from a deployment: tools/smoke/README.md)
	$(SMOKE) --base-url "$(or $(BASE_URL),$(SMOKE_BASE_URL_$(TARGET)))" --only "$(SMOKE_M2)" $(SMOKE_ARGS)
