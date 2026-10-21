#!/bin/zsh
# Builds Ballast.app for macOS from this repository.
#
#   ./app/macos/build.sh               build into build/, install into /Applications and open it
#   ./app/macos/build.sh --no-install  build only
#
# The app runs the server and pages live from this repository, so edits show up without rebuilding.
# Rebuild after changing anything in app/macos.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
APP="$ROOT/build/Ballast.app"
RES="$APP/Contents/Resources"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES"
cp Info.plist "$APP/Contents/"
/usr/libexec/PlistBuddy -c "Add :BallastSourceFolder string $ROOT" "$APP/Contents/Info.plist"

# App icon, made from the 1024px PNG
ICONSET="$ROOT/build/AppIcon.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ROOT/assets/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns -o "$RES/AppIcon.icns" "$ICONSET"
rm -rf "$ICONSET"

# A universal binary for Apple Silicon and Intel Macs
swiftc -O -target arm64-apple-macos13.0  -o "$APP/Contents/MacOS/Ballast-arm64"  Sources/main.swift
swiftc -O -target x86_64-apple-macos13.0 -o "$APP/Contents/MacOS/Ballast-x86_64" Sources/main.swift
lipo -create -output "$APP/Contents/MacOS/Ballast" "$APP/Contents/MacOS/Ballast-arm64" "$APP/Contents/MacOS/Ballast-x86_64"
rm "$APP/Contents/MacOS/Ballast-arm64" "$APP/Contents/MacOS/Ballast-x86_64"
codesign --force --deep --sign - "$APP"
echo "Built $APP (runs live from $ROOT)"

if [[ "${1:-}" != "--no-install" ]]; then
  pkill -x Ballast 2>/dev/null || true
  sleep 1
  pkill -f "$ROOT/server.js" 2>/dev/null || true
  rm -rf /Applications/Ballast.app
  cp -R "$APP" /Applications/
  echo "Installed /Applications/Ballast.app"
  open /Applications/Ballast.app
fi
