#!/bin/bash
# Health-Watchdog für den Agent-Control-Server.
# Läuft alle 30s via launchd. Ruft einen DB-fassenden Endpoint mit Token.
# Nur HTTP 200 zählt als gesund — 401, 5xx, Timeout = unhealthy.
# Nach 3 Fehlschlägen in Folge: kickstart -k, damit launchd den Prozess neu startet.

set -u

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Geteilte Umgebung laden, falls vorhanden (Label/Port/venv/Root). Fuer
# des Nutzers Checkout bleibt alles exakt wie zuvor (com.klaus.agent, 8890).
if [ -f "$PROJECT_ROOT/scripts/lib/agent-control-env.sh" ]; then
  # shellcheck source=lib/agent-control-env.sh
  source "$PROJECT_ROOT/scripts/lib/agent-control-env.sh"
fi
PORT="${AC_PORT:-4222}"
URL="${WATCHDOG_URL:-http://localhost:$PORT/api/conversations}"
ENV_FILE="${AC_ROOT:-$PROJECT_ROOT}/.env"
PY="${AC_PY:-$PROJECT_ROOT/.venv/bin/python3}"
LABEL="${AC_LABEL:-com.klaus.agent}"
# State-File pro Label, damit mehrere Instanzen sich nicht ueberschreiben.
# des Nutzers bestehender Pfad bleibt exakt erhalten (kein Counter-Reset).
if [ "$LABEL" = "com.klaus.agent" ]; then
  STATE_FILE="/tmp/klaus-agent-watchdog-fails"
else
  STATE_FILE="/tmp/agent-watchdog-fails-$LABEL"
fi
MAX_FAILS=3

if [ ! -x "$PY" ]; then
  PY="/usr/bin/python3"
fi

TOKEN=""
if [ -f "$ENV_FILE" ]; then
  TOKEN=$(grep -E '^AGENT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
fi

AUTH=()
if [ -n "$TOKEN" ]; then
  AUTH=(-H "Authorization: Bearer $TOKEN")
fi

code=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "${AUTH[@]}" "$URL" 2>/dev/null || echo 000)

if [ "$code" = "200" ]; then
  echo 0 > "$STATE_FILE"
  exit 0
fi

fails=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fails=$((fails + 1))
echo "$fails" > "$STATE_FILE"

if [ "$fails" -ge "$MAX_FAILS" ]; then
  if ! policy_msg=$(cd "$PROJECT_ROOT/backend" && "$PY" -m restart_policy assert --source "health-watchdog.sh" 2>&1); then
    logger -t klaus-agent-watchdog "$policy_msg"
    echo 0 > "$STATE_FILE"
    exit 0
  fi
  logger -t klaus-agent-watchdog "Agent unhealthy (code=$code, $fails Fails), kickstart -k"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo 0 > "$STATE_FILE"
fi
