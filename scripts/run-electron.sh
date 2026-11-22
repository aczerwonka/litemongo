#!/usr/bin/env bash
# Uruchamia LiteMongo jako aplikację desktopową (Electron).
#
#   ./scripts/run-electron.sh            # build client + server, bundle i okno Electron (npm run desktop:dev)
#   ./scripts/run-electron.sh --install  # wymusza ponowną instalację zależności przed startem
#
# Serwer Fastify działa wewnątrz aplikacji na 127.0.0.1:${LITEMONGO_DESKTOP_PORT:-38017}.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FORCE_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) FORCE_INSTALL=1 ;;
    -h|--help)
      sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf '\033[1;31m[electron] błąd:\033[0m nieznana opcja %s\n' "$arg" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;35m[electron]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[electron] błąd:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "nie znaleziono 'node' (wymagany Node.js 22+)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "wykryto Node.js $(node -v), wymagany jest 22+"

# Zależności monorepo (server, client)
if [ "$FORCE_INSTALL" -eq 1 ] || [ ! -d node_modules ]; then
  log "instaluję zależności monorepo (npm install)…"
  npm install
fi

# Zależności Electrona (osobny pakiet w desktop/)
if [ "$FORCE_INSTALL" -eq 1 ] || [ ! -d desktop/node_modules ]; then
  log "instaluję zależności Electrona (npm install --prefix desktop)…"
  npm install --prefix desktop
fi

log "build + start okna Electron (npm run desktop:dev)…"
exec npm run desktop:dev
