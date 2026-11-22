# Kubernetes mode on a local kind cluster (deploy/). Included by the root Makefile.
#
#   make k8s-up        cluster + Envoy Gateway + images + Helm release + media → http://localhost:8080
#   make k8s-redeploy  rebuild images and roll only what changed (the fast path after a code change)
#   make k8s-down      delete the cluster and its kubeconfig (images and build cache are kept)
#   make smoke TARGET=k8s   the conformance suite against it (tools/smoke/smoke.mk)
#
# Everything uses the repository kubeconfig (.cache/kube/config) and the context kind-webflix
# explicitly: no target reads or changes ~/.kube/config, and no other cluster is ever touched.

K8S_CLUSTER ?= webflix
K8S_NAMESPACE ?= webflix
K8S_RELEASE ?= webflix
K8S_CONTEXT := kind-$(K8S_CLUSTER)
# Webflix's own kubeconfig (repo cache, mode 600); ~/.kube/config is never read or written.
K8S_KUBECONFIG := $(CURDIR)/.cache/kube/config
K8S_KUBECTL := kubectl --kubeconfig $(K8S_KUBECONFIG) --context $(K8S_CONTEXT) -n $(K8S_NAMESPACE)
K8S_HELM := helm --kubeconfig $(K8S_KUBECONFIG) --kube-context $(K8S_CONTEXT) -n $(K8S_NAMESPACE)
C ?= api

# Exported to every recipe of the Makefile (dev mode and the Worker's included), so none of
# these may share a name with a product setting: the Helm release name is WEBFLIX_HELM_RELEASE,
# never WEBFLIX_RELEASE (the release stamped on server events, docs/BACKEND.md §4).
export WEBFLIX_KIND_CLUSTER := $(K8S_CLUSTER)
export WEBFLIX_NAMESPACE := $(K8S_NAMESPACE)
export WEBFLIX_HELM_RELEASE := $(K8S_RELEASE)
export WEBFLIX_KUBECONFIG := $(K8S_KUBECONFIG)
# Targets that take a node away or need zones refuse to run on the one-node cluster.
K8S_REQUIRE_NODES = bash -c '. deploy/kind/lib.sh && require_nodes $$0 "$$1"'

.PHONY: k8s-up k8s-down k8s-clean k8s-redeploy k8s-media k8s-status k8s-logs k8s-restart \
	k8s-test k8s-lint k8s-psql k8s-valkey-cli k8s-images k8s-kubeconfig k8s-verify k8s-chaos \
	k8s-rotate-media-key k8s-outage k8s-partition k8s-spread k8s-test-web k8s-test-pg-tls \
	k8s-ownership k8s-test-drift k8s-pipeline-smoke k8s-test-keycloak k8s-test-smtp

k8s-up: ## Kubernetes mode on kind: everything from nothing to http://localhost:8080 (re-runnable; NODES=1|3, VARIANT=conformance, RATE_LIMITS=relaxed)
	@deploy/kind/up.sh

k8s-redeploy: ## Fast path after a code change: rebuild images, roll out only what changed (no media step)
	@SKIP_MEDIA=1 deploy/kind/up.sh

k8s-down: ## Delete the kind cluster (its node containers and volumes) and its kubeconfig; images stay for a fast k8s-up
	@case "$(K8S_CLUSTER)" in webflix*) ;; *) echo "Refusing: $(K8S_CLUSTER) is not a webflix* cluster"; exit 1;; esac
	@if kind get clusters 2>/dev/null | grep -qx "$(K8S_CLUSTER)"; then \
		kind delete cluster --name "$(K8S_CLUSTER)" --kubeconfig "$(K8S_KUBECONFIG)"; \
	else echo "No kind cluster named $(K8S_CLUSTER)."; fi
	@rm -f "$(K8S_KUBECONFIG)"

k8s-clean: k8s-down ## k8s-down, then remove the webflix-api/web/tools/recs/media-tools images it built (base images and BuildKit cache stay)
	@ids="$$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^webflix-(api|web|tools|recs|media-tools):' || true)"; \
		if [ -n "$$ids" ]; then docker image rm $$ids >/dev/null && echo "Removed: $$(echo $$ids | wc -w | tr -d ' ') webflix images"; \
		else echo "No webflix images."; fi

k8s-kubeconfig: ## Print the path of the cluster kubeconfig (for kubectl, k9s: see docs/KUBERNETES.md)
	@echo "$(K8S_KUBECONFIG)"

k8s-media: ## Upload packaged media (.cache/media) and re-seed if it changed: MEDIA_PROFILE=fast|full
	@SKIP_BUILD=$${SKIP_BUILD:-1} deploy/kind/up.sh

k8s-images: ## Build the API and web images only (docker buildx bake)
	docker buildx bake -f deploy/docker/docker-bake.hcl --load api web

k8s-status: ## Release, pods, routes, autoscalers and recent jobs of the kind deployment
	@$(K8S_HELM) status $(K8S_RELEASE) 2>/dev/null | sed -n '1,6p' || echo "No release $(K8S_RELEASE) in $(K8S_CONTEXT)."
	@echo
	@$(K8S_KUBECTL) get pods -o wide 2>/dev/null || true
	@echo
	@$(K8S_KUBECTL) get gateway,httproute,svc,hpa,pdb 2>/dev/null || true
	@echo
	@$(K8S_KUBECTL) get jobs --sort-by=.metadata.creationTimestamp 2>/dev/null | tail -n 4 || true

