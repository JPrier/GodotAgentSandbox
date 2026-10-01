#!/usr/bin/env bash
# Install a headless-capable Godot editor binary + the web export templates (+ optionally the web editor).
#   scripts/install-godot.sh [VERSION] [--web-editor] [--threads]
# Env: GODOT_VERSION (default below), GODOT_INSTALL_DIR (default ~/.local/godot), GODOT_BIN_LINK (default ~/.local/bin/godot)
set -euo pipefail

VERSION="${GODOT_VERSION:-4.7.2}"
WEB_EDITOR=0
THREADS=0
for a in "$@"; do
  case "$a" in
    --web-editor) WEB_EDITOR=1 ;;
    --threads) THREADS=1 ;;
    -h|--help) sed -n 2,4p "$0"; exit 0 ;;
    *) VERSION="$a" ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${GODOT_INSTALL_DIR:-$HOME/.local/godot}"
LINK="${GODOT_BIN_LINK:-$HOME/.local/bin/godot}"
TPL_DIR="${GODOT_TEMPLATES_DIR:-$HOME/.local/share/godot/export_templates}/${VERSION}.stable"
GCK_HOME="${GCK_HOME:-$HOME/.gck}"
REL="https://github.com/godotengine/godot/releases/download/${VERSION}-stable"

case "$(uname -m)" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR" "$(dirname "$LINK")" "$TPL_DIR"
BIN="$INSTALL_DIR/Godot_v${VERSION}-stable_linux.${ARCH}"

if [ ! -x "$BIN" ]; then
  echo "→ downloading Godot ${VERSION} (${ARCH})"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/godot.zip" "$REL/Godot_v${VERSION}-stable_linux.${ARCH}.zip"
  unzip -oq "$tmp/godot.zip" -d "$INSTALL_DIR"
  rm -rf "$tmp"
  chmod +x "$BIN"
fi
ln -sf "$BIN" "$LINK"
echo "✓ godot: $("$LINK" --version 2>/dev/null | tail -1)"

PATTERNS=("templates/version.txt" "templates/web_nothreads_debug.zip" "templates/web_nothreads_release.zip")
[ "$THREADS" = 1 ] && PATTERNS+=("templates/web_debug.zip" "templates/web_release.zip")
if [ ! -f "$TPL_DIR/web_nothreads_debug.zip" ] || { [ "$THREADS" = 1 ] && [ ! -f "$TPL_DIR/web_debug.zip" ]; }; then
  echo "→ fetching web export templates (only the web parts of the archive)"
  python3 "$HERE/fetch-zip-members.py" "$REL/Godot_v${VERSION}-stable_export_templates.tpz" "$TPL_DIR" "${PATTERNS[@]}"
fi
echo "✓ templates: $TPL_DIR"

if [ "$WEB_EDITOR" = 1 ]; then
  ED="$GCK_HOME/editor"
  if [ ! -f "$ED/index.html" ]; then
    echo "→ downloading the Godot web editor"
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/editor.zip" "$REL/Godot_v${VERSION}-stable_web_editor.zip"
    mkdir -p "$ED"
    unzip -oq "$tmp/editor.zip" -d "$ED"
    rm -rf "$tmp"
    # The archive names the page godot.editor.html; serve it as the index.
    [ -f "$ED/godot.editor.html" ] && cp "$ED/godot.editor.html" "$ED/index.html"
  fi
  echo "✓ web editor: $ED (served at /editor/)"
fi

case ":$PATH:" in *":$(dirname "$LINK"):"*) ;; *) echo "note: add $(dirname "$LINK") to PATH, or set GODOT_BIN=$LINK" ;; esac
