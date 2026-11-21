#!/usr/bin/env bash
# Change the kind release through Helm, for verify scripts and runbooks that need a different
# value for a while (an image, a replica count, a restart): never kubectl set/scale/edit on
# release objects, which would leave fields owned outside the release.
#
#   deploy/kind/release.sh reapply [--set key=value ...]   current values plus these
#   deploy/kind/release.sh rollback <revision>
#   deploy/kind/release.sh revision                        the deployed revision
set -euo pipefail
# shellcheck source=deploy/kind/lib.sh
. "$(dirname "$0")/lib.sh"

case "${1:-}" in
  reapply | rollback)
    action="$1"
    shift
    release_change "$action" "$@"
    deployed_revision
    ;;
  revision) deployed_revision ;;
  *) fail "usage: release.sh reapply [helm flags] | rollback <revision> | revision" ;;
esac
