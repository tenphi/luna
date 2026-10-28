#!/usr/bin/env bash
#
# Build the vendored Speech helper (universal arm64 + x86_64) from Swift source.
# Commit the resulting binary so installs need no Swift toolchain; re-run this
# whenever native/SpeechHelper.swift changes.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="$HERE/src/voice/native"
SRC="$NATIVE_DIR/SpeechHelper.swift"
OUT="$NATIVE_DIR/speech-helper"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "speech-helper build requires macOS (needs Speech + swiftc)" >&2
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

swiftc -O -file-prefix-map "$HERE=." -debug-prefix-map "$HERE=." -target arm64-apple-macosx13.0 -o "$TMP/speech-helper-arm64" "$SRC" \
  -framework Speech -framework AVFoundation -framework Foundation
swiftc -O -file-prefix-map "$HERE=." -debug-prefix-map "$HERE=." -target x86_64-apple-macosx13.0 -o "$TMP/speech-helper-x86_64" "$SRC" \
  -framework Speech -framework AVFoundation -framework Foundation
lipo -create "$TMP/speech-helper-arm64" "$TMP/speech-helper-x86_64" -output "$OUT"
chmod 755 "$OUT"

lipo -info "$OUT"
echo "Built $OUT"
