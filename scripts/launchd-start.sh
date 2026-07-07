#!/bin/bash
# Launchd-Wrapper fuer den Agent-Server.
# Workaround: Plist SoftResourceLimits wird vom System-Soft-Limit (256)
# eingeschnuert. Mit ulimit hier greift 8192 zuverlaessig fuer uvicorn
# und alle Kind-Prozesse.
set -e

ulimit -n 8192
echo "[launchd-start] $(date '+%Y-%m-%d %H:%M:%S') FD-Limit=$(ulimit -n) PID=$$"

# Pfade und Port aus der geteilten Umgebung ableiten, damit dieselbe Datei fuer
# jede Instanz funktioniert (des Nutzers Checkout in $HOME/agent ebenso wie ein
# Fresh-Install in einem anderen Ordner). AC_PORT (Default 4222) kann das
# launchd-EnvironmentVariables-Dict ueberschreiben.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/agent-control-env.sh
source "$HERE/lib/agent-control-env.sh"
PORT="${AC_PORT:-4222}"

cd "$AC_ROOT/backend"
exec "$AC_PY" -m uvicorn server:app \
  --host 0.0.0.0 \
  --port "$PORT" \
  --ws-ping-interval 0
