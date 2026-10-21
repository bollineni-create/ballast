#!/bin/zsh
# Builds Ballast.app for macOS from this repository.
#
#   ./app/macos/build.sh               build into build/, install into /Applications and open it
#   ./app/macos/build.sh --no-install  build only
#   ./app/macos/build.sh --package     build a self-contained app and build/Ballast.dmg (what CI publishes)
#
# Built normally, the app runs the server and pages live from this repository, so edits show up without
# rebuilding; rebuild after changing anything in app/macos. Packaged, it carries its own copy of the code
# and of Node.js, so it needs nothing else installed.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
APP="$ROOT/build/Ballast.app"
RES="$APP/Contents/Resources"
MODE="${1:-install}"
NODE_VERSION="${NODE_VERSION:-22.22.0}"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES"
cp Info.plist "$APP/Contents/"

# App icon, made from the 1024px PNG
ICONSET="$ROOT/build/AppIcon.iconset"
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$ROOT/assets/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns -o "$RES/AppIcon.icns" "$ICONSET"
rm -rf "$ICONSET"

if [[ "$MODE" == "--package" ]]; then
  # The app's code with its production dependencies
  mkdir -p "$RES/app"
  cp -R "$ROOT/public" "$RES/app/"
  cp "$ROOT"/*.js "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/.env.example" "$RES/app/"
  (cd "$RES/app" && npm ci --omit=dev --no-audit --no-fund --silent)

  # Node.js for Apple Silicon and Intel, checked against nodejs.org's published checksums
  TMP="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  for arch in arm64 x64; do
    f="node-v$NODE_VERSION-darwin-$arch.tar.gz"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$f" -o "$TMP/$f"
    (cd "$TMP" && grep " $f\$" SHASUMS256.txt | shasum -a 256 -c -)
    tar -xzf "$TMP/$f" -C "$TMP"
  done
  lipo -create -output "$RES/node" "$TMP/node-v$NODE_VERSION-darwin-arm64/bin/node" "$TMP/node-v$NODE_VERSION-darwin-x64/bin/node"
  rm -rf "$TMP"
  codesign --force --sign - "$RES/node"
  # The commit this build came from, so the app can tell when a newer build exists
  /usr/libexec/PlistBuddy -c "Add :BallastBuildSHA string $(git -C "$ROOT" rev-parse HEAD)" "$APP/Contents/Info.plist"
else
  /usr/libexec/PlistBuddy -c "Add :BallastSourceFolder string $ROOT" "$APP/Contents/Info.plist"
fi

# A universal binary for Apple Silicon and Intel Macs
swiftc -O -target arm64-apple-macos13.0  -o "$APP/Contents/MacOS/Ballast-arm64"  Sources/main.swift
swiftc -O -target x86_64-apple-macos13.0 -o "$APP/Contents/MacOS/Ballast-x86_64" Sources/main.swift
lipo -create -output "$APP/Contents/MacOS/Ballast" "$APP/Contents/MacOS/Ballast-arm64" "$APP/Contents/MacOS/Ballast-x86_64"
rm "$APP/Contents/MacOS/Ballast-arm64" "$APP/Contents/MacOS/Ballast-x86_64"
codesign --force --deep --sign - "$APP"
echo "Built $APP"

if [[ "$MODE" == "--package" ]]; then
  STAGE="$ROOT/build/dmg"
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname Ballast -srcfolder "$STAGE" -ov -format UDZO "$ROOT/build/Ballast.dmg"
  rm -rf "$STAGE"
  echo "Built $ROOT/build/Ballast.dmg"
elif [[ "$MODE" != "--no-install" ]]; then
  pkill -x Ballast 2>/dev/null || true
  sleep 1
  pkill -f "$ROOT/server.js" 2>/dev/null || true
  rm -rf /Applications/Ballast.app
  cp -R "$APP" /Applications/
  echo "Installed /Applications/Ballast.app"
  open /Applications/Ballast.app
fi