k8s-logs: ## Follow logs of a component: C=api|worker|web|migrate|seed|postgresql|valkey|objectstore
	$(K8S_KUBECTL) logs -f --prefix --all-containers --max-log-requests 12 --tail 50 \
		-l app.kubernetes.io/component=$(C)

k8s-restart: ## Rolling restart of a component (zero downtime): C=api|worker|web
	$(K8S_KUBECTL) rollout restart deployment/$(K8S_RELEASE)-$(C)
	$(K8S_KUBECTL) rollout status deployment/$(K8S_RELEASE)-$(C) --timeout 5m

k8s-rotate-media-key: ## Rotate the media token key without breaking playback: STEP=add, then promote, then retire (after the token lifetime)
	@deploy/kind/rotate-media-key.sh $(STEP)

k8s-psql: ## psql shell in the in-cluster PostgreSQL
	$(K8S_KUBECTL) exec -it statefulset/$(K8S_RELEASE)-postgresql -- psql -U webflix -d webflix

k8s-valkey-cli: ## valkey-cli shell in the in-cluster Valkey
	$(K8S_KUBECTL) exec -it statefulset/$(K8S_RELEASE)-valkey -- valkey-cli

k8s-lint: ## Lint the chart and validate rendered manifests (Kubernetes + Gateway API schemas)
	@deploy/kind/chart-check.sh lint

k8s-test-web: ## Build the web image and test its nginx rules in a container (caching, misses, fallback)
	docker buildx bake -f deploy/docker/docker-bake.hcl --load web
	deploy/docker/web/test.sh webflix-web:dev

k8s-test-pg-tls: ## Build the API image and connect it to a TLS-only PostgreSQL with a private CA (tls.extraCaCerts)
	docker buildx bake -f deploy/docker/docker-bake.hcl --load api
	deploy/kind/verify/pg-tls.sh webflix-api:dev

k8s-test:## Chart unit tests (helm-unittest), lint and schema validation, in containers
	@deploy/kind/chart-check.sh all

k8s-pipeline-smoke: ## The recommendation pipeline at smoke size as a Job against the bucket (sim/ prefix), then the importers
	@deploy/kind/pipeline-smoke.sh

k8s-test-keycloak: ## Staff sign-in through the in-chart Keycloak with real tokens, roles enforced (production configuration)
	@deploy/kind/verify/staff-keycloak.sh

k8s-test-smtp: ## Email through SMTP to the in-chart mail catcher (production configuration)
	@deploy/kind/verify/smtp.sh

k8s-verify: ## Multi-replica journey, job pipeline and zero-downtime rollout checks (needs Node)
	node deploy/kind/verify/journey.ts
	node deploy/kind/verify/jobs.ts
	node deploy/kind/verify/rollout.ts api,web 16

k8s-outage: ## A long dependency outage (pod deleted, its node cordoned): TARGET=valkey|postgresql OUTAGE_SEC=45 (3-node cluster; needs Node)
	@$(K8S_REQUIRE_NODES) 3 "k8s-outage (a node cordoned while the store is away)"
	node deploy/kind/verify/outage.ts $(or $(TARGET),valkey) $(or $(OUTAGE_SEC),45)

k8s-partition: ## PostgreSQL partitioned without a goodbye: MODE=heal|lost SEC=… (3-node cluster; needs Node)
	@$(K8S_REQUIRE_NODES) 3 "k8s-partition (packets dropped on the database's node)"
	node deploy/kind/verify/partition.ts $(or $(MODE),heal) $(SEC)

k8s-spread: ## Replicas spread across zones and nodes (3-node cluster)
	@$(K8S_REQUIRE_NODES) 3 "k8s-spread (two zones)"
	@for c in api web; do \
		zones="$$($(K8S_KUBECTL) get pods -l app.kubernetes.io/component=$$c -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' \
			| while read -r node; do $(K8S_KUBECTL) get node "$$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}'; done | sort | uniq -c | awk '{ printf " %s %s", $$2, $$1 }')"; \
		echo "$$c pods per zone:$$zones"; \
		[ "$$(printf '%s\n' "$$zones" | grep -o zone- | wc -l)" -ge 2 ] || { echo "$$c is not spread over two zones"; exit 1; }; \
	done

k8s-ownership: ## Fields of release objects owned by a manager other than Helm, and whether that is expected (needs Node)
	node deploy/kind/verify/ownership.ts

k8s-test-drift: ## Hot-patch a release object, then redeploy in every K8S_OWNERSHIP mode (needs Node; reuses built images)
	node deploy/kind/verify/drift.ts

k8s-chaos: ## Failure injection: TARGET=valkey|postgresql MODE=delete|crash (needs Node)
	node deploy/kind/verify/chaos.ts $(or $(TARGET),valkey) $(or $(MODE),delete)

doctor::
	@kind version 2>/dev/null || echo "kind: not installed (needed for make k8s-up)"
	@bash -c '. deploy/kind/lib.sh && helm_doctor'
	@kubectl version --client 2>/dev/null | head -n 1 || echo "kubectl: not installed (needed for make k8s-up)"
