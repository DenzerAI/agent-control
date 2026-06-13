#!/bin/bash
# Agent Control Server Restart mit Readiness-Check und Session-Koordination.
# Default: blockiert, wenn gerade Claude-Streams laufen. Mit --force trotzdem durch.
# kickstart -k triggert launchd-Restart, dann pollen bis /api/system-status antwortet.
# Bei Timeout: Log-Tail ausgeben und exit 1.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Geteilte Umgebung (Label/Port/venv-Python) laden, falls vorhanden. Setzt
# AC_LABEL/AC_PORT/AC_PY/AC_ROOT. Faellt fuer Christians Checkout auf exakt
# com.klaus.agent / 8890 zurueck (Abwaertskompatibilitaet bleibt erhalten).
if [ -f "$PROJECT_ROOT/scripts/lib/agent-control-env.sh" ]; then
  # shellcheck source=lib/agent-control-env.sh
  source "$PROJECT_ROOT/scripts/lib/agent-control-env.sh"
fi
LABEL="${AC_LABEL:-com.klaus.agent}"
PORT="${AC_PORT:-8890}"
BASE_URL="http://localhost:$PORT"
STATUS_URL="$BASE_URL/api/system-status"
STREAMS_URL="$BASE_URL/api/active-streams"
ERR_LOG="${AC_ROOT:-$PROJECT_ROOT}/logs/server.err.log"
ENV_FILE="${AC_ROOT:-$PROJECT_ROOT}/.env"
PY="${AC_PY:-$PROJECT_ROOT/.venv/bin/python3}"
MAX_WAIT=30
FORCE=0

if [ ! -x "$PY" ]; then
  PY="/usr/bin/python3"
fi

assert_restart_allowed() {
  (
    cd "$PROJECT_ROOT/backend"
    "$PY" -m restart_policy assert --source "restart-server.sh"
  )
}

# Token aus .env laden (optional — Server läuft auch ohne Token)
AUTH_HEADER=()
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(grep -E '^AGENT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -n "${TOKEN:-}" ]; then
    AUTH_HEADER=(-H "Authorization: Bearer $TOKEN")
  fi
fi

for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    --help|-h)
      echo "Usage: $0 [--force]"
      echo "  Default: blockiert bei aktiven Streams."
      echo "  --force: restart trotz aktiver Streams (kappt ihre Antwort)."
      exit 0
      ;;
  esac
done

if ! POLICY_MSG=$(assert_restart_allowed 2>&1); then
  echo "$POLICY_MSG"
  exit 3
fi

# Pre-Check: aktive Streams
STREAMS_JSON=$(curl -s --max-time 2 "${AUTH_HEADER[@]}" "$STREAMS_URL" 2>/dev/null || echo "")
if [ -n "$STREAMS_JSON" ]; then
  COUNT=$(echo "$STREAMS_JSON" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('count',0))" 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ] && [ "$FORCE" -ne 1 ]; then
    echo "blocked: $COUNT aktive(r) Stream(s) — Restart würde sie abbrechen."
    echo "$STREAMS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for cid in d.get('convIds', []):
    print(f'  - convId: {cid}')
" 2>/dev/null
    echo ""
    echo "Wenn das nur dein eigener Stream ist: $0 --force"
    echo "Wenn andere dran sind: erst abwarten oder Christian fragen."
    exit 2
  fi
fi

launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null

START=$(date +%s)
while true; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${AUTH_HEADER[@]}" "$STATUS_URL" || echo "000")
  if [ "$CODE" = "200" ]; then
    ELAPSED=$(( $(date +%s) - START ))
    echo "ok: server up after ${ELAPSED}s"
    exit 0
  fi
  ELAPSED=$(( $(date +%s) - START ))
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "fail: server did not respond within ${MAX_WAIT}s (last http=${CODE})"
    echo "--- last stderr ---"
    tail -n 30 "$ERR_LOG" 2>/dev/null || echo "(no err log)"
    exit 1
  fi
  sleep 1
done
