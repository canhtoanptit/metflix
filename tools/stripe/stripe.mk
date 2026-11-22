# Stripe sandbox tooling (tools/stripe, docs/STRIPE.md). Included by the root Makefile.
#
#   make stripe-sandbox                 create or reuse the sandbox (idempotent, never prints a key)
#   make stripe-status                  sandbox, expiry, listeners, isolation checks
#   make stripe-listen [MODE=dev|k8s|cf | FORWARD_TO=url] [NAME=…] [EVENTS=a,b] [LATEST=1]
#   make stripe-listen-stop [NAME=… | ALL=1]
#   make stripe-listen-logs [NAME=…]    redacted tail of a sidecar log
#   make stripe-proof [PROOF_ARGS="--only trial,refunds"]   the proof run; regenerates fixtures
#   make stripe-reset                   forget the local credentials (nothing is deleted on Stripe)
#   make stripe-claim                   owner only: open Stripe's claim page for this sandbox
#   make stripe-use-key [FROM=file]     use your own test keys (a claimed sandbox's full key can
#                                       create test clocks; the anonymous sandbox key cannot)
#
# The CLI is the pinned @stripe/cli dev dependency of tools/stripe and runs with a
# repository-local profile under .cache/stripe (never ~/.config/stripe). Credentials end up in
# .cache/stripe/sandbox.json and .cache/stripe/stripe.env (0600, git-ignored).
#
# STRIPE_SANDBOX_EMAIL (default webflix-sandbox@example.com) prefills the claim form;
# STRIPE_SANDBOX_MIN_HOURS (default 24) replaces a sandbox that expires sooner than that.

STRIPE_TOOL := node tools/stripe/src/cli.ts
# The proof imports stripe-node's Workers build (`worker` export condition): fetch and Web Crypto.
STRIPE_PROOF := node --conditions=worker tools/stripe/proof/run.ts

MODE ?= dev
STRIPE_FORWARD_dev := http://localhost:4000/api/v1/webhooks/payments/stripe
STRIPE_FORWARD_k8s := http://localhost:8080/api/v1/webhooks/payments/stripe
STRIPE_FORWARD_cf := http://localhost:8787/api/v1/webhooks/payments/stripe
NAME ?= $(MODE)
EVENTS ?=
PROOF_ARGS ?=

.PHONY: stripe-sandbox stripe-status stripe-listen stripe-listen-stop stripe-listen-logs stripe-proof stripe-reset stripe-claim stripe-use-key

stripe-sandbox: ## Create or reuse the Stripe sandbox (idempotent; keys go to .cache/stripe, never printed)
	@$(STRIPE_TOOL) sandbox

stripe-status: ## Stripe sandbox, expiry, listeners and isolation checks
	@$(STRIPE_TOOL) status

stripe-listen: ## Managed `stripe listen` sidecar: [MODE=dev|k8s|cf | FORWARD_TO=url] [NAME=] [EVENTS=a,b] [LATEST=1]
	@$(STRIPE_TOOL) listen --name "$(NAME)" --forward-to "$(or $(FORWARD_TO),$(STRIPE_FORWARD_$(MODE)))" \
		$(if $(EVENTS),--events "$(EVENTS)") $(if $(LATEST),--latest)

stripe-listen-stop: ## Stop a `stripe listen` sidecar by PID: [NAME=] or ALL=1
	@$(STRIPE_TOOL) listen-stop $(if $(ALL),--all,--name "$(NAME)")

stripe-listen-logs: ## Redacted tail of a `stripe listen` sidecar log: [NAME=]
	@$(STRIPE_TOOL) listen-logs --name "$(NAME)"

stripe-proof: ## Prove the billing design against the sandbox and regenerate tools/stripe/fixtures
	@$(STRIPE_PROOF) $(PROOF_ARGS)

stripe-reset: ## Forget the local Stripe sandbox credentials (says what remains on Stripe's side)
	@$(STRIPE_TOOL) reset

stripe-claim: ## Owner only: open Stripe's claim page for the sandbox (needs a Stripe account)
	@$(STRIPE_TOOL) claim

stripe-use-key: ## Use your own test keys (hidden prompt, or FROM=file with STRIPE_SECRET_KEY=/STRIPE_PUBLISHABLE_KEY=)
	@$(STRIPE_TOOL) use-key $(if $(FROM),--from "$(FROM)")
