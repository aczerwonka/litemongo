#!/usr/bin/env bash
# Uruchamia LiteMongo w przeglądarce.
#
#   ./scripts/run-browser.sh          # tryb dev: API :3001 + Vite :5173 (http://localhost:5173)
#   ./scripts/run-browser.sh prod     # build + serwer z gotowym frontendem (http://localhost:3001)
#
# Zmienne środowiskowe (opcjonalnie): PORT, HOST, FORCE_READ_ONLY — przekazywane do serwera w trybie prod.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="${1:-dev}"

log() { printf '\033[1;34m[browser]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[browser] błąd:\033[0m %s\n' "$*" >&2; exit 1; }

# Wymagany Node.js >= 22
command -v node >/dev/null 2>&1 || die "nie znaleziono 'node' (wymagany Node.js 22+)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "wykryto Node.js $(node -v), wymagany jest 22+"

# Zależności monorepo (workspaces: server, client)
if [ ! -d node_modules ]; then
  log "instaluję zależności (npm install)…"
  npm install
fi

case "$MODE" in
  dev)
    log "tryb dev → frontend: http://localhost:5173  (API: 3001)"
    exec npm run dev
    ;;
  prod)
    log "buduję client i server (npm run build)…"
    npm run build
    log "uruchamiam serwer → http://localhost:${PORT:-3001}"
    exec npm start
    ;;
  -h|--help|help)
    sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\}//'
    ;;
  *)
    die "nieznany tryb '$MODE' (użyj: dev | prod)"
    ;;
esac
