# End-to-end and visual review targets (owned by e2e/). Included by the root Makefile.

E2E_MOCK_PORT ?= 4210
TARGET ?= dev
ROUTES ?= /dev/reference /browse
WIDTHS ?= 390,834,1440
SESSION ?= profile

# Every target that starts browsers runs under the host guard: it will not start on a host that is
# already short of memory, and stops the run (exit 99) when swap, load or kernel graphics surfaces
# stay over their limits (e2e/README.md "Host guard"; HOST_GUARD=off runs unguarded).
E2E_HOST_GUARD := e2e/scripts/host-guard.sh

E2E_BASE_URL_dev := http://localhost:5173
E2E_BASE_URL_k8s := http://localhost:8080
E2E_BASE_URL_cf := http://localhost:8787
# Where the conformance suite points in `verify`: dev serves its API on its own origin.
E2E_SMOKE_URL_dev := http://localhost:4000
E2E_SMOKE_URL_k8s := http://localhost:8080
E2E_SMOKE_URL_cf := http://localhost:8787

.PHONY: e2e e2e-throttled verify e2e-mock screenshots web-mock

e2e: ## Playwright against a running mode: make e2e TARGET=dev|k8s|cf (or BASE_URL=...); E2E_BROWSERS=chromium
	BASE_URL=$${BASE_URL:-$(E2E_BASE_URL_$(TARGET))} $(E2E_HOST_GUARD) $(PNPM) --filter @webflix/e2e e2e

e2e-throttled: ## The Chromium suite with the CPU slowed 4x (E2E_CPU_THROTTLE): the timing gate
	BASE_URL=$${BASE_URL:-$(E2E_BASE_URL_$(TARGET))} E2E_CPU_THROTTLE=$${E2E_CPU_THROTTLE:-4} \
		E2E_BROWSERS=chromium $(E2E_HOST_GUARD) $(PNPM) --filter @webflix/e2e e2e

# The origins `verify` uses: what you passed (command line or environment), else the target's
# defaults. Resolved here by make: in one shell command bash expands a later prefix assignment
# with an earlier one, so `BASE_URL=x SMOKE_BASE_URL=$${BASE_URL:-…}` would always see x.
VERIFY_E2E_URL = $(or $(BASE_URL),$(E2E_BASE_URL_$(TARGET)))
VERIFY_SMOKE_URL = $(or $(SMOKE_BASE_URL),$(BASE_URL),$(E2E_SMOKE_URL_$(TARGET)))

verify: ## Browser suite, then the conformance suite (in that order), one summary: make verify TARGET=dev|k8s|cf (or BASE_URL= [SMOKE_BASE_URL=]); VERIFY_DRY_RUN=1 prints the URLs
	BASE_URL="$(VERIFY_E2E_URL)" SMOKE_BASE_URL="$(VERIFY_SMOKE_URL)" $(E2E_HOST_GUARD) node e2e/scripts/verify.ts

e2e-mock: ## UI suites (guards, overlay, slider, axe) against the web app in mock mode on E2E_MOCK_PORT
	E2E_MOCK_PORT=$(E2E_MOCK_PORT) $(E2E_HOST_GUARD) $(PNPM) --filter @webflix/e2e e2e:mock

screenshots: ## Full-page captures: make screenshots ROUTES="/browse /profiles" WIDTHS=390,834,1440 SESSION=profile|account|anonymous
	E2E_MOCK_PORT=$(E2E_MOCK_PORT) $(E2E_HOST_GUARD) $(PNPM) --filter @webflix/e2e shot -- --widths $(WIDTHS) --session $(SESSION) $(ROUTES)

web-mock: ## Web app with no backend (mock API + generated artwork) on WEB_PORT (default 5173)
	$(PNPM) --filter @webflix/web dev:mock
