#!/bin/bash
# Grant Speech Recognition to Luna.app, so voice messages transcribe on-device.
#
# The grant has to be attributed to the Luna app bundle, not to Terminal — the launchd host
# inherits it from the bundle identity. Double-click this file in Finder, or run:
#   open scripts/apple-grant-speech.command

set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP="$(ls -d data/mac-app/Luna-*.app 2>/dev/null | head -1)"
HELPER="$APP/Contents/MacOS/speech-helper"
if [[ ! -x "$HELPER" ]]; then
  echo "No bundled speech-helper found. Build and install the app wrapper first:"
  echo "  pnpm exec tsx scripts/apple-install-app-wrapper.ts"
  read -r -p "Press Enter to close…" _
  exit 1
fi

LANGS="$(node -e 'try{const c=require("./dist/config/loader.js");console.log((c.loadLunaConfig().voice?.languages??["en-US"]).join(","))}catch{console.log("en-US")}' 2>/dev/null || echo en-US)"

echo "Requesting Speech Recognition for: $LANGS"
echo "(macOS should prompt — allow it.)"
echo ""
"$HELPER" authorize --locales "$LANGS"
echo ""
echo "If that says \"authorized\", restart Luna:"
echo "  launchctl kickstart -k gui/\$(id -u)/\$(basename ~/Library/LaunchAgents/com.luna-*.plist .plist)"
read -r -p "Press Enter to close…" _
