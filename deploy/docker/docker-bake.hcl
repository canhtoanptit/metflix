# Builds both images in one BuildKit session (shared workspace stage and pnpm store):
#   docker buildx bake -f deploy/docker/docker-bake.hcl --load
# Tags: webflix-api:$TAG and webflix-web:$TAG (TAG defaults to "dev"). The kind workflow then
# tags each image with its own ID, so an unchanged image never triggers a rollout.

variable "TAG" {
  default = "dev"
}

variable "REGISTRY" {
  # e.g. "ghcr.io/acme/" for a real registry; empty for local images.
  default = ""
}

group "default" {
  targets = ["api", "web"]
}

target "_common" {
  context    = "."
  dockerfile = "deploy/docker/Dockerfile"
  args = {
    VERSION = "${TAG}"
    # Fixed timestamps and no provenance attestation (which embeds a build id): an unchanged
    # tree rebuilds to the same image ID, so the kind workflow can tag images by content.
    SOURCE_DATE_EPOCH = "0"
  }
  attest = ["type=provenance,disabled=true"]
}

target "api" {
  inherits = ["_common"]
  target   = "api"
  tags     = ["${REGISTRY}webflix-api:${TAG}"]
}

target "web" {
  inherits = ["_common"]
  target   = "web"
  tags     = ["${REGISTRY}webflix-web:${TAG}"]
}

# The media uploader used by `make k8s-up` (not deployed).
target "media-tools" {
  inherits = ["_common"]
  target   = "media-tools"
  tags     = ["webflix-media-tools:${TAG}"]
}

# The pipeline's Node steps and the product's importers, run by the CronJobs (pipeline.enabled).
target "tools" {
  inherits = ["_common"]
  target   = "tools"
  tags     = ["${REGISTRY}webflix-tools:${TAG}"]
}

# The recommendation pipeline's job image (services/recs/Dockerfile, the pipeline's own; `make
# recs-image` builds the same with `docker build`). Built here with fixed timestamps and no
# provenance, like the others, so an unchanged tree keeps its image ID and nothing rolls.
variable "GIT_COMMIT" {
  default = "unknown"
}

variable "GIT_DIRTY" {
  default = "1"
}

target "recs" {
  context    = "services/recs"
  dockerfile = "Dockerfile"
  tags       = ["webflix-recs:${TAG}"]
  args = {
    GIT_COMMIT        = "${GIT_COMMIT}"
    GIT_DIRTY         = "${GIT_DIRTY}"
    SOURCE_DATE_EPOCH = "0"
  }
  attest = ["type=provenance,disabled=true"]
}
