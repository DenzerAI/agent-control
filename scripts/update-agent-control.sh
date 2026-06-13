#!/usr/bin/env bash
# Agent Control Update-Knopf.
# Zieht den neuesten Produktkern von GitHub und baut Abhaengigkeiten neu.
# Kundendaten (chat.db, .env, data/, logs/) sind aus Git ausgeschlossen und
# werden NIE angefasst. Ein Update erneuert nur den Code, nicht den Inhalt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Agent Control Update in $ROOT"

if [[ ! -d ".git" ]]; then
  echo "FEHLER: Das hier ist kein git-Verzeichnis. Update braucht den GitHub-Klon." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> Branch: $BRANCH"

# Lokale Aenderungen an getrackten Dateien wuerden den Pull blockieren.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ACHTUNG: Es gibt lokale Aenderungen an versionierten Dateien." >&2
  echo "Kundendaten sind nicht betroffen (die liegen ausserhalb von Git)." >&2
  echo "Bitte die Aenderungen sichern oder verwerfen, dann erneut starten:" >&2
  echo "  git stash   # zum Wegpacken" >&2
  exit 1
fi

echo "==> Hole neuesten Stand von GitHub"
git fetch --prune origin
git pull --ff-only origin "$BRANCH"

echo "==> Python-Abhaengigkeiten"
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
fi
".venv/bin/python" -m pip install --upgrade pip >/dev/null
".venv/bin/python" -m pip install -r requirements.txt

if [[ -f "frontend/package.json" ]]; then
  echo "==> Frontend neu bauen"
  (cd frontend && npm install && npm run build)
fi

echo "==> Selbstcheck mit Reparatur"
if [[ -f "scripts/doctor.sh" ]]; then
  bash scripts/doctor.sh || true
else
  ".venv/bin/python" scripts/agent-control-setup.py --doctor --yes || true
fi

echo
echo "Update fertig. Server neu starten mit:"
echo "  agent-control restart   (oder: bash scripts/restart-server.sh)"
