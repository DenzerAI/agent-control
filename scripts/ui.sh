#!/usr/bin/env bash
# Layout-Steuerung aus dem Text-Chat heraus. Pusht UI-Kommandos an alle
# verbundenen Frontends via /api/ui-command. Auth über AGENT_TOKEN aus .env.
#
# Aufrufe:
#   ui.sh info open|close|toggle
#   ui.sh section <workspace|systemagent|calendar|jobs|whatsapp|mail|artifacts|social|daily-log|settings>
#   ui.sh pane add
#   ui.sh pane close [N]            # ohne N: äußerste rechts
#   ui.sh pane only-active

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
[ -f "$ENV_FILE" ] || { echo "no .env" >&2; exit 1; }
TOKEN="$(grep -E '^AGENT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
[ -n "$TOKEN" ] || { echo "no AGENT_TOKEN in .env" >&2; exit 1; }

URL="http://localhost:8890/api/ui-command"
post() {
  curl -sS -X POST "$URL" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  info)
    action="${1:-toggle}"
    post "{\"command\":\"info\",\"payload\":{\"action\":\"$action\"}}"
    ;;
  section)
    section="${1:-}"; [ -n "$section" ] || { echo "section required" >&2; exit 1; }
    post "{\"command\":\"info-section\",\"payload\":{\"section\":\"$section\"}}"
    ;;
  pane)
    sub="${1:-}"; [ -n "$sub" ] || { echo "pane action required" >&2; exit 1; }
    case "$sub" in
      add)         post '{"command":"pane","payload":{"action":"add"}}' ;;
      only-active) post '{"command":"pane","payload":{"action":"only-active"}}' ;;
      close)
        idx="${2:-}"
        if [ -n "$idx" ]; then
          post "{\"command\":\"pane\",\"payload\":{\"action\":\"close-index\",\"index\":$idx}}"
        else
          post '{"command":"pane","payload":{"action":"close-last"}}'
        fi
        ;;
      *) echo "unknown pane subcommand: $sub" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "usage: ui.sh info open|close|toggle" >&2
    echo "       ui.sh section <name>" >&2
    echo "       ui.sh pane add|close [N]|only-active" >&2
    exit 1
    ;;
esac
echo
