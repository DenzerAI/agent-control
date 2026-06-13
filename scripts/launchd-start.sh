#!/bin/bash
# Launchd-Wrapper fuer den Agent-Server.
# Workaround: Plist SoftResourceLimits wird vom System-Soft-Limit (256)
# eingeschnuert. Mit ulimit hier greift 8192 zuverlaessig fuer uvicorn
# und alle Kind-Prozesse.
set -e

ulimit -n 8192
echo "[launchd-start] $(date '+%Y-%m-%d %H:%M:%S') FD-Limit=$(ulimit -n) PID=$$"

cd /Users/klaus/agent/backend
exec /Users/klaus/agent/.venv/bin/uvicorn server:app \
  --host 0.0.0.0 \
  --port 8890 \
  --ws-ping-interval 0
