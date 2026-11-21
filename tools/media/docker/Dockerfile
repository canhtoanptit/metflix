# ffmpeg for the Webflix media pipeline. ffmpeg is never installed on the host (blueprint §7):
# `webflix-media` builds this image on first use and tags it `webflix-media-ffmpeg:<hash of this
# file>`, so editing it rebuilds the image and invalidates packaged video automatically.
#
# Alpine 3.23 ships ffmpeg 8.0 with libx264, the native AAC encoder, libwebp and freetype
# (drawtext, for the synthetic fallback stream). Pinned by digest for reproducible output.
FROM alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2

RUN apk add --no-cache "ffmpeg~=8.0" font-dejavu \
  && ffmpeg -hide_banner -version | head -n 1

# Runs as the invoking host user (`docker run --user`), so outputs on the bind mount stay ours.
WORKDIR /media
ENTRYPOINT []
