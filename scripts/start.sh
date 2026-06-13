#!/bin/bash
# Auto-restart wrapper for Agent Control server.
# Restarts automatically if the process dies (e.g. after Tony kills it for a code change).
# Usage: ./start.sh

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT/backend"
source "$PROJECT_ROOT/.venv/bin/activate"

PIDFILE="$PROJECT_ROOT/.server.pid"
PY="$PROJECT_ROOT/.venv/bin/python3"

if [ ! -x "$PY" ]; then
    PY="/usr/bin/python3"
fi

while true; do
    echo "[AC] Starting server on port 8890..."
    uvicorn server:app --host 0.0.0.0 --port 8890 --ws-ping-interval 0 &
    echo $! > "$PIDFILE"
    wait $!
    EXIT_CODE=$?
    rm -f "$PIDFILE"
    if ! (cd "$PROJECT_ROOT/backend" && "$PY" -m restart_policy assert --source "start.sh" >/dev/null 2>&1); then
        echo "[AC] Restart blockiert durch Restart-Policy."
        exit "$EXIT_CODE"
    fi
    echo "[AC] Server exited with code $EXIT_CODE — restarting in 2s..."
    sleep 2
done
