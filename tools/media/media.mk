# Media pipeline targets (tools/media). Included by the root Makefile.
#
#   make content PROFILE=fast|full   build artwork + video, then upload to the dev blob store
#
# ffmpeg runs in Docker (image webflix-media-ffmpeg:<hash>, built on first use). Everything is
# cached under .cache/media; a second run with unchanged inputs is a fast no-op.

PROFILE ?= fast
# Upload target spec: fs: (dev store, WEBFLIX_BLOB_DIR or .data/blobs), fs:<dir>, or a scheme
# registered in tools/media/src/upload/targets.ts (s3: reads WEBFLIX_S3_*, like apps/api).
MEDIA_TARGET ?= fs:
MEDIA := node tools/media/src/cli.ts

.PHONY: content content-build content-upload content-validate content-sheets content-check content-review content-status content-credits content-clean

content: content-build content-upload ## Build and upload media: PROFILE=fast|full [MEDIA_TARGET=fs:]

content-build: ## Render artwork and package video for PROFILE into .cache/media/<profile>
	$(MEDIA) build --profile $(PROFILE)
	$(MEDIA) validate-manifest .cache/media/$(PROFILE)/manifest.json

content-upload: ## Upload PROFILE's media and manifest through the BlobStore port (MEDIA_TARGET)
	$(MEDIA) upload --profile $(PROFILE) --target $(MEDIA_TARGET)

content-validate: ## Validate PROFILE's manifest against the contract
	$(MEDIA) validate-manifest .cache/media/$(PROFILE)/manifest.json

content-sheets: ## Render artwork review sheets to .cache/media/review/<profile>/
	$(MEDIA) contact-sheets --profile $(PROFILE)

content-check: ## Fail if titles share key art, backdrops or posters, or a series repeats a still
	$(MEDIA) check-art --profile $(PROFILE)

content-review: ## Serve the media review page on http://localhost:4400
	$(MEDIA) review --profile $(PROFILE) --port 4400

content-status: ## Show what the media cache holds
	$(MEDIA) status

content-credits: ## Regenerate docs/CREDITS.md from the catalog, photo library and fonts
	$(MEDIA) credits

content-clean: ## Delete PROFILE's packaged output (keeps downloads and rendered art)
	$(MEDIA) clean --profile $(PROFILE)

doctor::
	@docker image ls --filter "reference=webflix-media-ffmpeg" --format "media image: {{.Repository}}:{{.Tag}} ({{.Size}})" | head -n 1
