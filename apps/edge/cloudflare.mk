# Cloudflare mode (apps/edge). Included by the root Makefile. docs/CLOUDFLARE.md explains it all.
#
#   make cf-dev       fresh clone → the product on http://localhost:8787 (workerd + miniflare)
#   make cf-deploy    the same product on a real account (needs `wrangler login` or an API token)
#
# Every step is idempotent: re-running cf-dev takes seconds. Several local instances can run
# side by side; each has its own port, inspector port, state and staged assets:
#
#   make cf-dev CF_PORT=4620 CF_INSPECTOR_PORT=4621 CF_STATE=/tmp/cf-b/state CF_ASSETS=/tmp/cf-b/public
#
# Local state (D1, KV, R2, Durable Objects, Queues) lives in CF_STATE; `make cf-reset` wipes it.

CF_DIR := apps/edge
CF_WRANGLER := $(PNPM) --dir $(CF_DIR) exec wrangler
CF_OPS := node $(CF_DIR)/scripts/ops.ts
CF_DEPLOY := node $(CF_DIR)/scripts/deploy.ts
CF_DEV := node $(CF_DIR)/scripts/dev.ts
CF_PORT ?= 8787
CF_INSPECTOR_PORT ?= 4609
CF_STATE ?= $(CF_DIR)/.wrangler/state
CF_ASSETS ?= $(CF_DIR)/dist/public
CF_INSTANCE := --port $(CF_PORT) --state $(abspath $(CF_STATE))
# Media profile to upload (fast|full); empty = the first one `make content` packaged.
CF_MEDIA_PROFILE ?=
CF_PROFILE_FLAG := $(if $(CF_MEDIA_PROFILE),--profile $(CF_MEDIA_PROFILE),)
# Extra `wrangler dev` flags, e.g. CF_DEV_FLAGS='--var WEBFLIX_RATE_LIMIT_AUTH:100/60'
CF_DEV_FLAGS ?=
# Seed the demo account in production too (it is always seeded locally).
CF_DEMO ?=

cf_say = printf '\033[36m[cf]\033[0m %s\n' "$(1)"

.PHONY: cf-dev cf-prepare cf-install cf-secrets cf-web cf-assets cf-migrate cf-data cf-seed \
	cf-media cf-status cf-stop cf-reset cf-cron cf-test cf-check cf-bundle cf-startup \
	cf-provision cf-deploy cf-deploy-dry-run cf-tail

cf-dev: cf-prepare ## Cloudflare mode on http://localhost:8787: build, migrate, upload media, seed, serve
	@$(call cf_say,starting wrangler dev on http://localhost:$(CF_PORT) (Ctrl-C to stop; make cf-cron runs the Cron Trigger))
	@exec $(CF_DEV) start $(CF_INSTANCE) --inspector-port $(CF_INSPECTOR_PORT) \
		--assets $(abspath $(CF_ASSETS)) -- $(CF_DEV_FLAGS)

cf-prepare: cf-install cf-secrets cf-assets cf-migrate cf-data ## Everything cf-dev does before starting the server
	@$(call cf_say,local Cloudflare state ready)

cf-install:
	@if [ ! -f node_modules/.modules.yaml ] || [ ! -e $(CF_DIR)/node_modules/.bin/wrangler ]; then \
		$(call cf_say,installing dependencies); $(PNPM) install --frozen-lockfile; fi

# Local secret: a random media-token key per clone (git-ignored), read by wrangler dev.
cf-secrets:
	@if [ ! -f $(CF_DIR)/.dev.vars ]; then \
		printf 'WEBFLIX_MEDIA_TOKEN_KEYS=local:%s\n' "$$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" > $(CF_DIR)/.dev.vars; \
		$(call cf_say,wrote $(CF_DIR)/.dev.vars (local media-token key)); fi

# The SPA build is turbo-cached. A web build broken by work in progress does not block the
# Worker: the last successful build is served (with a warning).
cf-web:
	@$(call cf_say,building the web app)
	@if ! $(PNPM) turbo run build --filter=@webflix/web --output-logs=errors-only; then \
		if [ -f apps/web/dist/index.html ]; then \
			$(call cf_say,WARNING: web build failed; serving the previous build from apps/web/dist); \
		else exit 1; fi; fi

cf-assets: cf-web ## Stage the SPA, API docs bundle and _headers as Workers static assets
	@$(CF_OPS) assets --out $(abspath $(CF_ASSETS))

cf-migrate: ## Apply D1 migrations to the local database
	@$(call cf_say,applying D1 migrations (local))
	@out="$$($(CF_WRANGLER) d1 migrations apply DB --local --persist-to $(abspath $(CF_STATE)) 2>&1)" || { echo "$$out"; exit 1; }; \
	echo "$$out" | grep -E "✅|No migrations to apply" | sed 's/^/     /' || true

# Media upload (if packaged) + seed, in one bindings session. The dev server must be stopped.
cf-data:
	@$(CF_OPS) prepare $(CF_INSTANCE) $(CF_PROFILE_FLAG)

cf-seed: ## Seed D1 (catalog, search, stats; demo account locally, CF_DEMO=1 in production): FORCE=1, ENV=production
	@$(CF_OPS) seed --target $(or $(ENV),local) $(CF_INSTANCE) $(if $(FORCE),--force,) $(if $(CF_DEMO),--demo,)

cf-media: ## Upload packaged media to R2: CF_MEDIA_PROFILE=fast|full, ENV=production
	@$(CF_OPS) media --target $(or $(ENV),local) $(CF_INSTANCE) $(CF_PROFILE_FLAG)

cf-status: ## Show what the local (or ENV=production) Cloudflare state holds
	@$(CF_OPS) status --target $(or $(ENV),local) $(CF_INSTANCE)

cf-cron: ## Run the Cron Trigger (scheduled handler) on the running local Worker
	@curl -fsS "http://localhost:$(CF_PORT)/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*" && echo

# Stops only a process proven to be this repository's dev server (scripts/dev.ts): the
# recorded runner, or a wrangler process running in apps/edge. Anything else is left alone.
cf-stop: ## Stop this repository's local dev server on CF_PORT (never another program's)
	@$(CF_DEV) stop $(CF_INSTANCE)

cf-reset: cf-stop ## Delete the instance's local state (D1, KV, R2, Durable Objects, Queues)
	rm -rf $(abspath $(CF_STATE))

cf-test: ## Adapter contract suites and Worker tests, inside workerd
	$(PNPM) --filter @webflix/adapters-cloudflare --filter @webflix/edge test

cf-bundle: cf-web ## Build the production bundle without uploading; report its size (and zod's share)
	@$(CF_OPS) assets --target production
	@$(CF_DEPLOY) bundle

cf-startup: ## Profile the Worker's startup (writes apps/edge/dist/startup.cpuprofile)
	@$(CF_WRANGLER) check startup --args="--env production" --outfile dist/startup.cpuprofile

cf-provision: ## Find or create D1, KV, R2 and Queues on the account; write their ids
	@$(CF_DEPLOY) provision

cf-deploy-dry-run: cf-install cf-web ## Rehearse cf-deploy without an account: config, assets, bundle, plan
	@$(CF_DEPLOY) deploy --dry-run

cf-deploy: cf-install cf-web ## Deploy to Cloudflare: provision, migrate, media, seed, deploy, verify (CF_DEMO=1: demo account)
	@$(CF_DEPLOY) deploy $(if $(CF_DEMO),--with-demo,)

cf-tail: ## Stream production logs
	@$(CF_WRANGLER) tail --env production --format pretty

clean::
	rm -rf $(CF_DIR)/dist
