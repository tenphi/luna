#!/usr/bin/env bash
set -euo pipefail
LUNA_BUILD_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LUNA_PROJECT_ROOT="$LUNA_BUILD_ROOT"
source "$LUNA_BUILD_ROOT/setup/lib/install-slug.sh"
LUNA_BUILD_IMAGE="$(container_image_base):${1:-latest}"
LUNA_BUILD_FONTS="${INSTALL_CJK_FONTS:-}"
if [[ -z "$LUNA_BUILD_FONTS" && -f "$LUNA_BUILD_ROOT/.env" ]]; then
  LUNA_BUILD_FONTS="$(awk -F= '$1=="INSTALL_CJK_FONTS" {value=$2} END {gsub(/["\047[:space:]]/, "", value); print value}' "$LUNA_BUILD_ROOT/.env")"
fi
LUNA_BUILD_ARGUMENTS=(--tag "$LUNA_BUILD_IMAGE" "$LUNA_BUILD_ROOT/container")
if [[ "$LUNA_BUILD_FONTS" == true ]]; then
  LUNA_BUILD_ARGUMENTS=(--build-arg INSTALL_CJK_FONTS=true "${LUNA_BUILD_ARGUMENTS[@]}")
fi
container build "${LUNA_BUILD_ARGUMENTS[@]}"
printf 'Built %s\n' "$LUNA_BUILD_IMAGE"
