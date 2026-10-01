#!/usr/bin/env bash
# One-shot setup for a fresh machine or sandbox: Godot + templates, Node deps, start the server.
#   scripts/bootstrap.sh [--web-editor] [--no-start] [--project <git-url> [--id <id>]]...
# Idempotent: safe to run again in an existing environment (it reuses what's installed).
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd)"
export GCK_HOME="${GCK_HOME:-$HOME/.gck}"
export GODOT_BIN="${GODOT_BIN:-$HOME/.local/bin/godot}"
PORT="${GCK_PORT:-8790}"
START=1
INSTALL_ARGS=()
PROJECTS=()
IDS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --web-editor) INSTALL_ARGS+=(--web-editor) ;;
    --threads) INSTALL_ARGS+=(--threads) ;;
    --no-start) START=0 ;;
    --project) PROJECTS+=("$2"); IDS+=(""); shift ;;
    --id) IDS[$((${#IDS[@]} - 1))]="$2"; shift ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift
done

t0=$(date +%s)
"$KIT/scripts/install-godot.sh" "${INSTALL_ARGS[@]}"

echo "→ node dependencies"
command -v node >/dev/null || { echo "Node.js 20+ is required"; exit 1; }
(cd "$KIT" && npm install --omit=dev --no-audit --no-fund --silent)
mkdir -p "$HOME/.local/bin" && ln -sf "$KIT/cli/gck.js" "$HOME/.local/bin/gck"

if [ "$START" = 1 ]; then
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "✓ server already running on :$PORT"
  else
    echo "→ starting server on :$PORT (log: $GCK_HOME/server.log)"
    mkdir -p "$GCK_HOME"
    (cd "$KIT" && setsid nohup node server/index.js >"$GCK_HOME/server.log" 2>&1 </dev/null &)
    for _ in $(seq 1 40); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "server failed to start:"; tail -20 "$GCK_HOME/server.log"; exit 1; }
    echo "✓ server up"
  fi
fi

# Clone and adopt game repos so the agent can keep working on them.
for i in "${!PROJECTS[@]}"; do
  url="${PROJECTS[$i]}"
  id="${IDS[$i]:-$(basename "$url" .git | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-\n' '-')}"
  dir="$GCK_HOME/repos/$id"
  if [ ! -d "$dir/.git" ]; then git clone -q "$url" "$dir"; else git -C "$dir" pull -q --ff-only || true; fi
  # Projects may keep project.godot in a subfolder.
  pg="$(cd "$dir" && find . -maxdepth 3 -name project.godot -not -path './.godot/*' | head -1)"
  [ -n "$pg" ] || { echo "no project.godot in $url"; continue; }
  GCK_URL="http://127.0.0.1:$PORT" node "$KIT/cli/gck.js" adopt "$id" "$dir/$(dirname "$pg")" >/dev/null
  echo "✓ adopted $id from $url"
done

echo "✓ ready in $(( $(date +%s) - t0 ))s — gck list | open http://<host>:$PORT/"
