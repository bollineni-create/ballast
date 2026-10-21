#!/bin/zsh
# Downloads (or updates) Ballast into ~/ballast, builds the Mac app, installs it into /Applications and opens it.
#
#   curl -fsSL https://raw.githubusercontent.com/bollineni-create/ballast/main/app/macos/install.sh | zsh
#
# Optional: put ALPACA_API_KEY_ID=... ALPACA_API_SECRET_KEY=... ANTHROPIC_API_KEY=... before `zsh` to save
# those keys on a first install. They're kept only in ~/ballast/.env on this Mac, which git never uploads.
# To change keys later, use Ballast → Edit Keys… in the app.
set -euo pipefail
DIR="${BALLAST_DIR:-$HOME/ballast}"

if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  echo "Install Apple's command-line tools in the window that just opened, then run this command again."
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Ballast needs Node.js. Install the LTS version from https://nodejs.org, then run this command again."
  open "https://nodejs.org/en/download" 2>/dev/null || true
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=12)?0:1)'; then
  echo "Ballast needs Node.js 20.12 or newer (you have $(node -v)). Install the LTS version from https://nodejs.org, then run this command again."
  exit 1
fi

if [[ -d "$DIR/.git" ]]; then
  git -C "$DIR" fetch --quiet origin main
  git -C "$DIR" checkout --quiet main
  git -C "$DIR" merge --ff-only --quiet origin/main
else
  git clone --quiet --branch main https://github.com/bollineni-create/ballast.git "$DIR"
fi
(cd "$DIR" && npm install --no-audit --no-fund --silent)

# Keys, asked once. Alpaca paper keys give live stock prices and the paper autopilot; without them
# stock prices come from Yahoo Finance. The Anthropic key turns on the Claude strategy builder.
ENVF="$DIR/.env"
alpaca_id="${ALPACA_API_KEY_ID:-}" alpaca_secret="${ALPACA_API_SECRET_KEY:-}" anthropic="${ANTHROPIC_API_KEY:-}"
if [[ ! -f "$ENVF" && -z "$alpaca_id$anthropic" ]] && { : </dev/tty; } 2>/dev/null; then
  echo
  echo "Optional keys (press Enter to skip any; you can add them later from Ballast → Edit Keys…)."
  echo "Use an Alpaca PAPER account that no other test or app is already trading in."
  read "alpaca_id?Alpaca paper API key ID: " </dev/tty || true
  if [[ -n "$alpaca_id" ]]; then read -s "alpaca_secret?Alpaca paper secret key: " </dev/tty || true; echo; fi
  read -s "anthropic?Anthropic API key (for the Claude strategy builder): " </dev/tty || true; echo
fi
if [[ ! -f "$ENVF" ]]; then
  umask 077
  {
    echo "# Ballast keys. This file stays on this Mac (git ignores it)."
    echo "ALPACA_API_KEY_ID=$alpaca_id"
    echo "ALPACA_API_SECRET_KEY=$alpaca_secret"
    echo "ANTHROPIC_API_KEY=$anthropic"
  } > "$ENVF"
  chmod 600 "$ENVF"
fi

"$DIR/app/macos/build.sh"
