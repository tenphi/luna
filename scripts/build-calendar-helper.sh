#!/usr/bin/env bash
#
# Build the vendored EventKit helper (universal arm64 + x86_64) from Swift
# source. Commit the resulting binary so installs need no Swift toolchain;
# re-run this whenever native/CalendarHelper.swift changes.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="$HERE/src/host-mcp/builtins/apple/native"
SRC="$NATIVE_DIR/CalendarHelper.swift"
OUT="$NATIVE_DIR/calendar-helper"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "calendar-helper build requires macOS (needs EventKit + swiftc)" >&2
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

swiftc -O -file-prefix-map "$HERE=." -debug-prefix-map "$HERE=." -target arm64-apple-macosx13.0 -o "$TMP/calendar-helper-arm64" "$SRC" \
  -framework EventKit -framework Foundation
swiftc -O -file-prefix-map "$HERE=." -debug-prefix-map "$HERE=." -target x86_64-apple-macosx13.0 -o "$TMP/calendar-helper-x86_64" "$SRC" \
  -framework EventKit -framework Foundation
lipo -create "$TMP/calendar-helper-arm64" "$TMP/calendar-helper-x86_64" -output "$OUT"
chmod 755 "$OUT"

lipo -info "$OUT"
echo "Built $OUT"
