#!/usr/bin/env bash
#
# Build the mail attachment text extractor (universal arm64 + x86_64) from Swift
# source. Commit the resulting binary so installs need no Swift toolchain;
# re-run this whenever native/MailExtract.swift changes.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_DIR="$HERE/src/host-mcp/builtins/email/shared/attach/native"
SRC="$NATIVE_DIR/MailExtract.swift"
OUT="$NATIVE_DIR/mail-extract"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "mail-extract build requires macOS (needs PDFKit + Vision + swiftc)" >&2
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FRAMEWORKS=(-framework PDFKit -framework Vision -framework CoreGraphics -framework ImageIO -framework Foundation)

swiftc -O -file-prefix-map "$HERE=." -debug-prefix-map "$HERE=." -target arm64-apple-macosx13.0 -o "$TMP/mail-extract-arm64" "$SRC" "${FRAMEWORKS[@]}"
swiftc -O -file-prefix-map "$HERE=." -debug-prefix-map "$HERE=." -target x86_64-apple-macosx13.0 -o "$TMP/mail-extract-x86_64" "$SRC" "${FRAMEWORKS[@]}"
lipo -create "$TMP/mail-extract-arm64" "$TMP/mail-extract-x86_64" -output "$OUT"
chmod +x "$OUT"

echo "built $OUT"
lipo -info "$OUT"
