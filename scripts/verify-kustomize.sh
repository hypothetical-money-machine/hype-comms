#!/bin/sh

set -eu

# Keep the version and digest together; update both from the release checksums file.
KUSTOMIZE_VERSION="v5.4.3"
KUSTOMIZE_SHA256="3669470b454d865c8184d6bce78df05e977c9aea31c30df3c669317d43bcc7a7"
KUSTOMIZE_URL="https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}/kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz"

# Test-only overrides are positional; ordinary invocations use the repository-pinned defaults.
KUSTOMIZE_URL="${1:-$KUSTOMIZE_URL}"
KUSTOMIZE_SHA256="${2:-$KUSTOMIZE_SHA256}"
KUSTOMIZE_INSTALL_DIR="${3:-/usr/local/bin}"

archive_directory=$(mktemp -d)
archive_path="${archive_directory}/kustomize.tar.gz"
trap 'rm -rf "$archive_directory"' EXIT

curl -fsSL --retry 3 "$KUSTOMIZE_URL" -o "$archive_path"
archive_checksum=$(sha256sum "$archive_path")
archive_checksum=${archive_checksum%% *}
if [ "$archive_checksum" != "$KUSTOMIZE_SHA256" ]; then
  echo "kustomize checksum mismatch: expected $KUSTOMIZE_SHA256, received $archive_checksum" >&2
  exit 1
fi

mkdir -p "$KUSTOMIZE_INSTALL_DIR"
tar -xzf "$archive_path" -C "$KUSTOMIZE_INSTALL_DIR" kustomize
chmod 0755 "$KUSTOMIZE_INSTALL_DIR/kustomize"
